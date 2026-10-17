import { z } from "zod";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { readStorageFile } from "@/lib/storage/asset-manager";
import { getProviderAdapter } from "@/lib/services/provider-service";
import { assertProjectIdle } from "./service";
import { invokeStructured } from "./structured-model";
import { categoryProfiles, categorySchema } from "./merchandising";
import { isStyleReference } from "@/lib/utils/asset-purpose";
import { BriefPreparationError } from "./brief-recovery";
import { requestErrorMessage } from "@/lib/utils/request-error";

export const briefSchema = z.object({ name: z.string().min(2).max(80), description: z.string().max(2000), visualDirection: z.string().max(1200), uncertainties: z.array(z.string().max(300)).max(5) });
const observationsSchema = z.object({ name: z.string().min(2).max(80), description: z.string().max(2000), category: categorySchema, uncertainties: z.array(z.string().max(300)).max(5) });
const reviewSchema = observationsSchema.extend({ corrections: z.array(z.string().max(300)).max(8) });
const storedSchema = briefSchema.extend({ version: z.literal(2).optional(), category: categorySchema.optional(), recommendedVisualDirection: z.string().optional(), recognition: z.object({ modelId: z.string(), imageCount: z.number().int(), detail: z.literal("high"), analyzedAt: z.string(), reviewed: z.boolean().optional(), detailViewCount: z.number().int().optional(), corrections: z.array(z.string()).optional() }).optional() });
const jobs = (globalThis as typeof globalThis & { v4BriefJobs?: Map<string, Promise<z.infer<typeof storedSchema>>> }).v4BriefJobs ??= new Map();
const normalizedModelId = (value: string) => value.toLowerCase().replace(/[^a-z0-9.]/g, "");
type BriefOptions = { force?: boolean; resume?: boolean; initialOnly?: boolean; retryUncertain?: boolean };
type BriefRequest = { sourceHash: string; requestId: string; stage: "识别" | "复核"; state: "running" | "completed" | "uncertain"; startedAt: number };
const draftSchema = z.object({ sourceHash: z.string(), modelId: z.string(), observations: observationsSchema, analyzedAt: z.string() });
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function saveBriefSnapshot(projectId: string, patch: Record<string, unknown>, owner?: BriefRequest) {
  await prisma.$transaction(async tx => {
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
    const snapshot = (project.modelSnapshot || {}) as Record<string, any>;
    if (owner && snapshot.creationBriefRequest?.requestId !== owner.requestId) throw new BriefPreparationError("BRIEF_CONFLICT", 409, "商品分析已由其他请求接管，请刷新查看进度。");
    const written = await tx.project.updateMany({ where: { id: projectId, updatedAt: project.updatedAt }, data: { modelSnapshot: json({ ...snapshot, ...patch }), updatedAt: new Date(Math.max(Date.now(), project.updatedAt.getTime() + 1)) } });
    if (!written.count) throw new BriefPreparationError("BRIEF_CONFLICT", 409, "商品资料已更新，请刷新后继续。");
  });
}

async function assetImages(projectId: string, assets: Array<{ id: string; filePath: string }>) {
  return Promise.all(assets.slice(0, 8).map(async asset => `data:image/png;base64,${(await sharp(await readStorageFile(asset.filePath)).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).png().toBuffer()).toString("base64")}`));
}

export async function prepareBrief(projectId: string, options: BriefOptions = {}): Promise<z.infer<typeof storedSchema>> {
  const existing = jobs.get(projectId);
  if (existing) {
    const result = await existing;
    if (options.initialOnly || result.recognition?.reviewed) return result;
    return prepareBrief(projectId, { ...options, force: false });
  }
  const job = analyze(projectId, options); jobs.set(projectId, job);
  try { return await job; } finally { jobs.delete(projectId); }
}

