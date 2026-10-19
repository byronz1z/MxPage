import { selectModel } from "@/lib/ai/model-selection";
import { createHash } from "crypto";
import { prisma } from "@/lib/db/prisma";
import { readStorageFile, saveUploadAsset } from "@/lib/storage/asset-manager";
import { contentLanguageLabels, type ContentLanguage } from "@/lib/utils/content-language";
import { isStyleReference } from "@/lib/utils/asset-purpose";
import { getProviderAdapter, snapshotProvider, type ProviderSnapshot } from "@/lib/services/provider-service";
import { saveGeneratedImage } from "@/lib/storage/asset-manager";
import { Prisma } from "@prisma/client";
import { startTiming, touchTiming } from "@/lib/tasks/timing";
import type { ImageGenerationRequest } from "@/lib/ai/provider-client";
import { buildTranslationPrompt, translationRules } from "./prompt";
import { assertNoDetailRun } from "@/lib/detail-runs/lock";
import { TRANSLATION_WORKFLOW, translationSummary, type TranslationImage, type TranslationProgress } from "./contracts";
import { requestErrorMessage } from "@/lib/utils/request-error";

export const translationProjectId = (batchId: string, sourceId: string, language: string) => `translation-${createHash("sha256").update(`${batchId}:${sourceId}:${language}`).digest("hex").slice(0, 32)}`;

