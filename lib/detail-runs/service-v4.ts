import { textSettings } from "@/lib/ai/text-protocol";
import { selectModel } from "@/lib/ai/model-selection";
import { isImageEndpointError } from "@/lib/ai/image-protocol";
import type { UpstreamImageTask } from "@/lib/ai/provider-client";
import { randomUUID } from "crypto";
import { startTiming, touchTiming, type TaskTiming } from "@/lib/tasks/timing";
import type { RequestTiming } from "./timing";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import sharp from "sharp";
import { prisma } from "@/lib/db/prisma";
import { getProviderAdapter, snapshotProvider, type ProviderSnapshot } from "@/lib/services/provider-service";
import { runWithProviderCredentials, type RequestProviderCredentials } from "@/lib/services/provider-runtime";
import { readStorageFile, saveGeneratedImage } from "@/lib/storage/asset-manager";
import { detailRunInputSchema, socialPostSchema, type DetailRunInput } from "./contracts";
import { xhsImageCount } from "./xhs";
import { invokeStructured } from "./structured-model";
import { normalizeTypesetting, type V4TextBlock } from "./typesetting-v4";
import { buildCommerceSystemPrompt } from "@/lib/ai/prompts/ecommerce-system";
import { materializeImagePrompts } from "./image-prompts-v4";
import { customerFacingCopy, cleanCustomerDirection, confirmedAnswerCopyRules } from "./customer-copy";
import { contentCoverageInstructions, contentCoverageSchema, contentPlacementSchema, prepareContentCoverage, prepareReadableCopy } from "./content-review-v4";
import { workflowReferenceAssets } from "@/lib/utils/asset-purpose";
import { claimRunLease, RunHalted, RUN_LEASE_MS } from "./run-lease";
import { isStructuredSchemaRejection, requestErrorMessage } from "@/lib/utils/request-error";
import { incompleteSupplementalEstimates, missingFieldSchema, normalizeSupplementalQuestions, resolveSupplementalSubmission, supplementalInputInstructions, supplementalQuestionsFromFields, supplementalQuestionIssues, supplementalSuggestionsSchema, type StoredSupplementalQuestion } from "./supplemental-input";

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const active = ["PENDING", "RUNNING", "WAITING_INPUT"];
const SKIP_INPUT_PREFIX = "按现有信息继续；";
const INPUT_STAGE_LABEL = "请确认商品补充信息";
const SUGGESTION_TASK = "只生成三个逐题弹窗的问题及每题三个具体候选答案，不重做商品规划。questions[].fields 使用 requiredFields 中的原始字段 ID，合并分组时也必须包含所有原始 ID；补充的商品场景或人群问题可使用新字段 ID。";
const workers = (globalThis as typeof globalThis & { detailV4Workers?: Set<string> }).detailV4Workers ??= new Set();

const planSchema = z.object({
  productName: z.string().min(1).max(100), category: z.string().min(1).max(80), facts: z.array(z.string().min(1).max(500)).max(40),
  contentCoverage: contentCoverageSchema.default([]).catch([]),
  requirements: z.array(z.string().max(500)).max(20).default([]), missingFields: z.array(missingFieldSchema).max(6).default([]),
  sections: z.array(z.object({ kind: z.enum(["HERO", "DETAIL"]), title: z.string().min(1).max(100), objective: z.string().min(1).max(500), buyerQuestion: z.string().max(300), copy: z.string().max(1600), evidence: z.array(z.string()).max(12).default([]) })).min(1).max(30),
});
const directionSchema = z.object({
  concept: z.string().max(1000).default(""), palette: z.array(z.string()).max(8).default([]), typography: z.string().max(500).default("清晰易读"),
  sections: z.array(z.object({ sectionIndex: z.number().int().nonnegative(), expression: z.enum(["photo", "annotation", "statement", "information"]), prompt: z.string().min(1).max(5000), textBlocks: z.array(z.object({
    text: z.string().max(1600),
    role: z.string().default("body"),
    x: z.number().default(5).catch(5),
    y: z.number().default(5).catch(5),
    width: z.number().default(90).catch(90),
    fontSize: z.number().default(24).catch(24),
    lineHeight: z.number().default(1.2).catch(1.2),
    align: z.string().default("left"),
  })).max(12) })).min(1).max(30),
});
const xhsPlanSchema = planSchema.extend({ post: socialPostSchema });
type WorkflowPlan = z.infer<typeof planSchema> & { post?: z.infer<typeof socialPostSchema> };
const imageReviewSchema = z.object({ passed: z.boolean(), issues: z.array(z.object({ kind: z.enum(["identity", "copy", "layout", "typography", "continuity"]), message: z.string().min(1).max(500), severity: z.enum(["warning", "error"]) })).max(10) });
const setReviewSchema = z.object({ passed: z.boolean(), issues: z.array(z.object({ sectionIndexes: z.array(z.number().int().nonnegative()).min(1), message: z.string().min(1).max(500) })).max(8) });

type RequestProgress = { state: "running" | "completed" | "uncertain" | "rejected"; requestId: string; error?: string; upstreamTask?: UpstreamImageTask };
export type V4Checkpoint = {
  taskTiming?: TaskTiming;
  requestTimings?: Record<string, RequestTiming>;
  workflowVersion: 4; stage: string; plan?: WorkflowPlan; artDirection?: z.infer<typeof directionSchema>; images: Array<{ sectionId: string; title: string; state: "pending" | "generating" | "generated" | "checked" | "uncertain"; assetId?: string; correctionCount: number; check?: z.infer<typeof imageReviewSchema> }>; imageReviews: Record<string, z.infer<typeof imageReviewSchema>>; setReview?: z.infer<typeof setReviewSchema>; missingFields?: z.infer<typeof planSchema>["missingFields"]; questions?: StoredSupplementalQuestion[]; answers: string[]; attempts: Record<string, number>; timings: Record<string, { startedAt: string; finishedAt?: string }>; lastError?: { stage: string; code: string; message: string; retryable: boolean };
  requests?: Record<string, RequestProgress>;
  retryAuthorized?: string[];
  setReviewGroups?: Record<string, { assetIds: string[]; result: z.infer<typeof setReviewSchema> }>;
  setReviewAssetIds?: string[];
  contentRepairRequested?: boolean;
  contentPlacements?: z.infer<typeof contentPlacementSchema>;
  confirmedSupplementalAnswers?: ReturnType<typeof resolveSupplementalSubmission>;
  supplementalQuestionIssue?: string;
  contentWarnings?: string[];
};