async function analyze(projectId: string, { force = false, initialOnly = false, retryUncertain = false }: BriefOptions) {
  await assertProjectIdle(projectId);
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { assets: { where: { type: { in: ["MAIN", "ANGLE", "DETAIL", "REFERENCE"] } }, orderBy: [{ isMain: "desc" }, { sortOrder: "asc" }] } } });
  const assets = project.assets.filter(asset => !isStyleReference(asset));
  const snapshot = (project.modelSnapshot || {}) as Record<string, any>;
  const sourceHash = createHash("sha256").update(JSON.stringify({ description: project.description, assets: assets.map(asset => [asset.id, asset.filePath]) })).digest("hex");
  const cached = storedSchema.safeParse(snapshot.creationBrief);
  const cachedHash = snapshot.creationBriefSourceHash || snapshot.creationBriefDraft?.sourceHash;
  if (!force && cachedHash === sourceHash && cached.success && (initialOnly || cached.data.recognition?.reviewed)) return cached.data;
  if (!assets.length) throw new Error("请先上传商品图片。");
  const { provider, apiKey } = await getProviderAdapter();
  const modelId = provider.models.find(model => normalizedModelId(model.modelId) === "gpt6luna")?.modelId;
  if (!modelId) throw new Error("未探测到测试所需模型 gpt-6-luna，请先刷新 Provider 模型列表。");
  const images = await assetImages(projectId, assets);
  async function requestOnce<T>(stage: BriefRequest["stage"], work: (requestId: string) => Promise<T>, save: (value: T) => Record<string, unknown>) {
    const current = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const latest = (current.modelSnapshot || {}) as Record<string, any>;
    const previous = latest.creationBriefRequest as BriefRequest | undefined;
    if (previous?.state === "running" && Date.now() - previous.startedAt < 90000) throw new BriefPreparationError("BRIEF_RUNNING", 409, "商品分析正在处理，请稍后查看结果。");
    if (previous?.sourceHash === sourceHash && previous.state !== "completed" && !retryUncertain) throw new BriefPreparationError("BRIEF_UNCERTAIN", 409, "上次分析结果未确认。已保存识别结果会复用；重新请求需勾选重试，可能再次计费。");
    const request: BriefRequest = { sourceHash, requestId: randomUUID(), stage, state: "running", startedAt: Date.now() };
    const claimed = await prisma.project.updateMany({ where: { id: projectId, updatedAt: current.updatedAt }, data: { modelSnapshot: json({ ...latest, creationBriefRequest: request }), updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)) } });
    if (!claimed.count) throw new BriefPreparationError("BRIEF_CONFLICT", 409, "商品资料正在更新，请稍后继续。");
    try {
      const result = await work(request.requestId);
      await saveBriefSnapshot(projectId, { ...save(result), creationBriefRequest: { ...request, state: "completed" } }, request);
      return result;
    } catch (error) {
      // If persistence fails too, the durable 'running' marker still blocks automatic replay.
      await saveBriefSnapshot(projectId, { creationBriefRequest: { ...request, state: "uncertain" } }, request).catch(() => undefined);
      throw new BriefPreparationError("BRIEF_UNCERTAIN", 409, `${stage === "复核" ? "商品识别已保存，复核暂未完成。" : "商品识别暂未完成。"}${requestErrorMessage(error)}重新请求需勾选重试，可能再次计费。`);
    }
  }
  const parsedDraft = draftSchema.safeParse(snapshot.creationBriefDraft);
  let draft = !force && parsedDraft.success && parsedDraft.data.sourceHash === sourceHash ? parsedDraft.data : undefined;
  if (!draft) {
    await requestOnce("识别", requestId => invokeStructured({ apiKey, baseUrl: provider.baseUrl, model: modelId, schema: observationsSchema, system: "你是商品识别模型。只返回 JSON。只记录图片和用户描述支持的商品事实、品类和不确定字段，不推断隐藏规格、性能或材质。", input: JSON.stringify({ description: project.description, assetIds: assets.map(asset => asset.id) }), images, timeoutMs: 60000, maxAttempts: 1, requestId, monitor: { projectId, operation: "v4_product_prepare" } }), observations => {
      draft = { sourceHash, modelId, observations, analyzedAt: new Date().toISOString() };
      return { creationBriefDraft: draft };
    });
  }
  const observations = draft!.observations;
  if (initialOnly) {
    const recommendedVisualDirection = categoryProfiles[observations.category].art;
    const result = { ...observations, version: 2 as const, visualDirection: recommendedVisualDirection, recommendedVisualDirection, recognition: { modelId: modelId!, imageCount: images.length, detail: "high" as const, analyzedAt: new Date().toISOString(), reviewed: false, detailViewCount: 0, corrections: [] } };
    await saveBriefSnapshot(projectId, { creationBrief: result, creationBriefSourceHash: sourceHash }); return result;
  }
  function finalize(reviewed: z.infer<typeof reviewSchema>) {
    const { corrections, ...finalBrief } = reviewed;
    const recommendedVisualDirection = categoryProfiles[finalBrief.category].art;
    const result = { ...finalBrief, version: 2 as const, visualDirection: recommendedVisualDirection, recommendedVisualDirection, recognition: { modelId: modelId!, imageCount: images.length, detail: "high" as const, analyzedAt: new Date().toISOString(), reviewed: true, detailViewCount: 0, corrections } };
    return result;
  }
  const reviewed = await requestOnce("复核", requestId => invokeStructured({ apiKey, baseUrl: provider.baseUrl, model: modelId, schema: reviewSchema, system: "你是商品事实复核模型。只返回 JSON。对照原图复核商品名称、品类、文字、数字和单位；无法确认的内容放入 uncertainties，不要写广告文案。", input: JSON.stringify({ draft: observations, description: project.description, assetIds: assets.map(asset => asset.id) }), images, timeoutMs: 60000, maxAttempts: 1, requestId, monitor: { projectId, operation: "v4_product_prepare_review" } }), result => ({ creationBrief: finalize(result), creationBriefSourceHash: sourceHash }));
  return finalize(reviewed);
}