// Each language owns its asset files, so deleting one result cannot delete originals.
export async function prepareTranslationProject(id: string, sourceId: string, language: ContentLanguage, quality: string) {
  const existing = await prisma.project.findUnique({ where: { id } });
  if ((existing?.modelSnapshot as any)?.translationReady) return;
  const source = await prisma.project.findUniqueOrThrow({ where: { id: sourceId }, include: { assets: { where: { type: { in: ["MAIN", "ANGLE", "DETAIL", "REFERENCE"] } }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } } });
  if (typeof (source.modelSnapshot as { trashedAt?: unknown } | null)?.trashedAt === "string") throw new Error("原作品已在回收站，请先还原。");
  source.assets = source.assets.filter(a => !isStyleReference(a));
  if (!source.assets.length || source.assets.length > 30) throw new Error("每套翻译需要 1–30 张原图。");
  await prisma.project.upsert({ where: { id }, create: { id, name: `${source.name} · ${contentLanguageLabels[language]}`, platform: source.platform, style: source.style, description: source.description }, update: {} });
  for (const [order, original] of source.assets.entries()) {
    let asset = id === sourceId
      ? await prisma.productAsset.update({ where: { id: original.id }, data: { type: "DETAIL", sortOrder: order } })
      : await prisma.productAsset.findFirst({ where: { projectId: id, sortOrder: order, type: "DETAIL" } });
    if (!asset) asset = await saveUploadAsset({ projectId: id, type: "DETAIL", fileName: original.fileName, mimeType: original.mimeType, fileBuffer: await readStorageFile(original.filePath), sortOrder: order });
    await prisma.pageSection.upsert({ where: { projectId_sectionKey: { projectId: id, sectionKey: `translation-${order}` } }, create: { projectId: id, sectionKey: `translation-${order}`, type: "CUSTOM", title: original.fileName, goal: "翻译原图文字", copy: "", visualPrompt: translationRules, order, editableData: { translationSourceAssetId: asset.id } }, update: {} });
  }
  await prisma.project.update({ where: { id }, data: { modelSnapshot: { ...(existing?.modelSnapshot as Record<string, Prisma.InputJsonValue> || {}), translationReady: true, workType: "translation", translationSourceProjectId: sourceId, previewConfig: { contentLanguage: language, quality, heroImageCount: 0, detailSectionCount: source.assets.length } } } });
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const translationTaskId = (batchId: string, projectId: string) => `translate:${batchId}:${projectId}`;
export async function getTranslationTask(id: string) {
  let task = await prisma.generationTask.findUnique({ where: { id } });
  if (!task || (task.inputPayload as any)?.workflow !== TRANSLATION_WORKFLOW) return null;
  if (task.status === "RUNNING" && task.updatedAt.getTime() < Date.now() - 60000) {
    const progress = task.outputPayload as unknown as TranslationProgress;
    for (const image of progress.images) if (image.status === "RUNNING") { image.status = "UNCERTAIN"; image.error = "上次请求已中断，结果不确定；手动重试可能再次计费。"; }
    progress.message = translationSummary(progress.images).message;
    await prisma.generationTask.updateMany({ where: { id, status: "RUNNING", updatedAt: task.updatedAt }, data: { status: "FAILED", outputPayload: json(progress), errorMessage: "翻译已中断，已保存的结果可继续查看，请在批次页面恢复。" } });
    task = await prisma.generationTask.findUniqueOrThrow({ where: { id } });
  }
  return { ...task, progress: task.outputPayload as unknown as TranslationProgress };
}

export async function runTranslationProject(options: {
  batchId: string; projectId: string; language: ContentLanguage;
  quality: ImageGenerationRequest["quality"]; instruction: string;
  retryFailed?: boolean; active: () => Promise<boolean>;
}) {
  const { projectId } = options;
  const id = translationTaskId(options.batchId, projectId);
  const sections = await prisma.pageSection.findMany({ where: { projectId }, orderBy: { order: "asc" }, include: { currentImageAsset: true } });
  const sources = await prisma.productAsset.findMany({ where: { projectId, type: "DETAIL" } });
  const images: TranslationImage[] = sections.filter(section => (section.editableData as any)?.translationSourceAssetId).map(section => ({
    sectionId: section.id, sourceAssetId: (section.editableData as any).translationSourceAssetId, title: section.title, status: "QUEUED", attempts: 0,
  }));
  if (!images.length) throw new Error("没有可翻译的原图，请重新上传图片。");
  const previousTask = await prisma.generationTask.findUnique({ where: { id } });
  const savedInput = previousTask?.inputPayload as { providerSnapshot?: ProviderSnapshot; modelId?: string } | undefined;
  const context = await getProviderAdapter(savedInput?.providerSnapshot?.id, savedInput?.providerSnapshot, { textModelIds: [], legacyTextProtocol: Boolean(previousTask && !savedInput?.providerSnapshot) });
  const modelId = savedInput?.modelId || selectModel(context.provider.models, "edit");
  const providerSnapshot = savedInput?.providerSnapshot || snapshotProvider(context.provider);
  const existing = await prisma.generationTask.upsert({ where: { id }, create: { id, projectId, taskType: "TRANSLATE_PAGE", inputPayload: json({ workflow: TRANSLATION_WORKFLOW, providerSnapshot, modelId, batchId: options.batchId, language: options.language, quality: options.quality, instruction: options.instruction }), outputPayload: json({ images, message: "等待翻译" }) }, update: {} });
  if (existing.status === "SUCCESS") return getTranslationTask(id);
  if (existing.status === "RUNNING" && existing.updatedAt.getTime() > Date.now() - 60000) throw new Error("翻译请求仍在结束，请稍后再继续。");
  await assertNoDetailRun(projectId);
  const progress = existing.outputPayload as unknown as TranslationProgress;
  const savedAssets = await prisma.productAsset.findMany({ where: { projectId, type: "GENERATED" }, orderBy: { createdAt: "desc" } });
  // Reconcile saved results after a crash between asset persistence and checkpoint persistence.
  for (const image of progress.images) {
    const section = sections.find(section => section.id === image.sectionId);
    const matches = (asset: { metadata: unknown }) => (asset.metadata as any)?.translationTaskId === id && (asset.metadata as any)?.sourceAssetId === image.sourceAssetId;
    const saved = section?.currentImageAsset && matches(section.currentImageAsset) ? section.currentImageAsset : savedAssets.find(matches);
    if (saved) {
      image.status = "COMPLETED"; image.assetId = saved.id; image.error = undefined;
    } else if (image.status === "RUNNING") {
      image.status = "UNCERTAIN"; image.error = "上次请求已中断，结果不确定；手动重试可能再次计费。";
    }
    const queryExisting = image.upstreamTask && image.upstreamTask.status !== "failed";
    if ((queryExisting || options.retryFailed) && ["FAILED", "UNCERTAIN"].includes(image.status)) {
      image.status = "QUEUED"; image.error = undefined;
      if (!queryExisting) image.upstreamTask = undefined;
    }
  }
  const startedAt = new Date(Math.max(Date.now(), (existing.startedAt?.getTime() || 0) + 1));
  progress.taskTiming = startTiming(progress.taskTiming, startedAt.getTime());
  const claimed = await prisma.generationTask.updateMany({ where: { id, status: existing.status, updatedAt: existing.updatedAt }, data: { status: "RUNNING", startedAt, completedAt: null, errorMessage: null, outputPayload: json(progress) } });
  if (!claimed.count) throw new Error("翻译任务正在由另一请求处理。");
  let writes = Promise.resolve();
  let lost = false;
  class TranslationOwnershipLost extends Error {}
  const owned = () => ({ id, status: "RUNNING" as const, startedAt, updatedAt: { gte: new Date(Date.now() - 60000) } });
  const transaction = async (work: (tx: Prisma.TransactionClient) => Promise<void>) => {
    if (lost) throw new TranslationOwnershipLost("翻译任务已暂停，请查看已保存的结果。");
    await prisma.$transaction(async tx => {
      const lock = await tx.generationTask.updateMany({ where: owned(), data: { updatedAt: new Date() } });
      if (!lock.count) { lost = true; throw new TranslationOwnershipLost("翻译任务已暂停，请查看已保存的结果。"); }
      await work(tx);
    });
  };
  const save = () => {
    progress.taskTiming = touchTiming(progress.taskTiming!);
    progress.message = translationSummary(progress.images).message;
    const snapshot = json(progress);
    writes = writes.then(() => transaction(async tx => { await tx.generationTask.update({ where: { id }, data: { outputPayload: snapshot } }); }));
    return writes;
  };
  const heartbeat = setInterval(() => {
    writes = writes.then(() => transaction(async () => {}));
    void writes.catch(() => { lost = true; });
  }, 15000);
  try {
    await transaction(async tx => {
      for (const image of progress.images.filter(image => image.status === "COMPLETED" && image.assetId)) {
        await tx.pageSection.update({ where: { id: image.sectionId }, data: { currentImageAssetId: image.assetId, status: "SUCCESS" } });
      }
    });
    const { adapter } = context;
    const model = { modelId };
    const prompt = buildTranslationPrompt(options.language, options.instruction);
    const pending = progress.images.filter(image => image.status === "QUEUED");
    let index = 0;
    let endpointUnavailable = false;
    const worker = async () => {
      while (index < pending.length) {
        const image = pending[index++];
        if (lost || endpointUnavailable || !await options.active()) return;
        let sent = false;
        try {
          const sourceAsset = sources.find(asset => asset.id === image.sourceAssetId);
          if (!sourceAsset) throw new Error("原图文件不存在，请重新上传。");
          const bytes = await readStorageFile(sourceAsset.filePath);
          image.status = "RUNNING"; if (!image.upstreamTask) image.attempts++; image.error = undefined;
          await save();
          await transaction(async tx => { await tx.pageSection.update({ where: { id: image.sectionId }, data: { status: "GENERATING" } }); });
          if (lost || endpointUnavailable || !await options.active()) { image.status = "QUEUED"; if (!image.upstreamTask) image.attempts--; await save(); return; }
          sent = true;
          const source = await adapter.generateImageOnce({ model: model.modelId, prompt, referenceImages: [`data:${sourceAsset.mimeType || "image/png"};base64,${bytes.toString("base64")}`], size: "auto", quality: options.quality, timeoutMs: 180000, monitor: { projectId, sectionId: image.sectionId, runId: id, operation: "translate_image" },
            upstreamTask: image.upstreamTask,
            onUpstreamTask: async task => { image.upstreamTask = task; await save(); },
            beforeSubmit: async () => {
              await transaction(async () => {});
              if (endpointUnavailable || !await options.active()) throw new TranslationOwnershipLost("翻译任务已停止，未提交新图片请求。");
            },
          });
          const asset = await saveGeneratedImage({ projectId, sectionId: image.sectionId, prompt, source, metadata: { translationTaskId: id, sourceAssetId: image.sourceAssetId, language: options.language, usedModel: model.modelId } });
          await transaction(async tx => {
            const previous = await tx.sectionVersion.findFirst({ where: { sectionId: image.sectionId }, orderBy: { versionNumber: "desc" } });
            await tx.sectionVersion.updateMany({ where: { sectionId: image.sectionId }, data: { isActive: false } });
            await tx.sectionVersion.create({ data: { sectionId: image.sectionId, imageAssetId: asset.id, versionNumber: (previous?.versionNumber || 0) + 1, isActive: true, promptSnapshot: { prompt }, copySnapshot: { language: options.language } } });
            await tx.pageSection.update({ where: { id: image.sectionId }, data: { currentImageAssetId: asset.id, status: "SUCCESS" } });
          });
          image.assetId = asset.id; image.status = "COMPLETED";
        } catch (error) {
          if (lost || error instanceof TranslationOwnershipLost) throw error;
          if ((error as { code?: string })?.code === "IMAGE_ENDPOINT_UNAVAILABLE") endpointUnavailable = true;
          image.status = sent ? "UNCERTAIN" : "FAILED";
          image.error = requestErrorMessage(error, "图片翻译未完成，已保存的译图会保留。");
          await transaction(async tx => { await tx.pageSection.updateMany({ where: { id: image.sectionId }, data: { status: "FAILED" } }); });
        }
        await save();
      }
    };
    const results = await Promise.allSettled([worker(), worker()]);
    const failedWorker = results.find(result => result.status === "rejected");
    if (failedWorker?.status === "rejected") throw failedWorker.reason;
    const complete = progress.images.every(image => image.status === "COMPLETED");
    const status = complete ? "SUCCESS" : await options.active() ? "FAILED" : "CANCELED";
    await writes;
    progress.taskTiming = touchTiming(progress.taskTiming!, true);
    await transaction(async tx => {
      await tx.generationTask.update({ where: { id }, data: { status, completedAt: new Date(), outputPayload: json(progress), errorMessage: complete ? null : "已保存成功译图，剩余图片可继续或手动重试。" } });
      await tx.project.update({ where: { id: projectId }, data: { status: complete ? "COMPLETED" : "EDITING" } });
    });
  } catch (error) {
    await writes.catch(() => undefined);
    progress.taskTiming = touchTiming(progress.taskTiming!, true);
    await prisma.generationTask.updateMany({ where: { id, status: "RUNNING", startedAt }, data: { status: "FAILED", completedAt: new Date(), outputPayload: json(progress), errorMessage: requestErrorMessage(error, "翻译任务未完成，已有译图已保留。") } });
    throw error;
  } finally { clearInterval(heartbeat); await writes.catch(() => undefined); }
  return getTranslationTask(id);
}