async function projectForRun(projectId: string) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { assets: { orderBy: [{ isMain: "desc" }, { sortOrder: "asc" }] }, sections: { orderBy: { order: "asc" }, include: { currentImageAsset: true } } } });
  if (typeof (project.modelSnapshot as { trashedAt?: unknown } | null)?.trashedAt === "string") throw new Error("作品已在回收站，请先还原。");
  return project;
}
async function imageData(assetId: string, projectId: string) {
  const asset = await prisma.productAsset.findFirstOrThrow({ where: { id: assetId, projectId } });
  const bytes = await sharp(await readStorageFile(asset.filePath)).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
async function assertIdle(projectId: string) {
  await prisma.detailRun.updateMany({ where: { projectId, status: { in: ["RUNNING", "PENDING"] }, leaseUntil: { lt: new Date() } }, data: { status: "INTERRUPTED", stage: "运行已中断，可继续", leaseToken: null, leaseUntil: null } });
  if (await prisma.detailRun.findFirst({ where: { projectId, OR: [{ status: { in: active } }, { leaseToken: { not: null }, leaseUntil: { gt: new Date() } }] } })) throw new Error("当前项目仍有任务或已发出的请求正在收尾，请稍后继续。");
}

function isTimeout(error: unknown) {
  const value = error as { name?: string; code?: string; message?: string } | null;
  return /timeout|timed out|abort/i.test(`${value?.name || ""} ${value?.code || ""} ${value?.message || String(error)}`);
}
function checksComplete(cp: V4Checkpoint) {
  return cp.images.length > 0 && cp.images.every(image => image.assetId && image.state === "checked" && image.check?.passed === true && !image.check.issues.some(issue => issue.severity === "error")) && cp.setReview?.passed === true && cp.setReview.issues.length === 0;
}
function hasResolvedReviewError(cp: V4Checkpoint) {
  return ["IMAGE_REVIEW", "SET_REVIEW"].includes(cp.lastError?.stage || "") && cp.images.length > 0 && cp.images.every(image => image.assetId && image.check) && !!cp.setReview;
}

export async function getV4DetailRun(projectId: string, runId?: string) {
  await prisma.detailRun.updateMany({ where: { projectId, ...(runId ? { id: runId } : {}), status: { in: ["PENDING", "RUNNING"] }, OR: [{ leaseUntil: { lte: new Date() } }, { leaseUntil: null }] }, data: { status: "INTERRUPTED", stage: "运行已中断，可继续", leaseToken: null, leaseUntil: null } });
  let run = await prisma.detailRun.findFirst({ where: { projectId, ...(runId ? { id: runId } : {}) }, orderBy: { createdAt: "desc" } });
  if (!run) return null;
  const checkpoint = run.checkpoint as unknown as V4Checkpoint;
  const selectedImages = checkpoint.workflowVersion === 4 ? await prisma.pageSection.findMany({ where: { projectId }, orderBy: { order: "asc" }, select: { id: true, currentImageAssetId: true } }) : [];
  const reviewAssets = checkpoint.setReviewAssetIds || checkpoint.images?.map(image => image.assetId);
  const selectedImagesMatch = selectedImages.length === checkpoint.images?.length && selectedImages.every((section, index) => checkpoint.images[index]?.sectionId === section.id && section.currentImageAssetId === checkpoint.images[index]?.assetId && section.currentImageAssetId === reviewAssets?.[index]);
  if (run.status === "COMPLETED" && checkpoint.workflowVersion === 4 && (!checksComplete(checkpoint) || !selectedImagesMatch)) {
    await prisma.detailRun.updateMany({ where: { id: run.id, status: "COMPLETED", updatedAt: run.updatedAt }, data: { status: "PARTIAL", stage: checkpoint.setReview ? "图片已生成，部分需人工检查" : "图片已生成，质量检查未完成" } });
    run = await prisma.detailRun.findUniqueOrThrow({ where: { id: run.id } });
  }
  const safeCheckpoint = { ...checkpoint, ...(checkpoint.lastError ? { lastError: { ...checkpoint.lastError, message: requestErrorMessage({ message: checkpoint.lastError.message }) } } : {}) };
  const resolvedReviewError = ["COMPLETED", "PARTIAL"].includes(run.status) && selectedImagesMatch && hasResolvedReviewError(checkpoint);
  if (resolvedReviewError) safeCheckpoint.lastError = undefined;
  if (run.status === "WAITING_INPUT" && checkpoint.workflowVersion === 4) {
    // Recheck saved candidates locally: a corrected validator must not leave an
    // old diagnostic blocking usable answers or require another paid request.
    const requiredFields = [...new Set([...(checkpoint.plan?.missingFields || []).map(field => field.field), ...incompleteSupplementalEstimates(checkpoint.confirmedSupplementalAnswers).flatMap(answer => answer.fields)])];
    safeCheckpoint.supplementalQuestionIssue = supplementalQuestionIssues(normalizeSupplementalQuestions(checkpoint.questions), requiredFields) || undefined;
  }
  return { id: run.id, projectId, status: run.status, stage: run.stage, input: run.input, checkpoint: json(safeCheckpoint), error: !resolvedReviewError && run.error ? requestErrorMessage({ message: run.error }) : null, createdAt: run.createdAt, updatedAt: run.updatedAt, draining: run.status === "CANCELED" && !!run.leaseToken && !!run.leaseUntil && run.leaseUntil.getTime() > Date.now() };
}

export async function createV4DetailRun(projectId: string, raw: unknown, credentials: RequestProviderCredentials) {
  const input = detailRunInputSchema.parse(raw) as DetailRunInput;
  if (input.mode === "translate") throw new Error("图片翻译已改为独立批量功能，请使用详情页翻译入口。");
  const existing = await prisma.detailRun.findUnique({ where: { projectId_idempotencyKey: { projectId, idempotencyKey: input.idempotencyKey } } });
  if (existing) {
    if ((existing.checkpoint as { workflowVersion?: number })?.workflowVersion !== 4) throw new Error("该历史任务不支持 V4 执行，请重新创建任务。");
    return getV4DetailRun(projectId, existing.id);
  }
  await assertIdle(projectId);
  const project = await projectForRun(projectId);
  if (input.mode === "xhs") {
    input.heroCount = 0;
    input.detailCount = xhsImageCount(raw as DetailRunInput, input.instruction || project.description || "");
  }
  const snapshot = project.modelSnapshot as { workType?: string; translationReady?: boolean } | null;
  if (snapshot?.workType === "translation" || snapshot?.translationReady) throw new Error("翻译项目请在详情页翻译入口处理。");
  if (!project.assets.length && input.mode !== "xhs") throw new Error("请先上传商品素材。");
  const { provider } = await getProviderAdapter();
  const planningModelId = selectModel(provider.models, "planning", undefined, project.assets.length > 0);
  const analysisModelId = selectModel(provider.models, "analysis");
  const heroModelId = input.heroCount ? selectModel(provider.models, "hero") : undefined;
  const imageModelId = input.detailCount ? selectModel(provider.models, "detail") : heroModelId!;
  const providerSnapshot = snapshotProvider(provider);
  const checkpoint: V4Checkpoint = { workflowVersion: 4, stage: "PREPARE", images: [], imageReviews: {}, answers: [], attempts: {}, timings: {} };
  let run;
  try {
    run = await prisma.$transaction(async tx => {
      // Acquire the project write lock before checking; different request keys
      // must not launch simultaneous paid workflows for the same project.
      await tx.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
      const same = await tx.detailRun.findUnique({ where: { projectId_idempotencyKey: { projectId, idempotencyKey: input.idempotencyKey } } });
      if (same) return same;
      if (await tx.detailRun.findFirst({ where: { projectId, OR: [{ status: { in: active } }, { leaseToken: { not: null }, leaseUntil: { gt: new Date() } }] } })) throw new Error("当前项目仍有任务或已发出的请求正在收尾，请稍后继续。");
      return tx.detailRun.create({ data: { projectId, idempotencyKey: input.idempotencyKey, input: json({ ...input, workflowVersion: 4, planningModelId, analysisModelId, heroModelId, imageModelId, providerSnapshot }), checkpoint: json(checkpoint), leaseUntil: new Date(Date.now() + 60000) } });
    });
  } catch (error) {
    // Two browser retries can pass the read above at the same time. Treat the
    // unique-key winner as the idempotent result instead of starting twice.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const winner = await prisma.detailRun.findUniqueOrThrow({ where: { projectId_idempotencyKey: { projectId, idempotencyKey: input.idempotencyKey } } });
    const winnerCheckpoint = winner.checkpoint as { workflowVersion?: number } | null;
    if (winnerCheckpoint?.workflowVersion !== 4) throw new Error("该幂等键已被旧版任务占用，请重新提交任务。");
    return getV4DetailRun(projectId, winner.id);
  }
  launchV4(run.id, credentials);
  return getV4DetailRun(projectId, run.id);
}

function launchV4(runId: string, credentials: RequestProviderCredentials) {
  if (workers.has(runId)) return;
  workers.add(runId);
  void runWithProviderCredentials(credentials, () => executeV4(runId)).catch(error => {
    console.error("V4 worker stopped:", error instanceof Error ? error.name : "Unknown error");
  }).finally(() => workers.delete(runId));
}

export async function controlV4DetailRun(projectId: string, runId: string, action: "answers" | "suggestions" | "resume" | "cancel", raw: unknown, credentials: RequestProviderCredentials) {
  if (action !== "cancel") await projectForRun(projectId);
  await getV4DetailRun(projectId, runId);
  const run = await prisma.detailRun.findFirstOrThrow({ where: { id: runId, projectId } });
  const cp = run.checkpoint as unknown as V4Checkpoint;
  if (action !== "cancel" && (run.input as { mode?: string } | null)?.mode === "translate") throw new Error("旧翻译任务请在详情页翻译批次中继续，当前执行器不再处理翻译。");
  if (cp.workflowVersion !== 4) throw new Error("该历史任务不支持继续执行，请重新创建任务。");
  if (action === "cancel") { await prisma.detailRun.updateMany({ where: { id: runId, status: { in: active } }, data: { status: "CANCELED", stage: "已停止" } }); return getV4DetailRun(projectId, runId); }
  if (run.status === "RUNNING" || run.status === "PENDING") return getV4DetailRun(projectId, runId);
  if (workers.has(runId) || (run.leaseToken && run.leaseUntil && run.leaseUntil.getTime() > Date.now())) {
    // A concurrent click may have started the worker after our status read.
    // Reuse that work; only a canceled worker must finish before resuming.
    const latest = await getV4DetailRun(projectId, runId);
    if (latest && latest.status !== "CANCELED") return latest;
    throw new Error("已发出的请求正在收尾并保存结果，请稍后继续。");
  }
  if (run.status === "COMPLETED") return getV4DetailRun(projectId, runId);
  if (action === "resume" && run.status === "WAITING_INPUT") throw new Error("请先提交补充信息或选择按现有信息继续。");
  if (await prisma.detailRun.findFirst({ where: { projectId, id: { not: runId }, OR: [{ status: { in: active } }, { leaseToken: { not: null }, leaseUntil: { gt: new Date() } }] } })) throw new Error("该项目还有其他任务在运行。");
  const legacyRequests = !cp.requests;
  cp.requests ??= {};
  // Old V4 checkpoints predate the request ledger. Preserve their uncertain work too.
  const uncertainStage = cp.lastError?.stage || cp.stage;
  const rememberUncertain = (key: string) => { cp.requests![key] ??= { state: "uncertain", requestId: `legacy:${key}` }; };
  if (legacyRequests) {
    if (uncertainStage === "PLAN" && !cp.plan) rememberUncertain("PLAN");
    if (uncertainStage === "ART_DIRECTION" && !cp.artDirection) rememberUncertain("ART_DIRECTION");
    if (uncertainStage === "IMAGE_REVIEW") for (const image of cp.images.filter(image => image.assetId && !image.check)) rememberUncertain(`IMAGE_REVIEW:${image.sectionId}`);
    if (uncertainStage === "SET_REVIEW" && !cp.setReview && !cp.setReviewGroups) rememberUncertain("SET_REVIEW:0");
  }
  for (const request of Object.values(cp.requests)) if (request.state === "running") request.state = "uncertain";
  for (const image of cp.images) if (image.state === "generating") image.state = "uncertain";
  const { retryUncertain } = z.object({ retryUncertain: z.boolean().default(false) }).parse(raw ?? {});
  // One click grants a single new attempt only for requests already uncertain at that click.
  cp.retryAuthorized = retryUncertain ? [
    ...Object.entries(cp.requests).filter(([key, request]) => request.state === "uncertain" && !key.startsWith("GENERATE:")).map(([key]) => key),
    ...cp.images.filter(image => !image.assetId && image.state === "uncertain" && image.correctionCount < 1).map(image => `GENERATE:${image.sectionId}`),
  ] : [];
  if (action === "suggestions") {
    if (run.status !== "WAITING_INPUT") throw new Error("当前任务没有待补充的问题。");
    const issue = supplementalQuestionIssues(normalizeSupplementalQuestions(cp.questions), (cp.plan?.missingFields || []).map(field => field.field));
    if (!issue) return getV4DetailRun(projectId, runId);
    // An explicit click may replace a completed but unusable suggestion set.
    // An ambiguous request still requires the normal paid-retry consent.
    if (cp.requests.INPUT_SUGGESTIONS?.state === "completed") cp.retryAuthorized.push("INPUT_SUGGESTIONS");
  }
  if (action === "answers") {
    if (run.status !== "WAITING_INPUT") throw new Error("当前任务没有待回答问题。");
    if (cp.images.some(image => image.assetId) || Object.keys(cp.requests).some(key => key.startsWith("GENERATE:"))) throw new Error("当前任务已有图片请求，不能重新提交商品规划，请保留现有结果。");
    const body = z.object({ answer: z.string().max(6000).optional(), skip: z.boolean().optional(), responses: z.unknown().optional() }).parse(raw);
    if (body.responses !== undefined) {
      const questions = normalizeSupplementalQuestions(cp.questions);
      if (supplementalQuestionIssues(questions, (cp.plan?.missingFields || []).map(field => field.field))) throw new Error("请先为商品生成完整的具体候选答案。");
      cp.confirmedSupplementalAnswers = resolveSupplementalSubmission(questions, raw);
      cp.answers.push(cp.confirmedSupplementalAnswers.map(item => `${item.question}\n${item.source === "custom" ? "用户填写" : "用户选用的模拟推测答案（非实测）"}：${item.answer}`).join("\n\n"));
    } else {
      // Retain compatibility for callers using the previous free-text form.
      if (!body.skip && !body.answer?.trim()) throw new Error("请填写补充信息。");
      cp.answers.push(body.skip ? "按现有信息继续；缺失字段不得推断。" : body.answer!.trim());
    }
    cp.missingFields = undefined; cp.questions = undefined; cp.supplementalQuestionIssue = undefined;
    // A new answer changes the factual plan, so invalidate only downstream
    // planning artifacts; already generated images are not present here.
    cp.plan = undefined; cp.artDirection = undefined; cp.images = []; cp.imageReviews = {}; cp.requests = {}; cp.retryAuthorized = []; cp.setReview = undefined; cp.setReviewGroups = {}; cp.setReviewAssetIds = undefined;
    cp.contentRepairRequested = undefined; cp.contentPlacements = undefined;
    cp.contentWarnings = undefined;
  }
  const changed = await prisma.detailRun.updateMany({ where: { id: runId, status: run.status, updatedAt: run.updatedAt }, data: { status: "PENDING", stage: "准备继续", error: null, checkpoint: json(cp), leaseToken: null, leaseUntil: new Date(Date.now() + RUN_LEASE_MS) } });
  if (changed.count) launchV4(runId, credentials);
  return getV4DetailRun(projectId, runId);
}

async function executeV4(runId: string) {
  const lease = await claimRunLease(runId);
  if (!lease) return;
  const run = await prisma.detailRun.findUniqueOrThrow({ where: { id: runId } }).catch(async error => { await lease.release(); throw error; });
  const input = run.input as unknown as DetailRunInput & { planningModelId: string; analysisModelId?: string; heroModelId?: string; imageModelId: string; editModelId: string; providerSnapshot?: ProviderSnapshot };
  const cp = run.checkpoint as unknown as V4Checkpoint;
  cp.requests ??= {};
  cp.taskTiming = startTiming(cp.taskTiming);
  cp.requestTimings ??= {};
  // Freeze an interrupted session at its last checkpoint before resuming. The
  // request ledger still decides whether a paid request may be sent again.
  for (const timing of Object.values(cp.requestTimings)) if (!timing.finishedAt) timing.finishedAt = timing.updatedAt;
  const projectId = run.projectId;
  let persistQueue = Promise.resolve();
  const persist = (stage?: string) => {
    if (stage) cp.stage = stage;
    cp.taskTiming = touchTiming(cp.taskTiming!);
    for (const [key, timing] of Object.entries(cp.requestTimings!)) {
      if (!timing.finishedAt) cp.requestTimings![key] = { ...timing, ...touchTiming(timing) };
    }
    const snapshot = json(cp), savedStage = cp.stage;
    persistQueue = persistQueue.then(() => lease.transaction(async tx => {
      await tx.detailRun.update({ where: { id: runId }, data: { checkpoint: snapshot } });
      await tx.detailRun.updateMany({ where: { id: runId, status: "RUNNING" }, data: { stage: savedStage } });
    }, true));
    return persistQueue;
  };
  const begin = async (stage: string) => { await lease.assertActive(); cp.stage = stage; cp.timings[stage] ??= { startedAt: new Date().toISOString() }; await persist(stage); };
  const end = (stage: string) => { if (cp.timings[stage]) cp.timings[stage].finishedAt = new Date().toISOString(); return persist(); };
  const requestOnce = async <T>(key: string, invoke: (requestId: string) => Promise<T>, save: (result: T) => void) => {
    await lease.assertActive();
    const previous = cp.requests![key];
    const queryExisting = key.startsWith("GENERATE:") && previous?.upstreamTask && previous.upstreamTask.status !== "failed";
    const authorized = cp.retryAuthorized?.includes(key);
    if (previous && previous.state !== "rejected" && !authorized && !queryExisting) throw new Error(`${key} 上次请求结果未确认，已跳过；如需重新请求，请勾选可能再次计费的重试选项。`);
    cp.retryAuthorized = cp.retryAuthorized?.filter(item => item !== key);
    const requestId = queryExisting ? previous.requestId : randomUUID();
    cp.requests![key] = { state: "running", requestId, ...(queryExisting ? { upstreamTask: previous.upstreamTask } : {}) };
    const previousTiming = cp.requestTimings![key];
    const timing = startTiming(previousTiming);
    cp.requestTimings![key] = { ...timing, firstStartedAt: previousTiming?.firstStartedAt || previousTiming?.startedAt || timing.startedAt };
    if (!queryExisting) cp.attempts[key] = (cp.attempts[key] || 0) + 1;
    await persist();
    await lease.assertActive();
    try {
      const result = await invoke(requestId);
      save(result);
      cp.requestTimings![key] = { ...cp.requestTimings![key], ...touchTiming(cp.requestTimings![key], true) };
      cp.requests![key] = { ...cp.requests![key], state: "completed", requestId };
      await persist();
      return result;
    } catch (error) {
      // The provider may have accepted/billed a request even when no result reached us.
      cp.requestTimings![key] = { ...cp.requestTimings![key], ...touchTiming(cp.requestTimings![key], true) };
      cp.requests![key] = { ...cp.requests![key], state: isStructuredSchemaRejection(error) || (error as { code?: string })?.code === "LOCAL_BUDGET_PAUSED" ? "rejected" : "uncertain", requestId, error: requestErrorMessage(error, "请求结果未确认，已有结果已保留。") };
      await persist();
      throw error;
    }
  };
  try {
    const current = await projectForRun(projectId);
    const snapshot = current.modelSnapshot as { creativePreferences?: { userDirection?: string } } | null;
    const userInstruction = input.instruction || snapshot?.creativePreferences?.userDirection || "";
    const providerContext = await getProviderAdapter(input.providerSnapshot?.id, input.providerSnapshot, { legacyTextProtocol: !input.providerSnapshot });
    const { adapter, provider, apiKey } = providerContext;
    const { product: productImages, style: styleImages } = workflowReferenceAssets(current.assets);
    const images = await Promise.all(productImages.map(a => imageData(a.id, projectId)));
    const visualImages = [...images, ...await Promise.all(styleImages.map(a => imageData(a.id, projectId)))];
    const referenceRoles = styleImages.length ? `参考图片按顺序：前${images.length}张是唯一商品身份与外观证据；其后${styleImages.length}张仅为风格参考，用于光线、色调、构图、细节放大和信息密度。风格参考中的文字、承诺、规格、商品结构不可作为事实或照抄；商品结构以原始商品图为准。` : "";
    await begin("PLAN");
    const evidenceCatalog = [
      { id: "user_description", kind: "description", text: current.description || "" },
      ...productImages.map(asset => ({ id: asset.id, kind: asset.type, fileName: asset.fileName })),
    ];
    const sectionSlots = Array.from({ length: input.heroCount + input.detailCount }, (_, sectionIndex) => ({ sectionIndex, kind: sectionIndex < input.heroCount ? "HERO" : "DETAIL" }));
    const coverageRules = input.mode === "xhs" ? "小红书图文仅按用户主题与配图数量创作，不要求电商八类内容覆盖；contentCoverage返回空数组。" : input.detailCount === 0
      ? "用户选择0张详情图，只生成指定数量的HERO，不得补充DETAIL。contentCoverage可引用承载对应内容的HERO下标；超出主图范围的模块标记not_applicable并说明用户仅要求主图，不因缺少详情图而要求补充信息。"
      : `${input.heroCount === 0 ? "用户选择0张主图，只生成指定数量的DETAIL，不得补充HERO。\n" : ""}${contentCoverageInstructions}`;
    const planInput = JSON.stringify({ productName: current.name, description: current.description, platform: current.platform, language: input.language, userInstruction, answers: cp.answers, confirmedSupplementalAnswers: cp.confirmedSupplementalAnswers, evidenceCatalog, requestedHeroCount: input.heroCount, requestedDetailCount: input.detailCount, sectionSlots, contentCoverageRules: coverageRules, supplementalInputRules: supplementalInputInstructions });
    const confirmedEstimates = cp.confirmedSupplementalAnswers?.some(answer => answer.basis === "model_estimate") === true;
    let plan = cp.plan;
    const requestPlanSchema: z.ZodType<WorkflowPlan> = input.mode === "xhs" ? xhsPlanSchema : planSchema;
    // Planning includes image input and complete page copy. Responses may send
    // headers early while still generating; allow three minutes for completion.
    if (!plan) plan = await requestOnce("PLAN", requestId => invokeStructured({ ...textSettings(input.providerSnapshot || {}), apiKey, baseUrl: provider.baseUrl, model: input.planningModelId, schema: requestPlanSchema, system: input.mode === "xhs"
      ? `你是小红书图文规划模型。只返回 JSON。按用户主题创作标题、正文、3–8个标签和恰好${input.detailCount}张3:4竖版配图的完整文案，全部 sections.kind 为 DETAIL，不生成 HERO。post 包含 title、caption、hashtags、language，遵守用户字数与语言要求；productName 是主题名。不要编造个人经历、事实数据、品牌功效或来源。普通知识/插画创作不需要商品材质、尺寸等参数，contentCoverage 返回空数组，不套用电商详情页八模块。只有确实阻止主题创作的信息才列入 missingFields；无需补充则为空。sections[].copy 写该图可见的完整文字，evidence 只用 evidenceCatalog 内的 ID。`
      : `${buildCommerceSystemPrompt(current.platform, ["hero_search", "feature_proof", "lifestyle", "material_closeup", "specification", "trust", "summary"])}\n你是商品规划模型。只返回 JSON。写出有证据的商品事实、买家价值和完整的逐屏内容；未知字段放入 missingFields，不要设计字体、背景或工具调用。sections[].copy 是最终需要呈现的完整文案，包含标题、解释、标签与已知参数，每条独立文案换行，不写Markdown装饰或制作说明，不用只有标题的提纲代替内容。\n${input.detailCount === 0 ? coverageRules : "完整详情任务的 contentCoverage 逐项交代八类内容：covered 必须引用真实承载该内容的详情页下标（全套从0开始，不能只引用HERO）；needs_input 写明具体缺失资料；not_applicable 写明产品或用户范围依据。少屏可以合并内容模块，不允许用“简洁”“留白”作为省略理由。缺失的用户要求应进入missingFields。"}\n证据引用规则：sections[].evidence 只能填写 evidenceCatalog 中的 id（user_description 或真实资产 ID），不要填写自然语言证据句。`, input: planInput, images, timeoutMs: 180000, maxAttempts: 1, requestId, monitor: { projectId, runId, operation: "v4_plan" } }), result => { cp.plan = result; });
    if (!plan) throw new Error("规划结果为空");
    if (confirmedEstimates) plan = { ...plan, sections: plan.sections.map(section => ({ ...section, title: customerFacingCopy(section.title) || "商品信息", copy: customerFacingCopy(section.copy) })) };
    const expected = input.heroCount + input.detailCount;
    const countIssues = [plan.sections.filter(s => s.kind === "HERO").length !== input.heroCount ? `HERO 数量必须为 ${input.heroCount}` : "", plan.sections.filter(s => s.kind === "DETAIL").length !== input.detailCount ? `DETAIL 数量必须为 ${input.detailCount}` : ""].filter(Boolean);
    if (countIssues.length) throw new Error(countIssues.join("；"));
    // Models sometimes return a useful evidence description instead of the
    // requested source ID. Keep that description grounded by mapping it to
    // the only valid source categories before the strict local check.
    const evidenceIds = new Set(["user_description", ...productImages.map(asset => asset.id)]);
    plan = {
      ...plan,
      sections: plan.sections.map(section => ({
        ...section,
        evidence: section.evidence.map(value => {
          if (evidenceIds.has(value)) return value;
          return /描述|文字|用户|商品名|规格|容量|尺寸|材质|性能/i.test(value) ? "user_description" : (productImages[0]?.id || "user_description");
        }),
      })),
    };
    const unsupportedEvidence = plan.sections.flatMap(section => section.evidence.filter(id => !evidenceIds.has(id)).map(id => `${section.title}: ${id}`));
    const auditLanguage = plan.sections.some(section => /内部审查|模型判断|推理过程|待检查|审查话术/i.test(`${section.title}\n${section.copy}`));
    if (unsupportedEvidence.length) throw new Error(`规划包含不存在的证据引用：${unsupportedEvidence.join("、")}`);
    const imageRequestsStarted = cp.images.some(image => image.assetId || image.state !== "pending")
      || Object.keys(cp.requests).some(key => key.startsWith("GENERATE:"))
      || current.assets.some(asset => asset.type === "GENERATED" && (asset.metadata as { runId?: string } | null)?.runId === runId);
    const content = input.mode === "xhs" ? { plan, warnings: [] } : prepareContentCoverage(plan, !cp.artDirection && !imageRequestsStarted);
    plan = content.plan;
    cp.plan = plan;
    cp.contentWarnings = [...new Set([...(cp.contentWarnings || []), ...content.warnings, ...(auditLanguage ? ["部分文案含制作说明，请在预览中核对措辞。"] : [])])];
    cp.contentRepairRequested = false;
    if (cp.lastError?.stage === "PLAN") cp.lastError = undefined;
    // For detail-page creation the model lists missing information; it cannot waive confirmation by
    // setting blocking=false. Never rewind an old run that has already paid for images.
    const needsInput = input.mode === "create" ? plan.missingFields.length > 0 : plan.missingFields.some(field => field.blocking);
    const incompleteEstimates = incompleteSupplementalEstimates(cp.confirmedSupplementalAnswers);
    if (!imageRequestsStarted && ((!cp.confirmedSupplementalAnswers?.length && needsInput) || incompleteEstimates.length > 0) && !cp.answers.some(answer => answer.startsWith(SKIP_INPUT_PREFIX))) {
      cp.plan = plan;
      cp.missingFields = plan.missingFields;
      // Legacy options named parameters without supplying their values. Such a
      // selection is not numerical confirmation, even though it was submitted.
      const requiredFields = [...new Set([...plan.missingFields.map(field => field.field), ...incompleteEstimates.flatMap(answer => answer.fields)])];
      cp.questions = normalizeSupplementalQuestions(cp.questions || supplementalQuestionsFromFields(plan.missingFields));
      let issue = supplementalQuestionIssues(normalizeSupplementalQuestions(cp.questions), requiredFields);
      if (issue && (cp.requests.INPUT_SUGGESTIONS?.state !== "completed" || cp.retryAuthorized?.includes("INPUT_SUGGESTIONS"))) {
        await begin("INPUT_SUGGESTIONS");
        await requestOnce("INPUT_SUGGESTIONS", requestId => invokeStructured({
          apiKey, baseUrl: provider.baseUrl, model: input.planningModelId, schema: supplementalSuggestionsSchema,
          system: `你是商品补充候选模型。只返回JSON。${supplementalInputInstructions}`,
          input: JSON.stringify({ productName: current.name, description: current.description, category: plan.category, facts: plan.facts, userInstruction,
            requiredFields, missingFields: [...plan.missingFields.map(({ field, question }) => ({ field, question })), ...incompleteEstimates.map(answer => ({ field: answer.fields.join("、"), question: answer.question }))], evidenceCatalog, task: SUGGESTION_TASK }),
          images, timeoutMs: 60000, maxAttempts: 1, requestId, monitor: { projectId, runId, operation: "v4_input_suggestions" },
        }), result => {
          cp.questions = normalizeSupplementalQuestions(result.questions.map(question => ({ ...question, blocking: true, requiresImage: false })));
        });
        issue = supplementalQuestionIssues(normalizeSupplementalQuestions(cp.questions), requiredFields);
        await end("INPUT_SUGGESTIONS");
        if (cp.lastError?.stage === "INPUT_SUGGESTIONS") cp.lastError = undefined;
      }
      cp.supplementalQuestionIssue = issue || undefined;
      cp.taskTiming = touchTiming(cp.taskTiming!, true);
      await persist("WAITING_INPUT");
      await lease.transaction(async tx => { await tx.detailRun.update({ where: { id: runId }, data: { status: "WAITING_INPUT", stage: INPUT_STAGE_LABEL, checkpoint: json(cp) } }); });
      return;
    }
    cp.plan = plan;
    // Unselected suggestions must never enter visual direction or image prompts.
    plan.missingFields = plan.missingFields.map(field => ({ ...field, options: [] }));
    // Stable section IDs are part of the checkpoint. Never delete/recreate them on resume.
    const plannedSections = plan.sections;
    await lease.transaction(async tx => {
      if (input.mode === "xhs" && plan.post) {
        const latest = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { modelSnapshot: true } });
        await tx.project.update({ where: { id: projectId }, data: { modelSnapshot: json({ ...(latest.modelSnapshot as object || {}), socialPost: plan.post }) } });
      }
      for (const [index, section] of plannedSections.entries()) await tx.pageSection.upsert({
        where: { projectId_sectionKey: { projectId, sectionKey: `v4-${index}` } },
        update: {},
        create: { projectId, sectionKey: `v4-${index}`, type: section.kind === "HERO" ? "HERO" : "CUSTOM", title: section.title, goal: section.objective, copy: section.copy, visualPrompt: `${section.objective}\n${section.copy}`, order: index, editableData: json({ workflowVersion: 4, evidence: section.evidence }) },
      });
    });
    await end("PLAN");
    await begin("ART_DIRECTION");
    const art = cp.artDirection ?? await requestOnce("ART_DIRECTION", requestId => invokeStructured({ ...textSettings(input.providerSnapshot || {}), apiKey, baseUrl: provider.baseUrl, model: input.planningModelId, schema: directionSchema, system: `${buildCommerceSystemPrompt(current.platform, ["hero_search", "feature_proof", "lifestyle", "material_closeup", "specification", "trust", "summary"])}\n${confirmedAnswerCopyRules}\n你是视觉分镜模型。只返回完整 JSON。根据完整内容任务设计每张图的构图、光线、场景、文字和信息模块，sectionIndex必须对应规划从0开始的下标。plan.sections[].copy 是内容基础，可以自然润色标题、调整句式、标点和换行，无需逐字复刻；保持完整买家信息、参数标签、数值、单位和尺寸表，不把完整页面简化成只有标题。不要删除页面，不要编造规格。每张最终prompt必须完整描述主体、镜头、环境、光线、配色、细节/信息模块与排版，最终可见文字以textBlocks为准；不能只写标题或依赖前一张图。按内容安排场景、微距、标注、信息图与规格表，避免所有页面同一背景加整件产品。`, input: JSON.stringify({ plan, platform: current.platform, language: input.language, userInstruction, referenceRoles }), images: visualImages, timeoutMs: Math.max(90000, Math.min(180000, expected * 15000)), maxAttempts: 1, requestId, monitor: { projectId, runId, operation: "v4_art_direction" } }), result => { cp.artDirection = result; });
    const savedSections = await prisma.pageSection.findMany({ where: { projectId, sectionKey: { in: plan.sections.map((_, index) => `v4-${index}`) } }, orderBy: { order: "asc" } });
    if (art.sections.length !== expected) throw new Error("视觉分镜数量与页面数量不一致");
    const readableCopy = prepareReadableCopy(plan.sections, confirmedEstimates ? art.sections.map(cleanCustomerDirection) : art.sections);
    const normalizedArt = { ...art, sections: readableCopy.sections.map((section) => ({ ...section, textBlocks: normalizeTypesetting(section.textBlocks as V4TextBlock[]) })) };
    cp.artDirection = normalizedArt;
    cp.contentWarnings = [...new Set([...(cp.contentWarnings || []), ...readableCopy.warnings])];
    if (cp.lastError?.stage === "ART_DIRECTION") cp.lastError = undefined;
    const sections = materializeImagePrompts(savedSections, normalizedArt.sections, confirmedEstimates).map(section => ({ ...section, visualPrompt: referenceRoles ? `${referenceRoles}\n${section.visualPrompt}` : section.visualPrompt }));
    await lease.transaction(async tx => { for (const section of sections) { await tx.pageSection.update({ where: { id: section.id }, data: { visualPrompt: section.visualPrompt, editableData: json({ ...(section.editableData as object || {}), workflowVersion: 4, artDirection: section.artDirection }) } }); } });
    const recoveredAssets = await prisma.productAsset.findMany({ where: { projectId, type: "GENERATED", sectionId: { in: sections.map(section => section.id) } }, orderBy: { createdAt: "desc" } });
    cp.images = sections.map(section => {
      const previous = cp.images.find(image => image.sectionId === section.id);
      const savedAsset = recoveredAssets.find(asset => asset.sectionId === section.id && (asset.metadata as { runId?: string } | null)?.runId === runId);
      // Also adopt an explicit user edit instead of overwriting it with a resumed generation.
      const assetId = section.currentImageAssetId || previous?.assetId || savedAsset?.id;
      const image = previous ?? { sectionId: section.id, title: section.title, state: "pending" as const, correctionCount: 0 };
      if (assetId) {
        if (image.assetId !== assetId) {
          image.check = undefined; delete cp.imageReviews[section.id]; delete cp.requests![`IMAGE_REVIEW:${section.id}`]; cp.setReview = undefined; cp.setReviewGroups = {}; cp.setReviewAssetIds = undefined;
          for (const key of Object.keys(cp.requests!)) if (key.startsWith("SET_REVIEW:")) delete cp.requests![key];
        }
        image.assetId = assetId;
        image.check ??= cp.imageReviews[section.id];
        image.state = image.check ? "checked" : "generated";
        const request = cp.requests![`GENERATE:${section.id}`];
        if (request) request.state = "completed";
      } else if (image.state === "generating" || cp.requests![`GENERATE:${section.id}`]) image.state = "uncertain";
      return image;
    });
    await lease.transaction(async tx => { for (const image of cp.images.filter(image => image.assetId)) await tx.pageSection.update({ where: { id: image.sectionId }, data: { currentImageAssetId: image.assetId, status: "SUCCESS" } }); });
    await end("ART_DIRECTION");
    await begin("GENERATE");
    if (cp.lastError?.stage === "GENERATE") cp.lastError = undefined;
    const settings = (input.imageSettings || {}) as { size?: string; background?: "auto" | "opaque" | "transparent"; outputFormat?: "png" | "jpeg" | "webp"; outputCompression?: number; moderation?: "auto" | "low" };
    const renderOne = async (progress: V4Checkpoint["images"][number], section: typeof sections[number]) => {
      if (progress.assetId) return;
      const key = `GENERATE:${section.id}`;
      const upstreamTask = cp.requests![key]?.upstreamTask;
      const queryExisting = upstreamTask && upstreamTask.status !== "failed";
      if (progress.state === "uncertain" && !queryExisting && (!cp.retryAuthorized?.includes(key) || progress.correctionCount >= 1)) return;
      await lease.assertActive();
      if (progress.state === "uncertain" && !queryExisting) progress.correctionCount++;
      progress.state = "generating"; await persist(`GENERATE:${section.title}`);
      try {
        await requestOnce(key, async requestId => {
          const source = await adapter.generateImageOnce({ model: section.type === "HERO" ? input.heroModelId || input.imageModelId : input.imageModelId, prompt: section.visualPrompt, quality: input.quality, background: settings.background, outputFormat: settings.outputFormat, outputCompression: settings.outputCompression, moderation: settings.moderation, ...(settings.size && settings.size !== "auto" ? { size: settings.size } : { aspectRatio: section.type === "HERO" ? "1:1" : "3:4" }), referenceImages: visualImages, timeoutMs: 180000, monitor: { projectId, sectionId: section.id, runId, operation: "v4_image_generation" },
            upstreamTask: cp.requests![key].upstreamTask,
            onUpstreamTask: async task => { cp.requests![key].upstreamTask = task; await persist(); },
            beforeSubmit: () => lease.assertActive(),
          });
          const asset = await saveGeneratedImage({ projectId, sectionId: section.id, prompt: section.visualPrompt, source, metadata: { runId, requestId, workflowVersion: 4 } });
          await lease.transaction(async tx => { await tx.pageSection.update({ where: { id: section.id }, data: { currentImageAssetId: asset.id, status: "SUCCESS" } }); }, true);
          return asset;
        }, asset => { progress.assetId = asset.id; progress.state = "generated"; });
      } catch (error) {
        if (error instanceof RunHalted) throw error;
        progress.state = "uncertain"; cp.lastError = { stage: "GENERATE", code: isTimeout(error) ? "TIMEOUT" : "IMAGE_REQUEST_FAILED", message: requestErrorMessage(error, "图片请求结果未确认，已保存的图片会保留。"), retryable: false }; await persist();
        // Drain issued calls, but do not send every image to an unsupported route.
        if (isImageEndpointError(error)) throw error;
      }
    };
    const hero = cp.images.find(i => sections.find(s => s.id === i.sectionId)?.type === "HERO");
    if (hero) await renderOne(hero, sections.find(s => s.id === hero.sectionId)!);
    const details = cp.images.filter(i => i !== hero && !i.assetId);
    for (let index = 0; index < details.length; index += 2) {
      await lease.assertActive();
      const results = await Promise.allSettled(details.slice(index, index + 2).map(i => renderOne(i, sections.find(s => s.id === i.sectionId)!)));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    await end("GENERATE");
    await begin("IMAGE_REVIEW");
    for (const progress of cp.images.filter(i => i.assetId && i.state === "generated")) {
      try {
        const reviewImage = await imageData(progress.assetId!, projectId);
        await requestOnce(`IMAGE_REVIEW:${progress.sectionId}`, requestId => invokeStructured({ ...textSettings(input.providerSnapshot || {}), apiKey, baseUrl: provider.baseUrl, model: input.analysisModelId || input.planningModelId, schema: imageReviewSchema, system: `你是图片质检模型。只返回 JSON。检查商品一致性、事实准确性、排版可读性、构图和连续性，只报告实际问题。标题同义改写、标点和换行差异不算缺陷；不要逐字对照规划文案，关注事实、参数、完整信息和可读性。${confirmedAnswerCopyRules}缺少内部来源说明不算图片缺陷。`, input: JSON.stringify({ section: sections.find(s => s.id === progress.sectionId)?.title, plan: cp.plan, art: cp.artDirection?.sections.find(s => s.sectionIndex === sections.find(s => s.id === progress.sectionId)?.order) }), images: [reviewImage], timeoutMs: 45000, maxAttempts: 1, requestId, monitor: { projectId, sectionId: progress.sectionId, runId, operation: "v4_image_review" } }), review => {
          const result = { ...review, passed: review.passed && !review.issues.some(issue => issue.severity === "error") };
          progress.check = result; progress.state = "checked"; cp.imageReviews[progress.sectionId] = result;
        });
      } catch (error) {
        if (error instanceof RunHalted) throw error;
        cp.lastError = { stage: "IMAGE_REVIEW", code: isTimeout(error) ? "TIMEOUT" : "REVIEW_FAILED", message: requestErrorMessage(error, "图片检查未完成，图片已保留，请人工核对。"), retryable: false }; await persist();
      }
    }
    await end("IMAGE_REVIEW");
    await begin("SET_REVIEW");
    const assetIds = cp.images.map(image => image.assetId || "");
    if (cp.setReviewAssetIds && JSON.stringify(cp.setReviewAssetIds) !== JSON.stringify(assetIds)) cp.setReview = undefined;
    cp.setReviewGroups ??= {};
    if (cp.images.length && assetIds.every(Boolean) && !cp.setReview) {
      // Overlap one image between groups so every adjacent page boundary is checked.
      const groups: string[] = [];
      for (let start = 0; start < cp.images.length; start += 11) {
        const key = `SET_REVIEW:${start}`;
        groups.push(key);
        const reviewImages = cp.images.slice(start, start + 12);
        const groupAssets = reviewImages.map(image => image.assetId!);
        const saved = cp.setReviewGroups[key];
        if (!saved || JSON.stringify(saved.assetIds) !== JSON.stringify(groupAssets)) {
          if (saved) { delete cp.setReviewGroups[key]; delete cp.requests![key]; }
          try {
            const groupImages = await Promise.all(reviewImages.map(image => imageData(image.assetId!, projectId)));
            // Full-plan visual checks need the same bounded wait as planning; timeout still requires explicit retry.
            await requestOnce(key, requestId => invokeStructured({ ...textSettings(input.providerSnapshot || {}), apiKey, baseUrl: provider.baseUrl, model: input.analysisModelId || input.planningModelId, schema: setReviewSchema, system: `你是整套页面检查模型。只返回 JSON。标题同义改写、标点和换行差异不算缺陷；只检查意思丢失、错误参数或不可读文字。依据plan.contentCoverage和逐屏copy检查实际图片的信息覆盖、商品一致性、重复构图、文字与连续性。imageOrder 给出本组图片的全套 sectionIndex，issues.sectionIndexes 必须引用这些全套下标。超过12张时分组检查，本组看不到的图片不要猜测。视觉统一不能以删除内容换取；只有内容错误、遮挡或不可读才指出具体问题。不删除图片，不要求全套改成纯色背景。${confirmedAnswerCopyRules}缺少内部来源说明不算图片缺陷。`, input: JSON.stringify({ plan: cp.plan, artDirection: cp.artDirection, imageOrder: reviewImages.map((image, index) => ({ sectionIndex: start + index, title: image.title })) }), images: groupImages, timeoutMs: 180000, maxAttempts: 1, requestId, monitor: { projectId, runId, operation: "v4_set_review" } }), result => { cp.setReviewGroups![key] = { assetIds: groupAssets, result }; });
          } catch (error) {
            if (error instanceof RunHalted) throw error;
            cp.lastError = { stage: "SET_REVIEW", code: isTimeout(error) ? "TIMEOUT" : "REVIEW_FAILED", message: requestErrorMessage(error, "整套检查未完成，图片已保留，请人工核对。"), retryable: false }; await persist();
          }
        }
        if (start + 12 >= cp.images.length) break;
      }
      if (groups.every(key => JSON.stringify(cp.setReviewGroups![key]?.assetIds) === JSON.stringify(assetIds.slice(Number(key.split(":")[1]), Number(key.split(":")[1]) + 12)))) {
        const results = groups.map(key => cp.setReviewGroups![key].result);
        cp.setReview = { passed: results.every(result => result.passed && !result.issues.length), issues: results.flatMap(result => result.issues) };
        cp.setReviewAssetIds = assetIds;
      }
    }
    await end("SET_REVIEW");
    const complete = checksComplete(cp);
    const reviewPending = cp.images.some(image => image.assetId && !image.check) || !cp.setReview;
    cp.retryAuthorized = [];
    if (complete || hasResolvedReviewError(cp)) cp.lastError = undefined;
    cp.stage = complete ? "COMPLETED" : "PARTIAL";
    cp.taskTiming = touchTiming(cp.taskTiming!, true);
    await lease.transaction(async tx => { await tx.detailRun.update({ where: { id: runId }, data: {
      status: complete ? "COMPLETED" : "PARTIAL", stage: complete ? "生成与检查已完成" : cp.images.some(image => !image.assetId) ? "部分图片未完成，已保留成功结果" : reviewPending ? "图片已生成，质量检查未完成" : "图片已生成，部分需人工检查",
      error: cp.lastError?.message ?? null, checkpoint: json(cp),
    } }); });
  } catch (error) {
    if (error instanceof RunHalted) {
      cp.taskTiming = touchTiming(cp.taskTiming!, true);
      await persist().catch(() => undefined); // A canceled owner can finish timing; a lost lease cannot write.
      return;
    }
    cp.taskTiming = touchTiming(cp.taskTiming!, true);
    cp.lastError = { stage: cp.stage, code: isStructuredSchemaRejection(error) ? "PROVIDER_SCHEMA_REJECTED" : isTimeout(error) ? "TIMEOUT" : "WORKFLOW_FAILED", message: requestErrorMessage(error, "当前步骤未完成，草稿和已生成的图片已保留。"), retryable: isStructuredSchemaRejection(error) };
    await persistQueue.catch(() => undefined);
    try { await lease.transaction(async tx => { await tx.detailRun.update({ where: { id: runId }, data: { status: cp.images.some(i => i.assetId) ? "PARTIAL" : "FAILED", stage: `「${cp.stage}」阶段未完成，草稿已保留`, error: cp.lastError!.message, checkpoint: json(cp) } }); }); } catch (failure) { if (!(failure instanceof RunHalted)) throw failure; }
  } finally {
    await persistQueue.catch(() => undefined);
    await lease.release();
  }
}
