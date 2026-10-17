import { z } from "zod";
import { startTiming, touchTiming } from "@/lib/tasks/timing";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { assetPublicUrl } from "@/lib/storage/asset-manager";
import { runWithProviderCredentials, type RequestProviderCredentials } from "@/lib/services/provider-runtime";
import { createDetailRun, controlDetailRun, getDetailRun } from "./service";
import { detailRunInputSchema } from "./contracts";
import { contentLanguageOptions, type ContentLanguage } from "@/lib/utils/content-language";
import { prepareTranslationProject, translationProjectId, translationTaskId, getTranslationTask, runTranslationProject } from "@/lib/translation/service";
import { translationSummary } from "@/lib/translation/contracts";
import { isStyleReference } from "@/lib/utils/asset-purpose";

export const batchInputSchema = z.object({
  id: z.string().uuid(),
  projectIds: z.array(z.string().min(1)).min(1).max(50).refine(ids => new Set(ids).size === ids.length),
  options: detailRunInputSchema.pick({ language: true, quality: true, heroCount: true, detailCount: true }),
  translations: z.array(z.enum(contentLanguageOptions)).min(1).max(10).refine(values => new Set(values).size === values.length).optional(),
  translationInstruction: z.string().max(4000).optional(),
});
type BatchInput = z.infer<typeof batchInputSchema> & { workflow: "detail-batch-v1" };
type Item = { projectId: string; sourceProjectId?: string; language?: ContentLanguage; runId?: string; translationTaskId?: string; status: string; message: string };
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const state = globalThis as typeof globalThis & { detailBatchWorkers?: Set<string> };
const workers = state.detailBatchWorkers ??= new Set();
const systemId = "mxpage-detail-batch-system";
const pause = () => new Promise(resolve => setTimeout(resolve, 500));

async function findBatch(id: string) {
  const task = await prisma.generationTask.findUniqueOrThrow({ where: { id } });
  if ((task.inputPayload as unknown as BatchInput)?.workflow !== "detail-batch-v1") throw new Error("批量任务不存在。");
  return task;
}
export async function getBatch(id: string) {
  let task = await findBatch(id);
  if (["PENDING", "RUNNING"].includes(task.status) && task.updatedAt.getTime() < Date.now() - 60000) {
    await prisma.generationTask.updateMany({ where: { id, status: task.status, updatedAt: task.updatedAt }, data: { status: "FAILED", errorMessage: "任务已中断，点击继续可恢复未完成商品。" } });
    task = await findBatch(id);
  }
  const items = (task.outputPayload as unknown as { items: Item[] }).items;
  // Read status first so COMPLETED never accompanies an older image snapshot.
  const runs = await prisma.detailRun.findMany({ where: { id: { in: items.flatMap(i => !i.language && i.runId ? [i.runId] : []) } } });
  const translations = await Promise.all(items.map(item => item.language ? getTranslationTask(translationTaskId(id, item.projectId)) : null));
  const projects = await prisma.project.findMany({ where: { id: { in: items.flatMap(i => [i.projectId, ...(i.sourceProjectId ? [i.sourceProjectId] : [])]) } }, include: { assets: { where: { type: { in: ["MAIN", "ANGLE", "DETAIL", "REFERENCE"] } }, select: { metadata: true } }, sections: { orderBy: { order: "asc" }, include: { currentImageAsset: true } } } });
  const visibleItems = items.map((item, index) => {
    const project = projects.find(p => p.id === item.projectId);
    const run = runs.find(r => r.id === item.runId);
    const translation = translations[index];
    if (translation) return { ...item, ready: Boolean(project), status: translation.status === "SUCCESS" ? "COMPLETED" : translation.status, message: translation.errorMessage || translation.progress.message, name: project?.name || "翻译作品", translationProgress: translationSummary(translation.progress.images), failures: translation.progress.images.filter(image => image.error).map(image => ({ title: image.title, message: image.error })), images: project?.sections.filter(s => s.currentImageAsset).map(s => ({ id: s.id, type: s.type, url: assetPublicUrl(s.currentImageAsset) })) || [] };
    if (item.language) {
      const source = projects.find(p => p.id === item.sourceProjectId);
      return { ...item, ready: Boolean(project), status: item.status === "RUNNING" && ["FAILED", "CANCELED"].includes(task.status) ? "INTERRUPTED" : item.status, name: project?.name || source?.name || "翻译作品", translationProgress: { completed: 0, failed: 0, total: source?.assets.filter(a => !isStyleReference(a)).length || 0 }, images: [] };
    }
    return { ...item, ready: Boolean(project), status: run?.status || (item.status === "RUNNING" && ["FAILED", "CANCELED"].includes(task.status) ? "INTERRUPTED" : item.status), message: run?.stage || item.message, name: project?.name || projects.find(p => p.id === item.sourceProjectId)?.name || "商品已删除", images: project?.sections.filter(s => s.currentImageAsset).map(s => ({ id: s.id, type: s.type, url: assetPublicUrl(s.currentImageAsset) })) || [] };
  });
  const allDone = visibleItems.every(i => i.status === "COMPLETED");
  return { id, status: allDone ? "SUCCESS" : task.status, error: allDone ? null : task.errorMessage, items: visibleItems };
}
export async function startBatch(raw: unknown, credentials: RequestProviderCredentials) {
  const parsed = batchInputSchema.parse(raw);
  const input: BatchInput = { ...parsed, workflow: "detail-batch-v1" };
  const existing = await prisma.generationTask.findUnique({ where: { id: input.id } });
  if (existing) {
    if (JSON.stringify(existing.inputPayload) !== JSON.stringify(input)) throw new Error("此批次标识已用于其他配置。");
    return getBatch(input.id);
  }
  const projects = await prisma.project.findMany({ where: { id: { in: input.projectIds } }, include: { assets: { where: { type: { in: ["MAIN", "ANGLE", "DETAIL", "REFERENCE"] } } } } });
  const maxAssets = input.translations ? 30 : 8;
  if (projects.length !== input.projectIds.length || projects.some(p => { const count = p.assets.filter(a => !isStyleReference(a)).length; return count < 1 || count > maxAssets; })) throw new Error(`每套须上传 1–${maxAssets} 张素材后再开始。`);
  await prisma.project.upsert({ where: { id: systemId }, create: { id: systemId, name: "详情页批量任务", platform: "__mxpage_system_task__", style: "system" }, update: {} });
  try {
    const items: Item[] = input.projectIds.flatMap(sourceId => input.translations ? input.translations.map(language => ({ projectId: translationProjectId(input.id, sourceId, language), sourceProjectId: sourceId, language, status: "QUEUED", message: "等待翻译" })) : [{ projectId: sourceId, status: "QUEUED", message: "等待生成" }]);
    await prisma.generationTask.create({ data: { id: input.id, projectId: systemId, taskType: "BATCH_CREATE", inputPayload: json(input), outputPayload: json({ items }) } });
  } catch (error) {
    if (!await prisma.generationTask.findUnique({ where: { id: input.id } })) throw error;
    return startBatch(raw, credentials);
  }
  launch(input.id, credentials);
  return getBatch(input.id);
}
export async function controlBatch(id: string, action: "cancel" | "resume", credentials: RequestProviderCredentials, retryFailed = false) {
  const task = await findBatch(id);
  const items = (task.outputPayload as unknown as { items: Item[] }).items;
  if (action === "cancel") {
    await prisma.generationTask.updateMany({ where: { id, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "CANCELED" } });
    for (const item of items.filter(i => i.runId && i.status === "RUNNING")) await controlDetailRun(item.projectId, item.runId!, "cancel", {}, credentials);
  } else {
    await getBatch(id);
    if (workers.has(id)) throw new Error("当前批次仍在结束，请稍后再继续。");
    const claimed = await prisma.generationTask.updateMany({ where: { id, status: { in: ["FAILED", "CANCELED"] } }, data: { status: "PENDING", errorMessage: null } });
    if (claimed.count) launch(id, credentials, retryFailed);
  }
  return getBatch(id);
}
function launch(id: string, credentials: RequestProviderCredentials, retryFailed = false) {
  if (workers.has(id)) return;
  workers.add(id);
  void runWithProviderCredentials(credentials, () => execute(id, credentials, retryFailed)).catch(() => {
    console.error("Batch worker stopped; its saved checkpoint can be recovered.");
  }).finally(() => workers.delete(id));
}
async function execute(id: string, credentials: RequestProviderCredentials, retryFailed: boolean) {
  const previous = await findBatch(id);
  const startedAt = new Date(Math.max(Date.now(), (previous.startedAt?.getTime() || 0) + 1));
  const previousOutput = previous.outputPayload as unknown as { items: Item[]; taskTiming?: unknown };
  let taskTiming = startTiming(previousOutput.taskTiming, startedAt.getTime());
  const claimed = await prisma.generationTask.updateMany({ where: { id, status: "PENDING", updatedAt: previous.updatedAt }, data: { status: "RUNNING", startedAt, completedAt: null, outputPayload: json({ ...previousOutput, taskTiming }) } });
  if (!claimed.count) return;
  const task = await findBatch(id);
  const input = task.inputPayload as unknown as BatchInput;
  const items = (task.outputPayload as unknown as { items: Item[] }).items;
  let lost = false;
  const heartbeat = setInterval(() => { void prisma.generationTask.updateMany({ where: { id, status: "RUNNING", startedAt, updatedAt: { gte: new Date(Date.now() - 60000) } }, data: { updatedAt: new Date() } }).then(result => { if (!result.count) lost = true; }).catch(() => { lost = true; }); }, 15000);
  const active = async () => {
    const current = await findBatch(id);
    return !lost && current.status === "RUNNING" && current.startedAt?.getTime() === startedAt.getTime() && current.updatedAt.getTime() >= Date.now() - 60000;
  };
  const save = async () => {
    taskTiming = touchTiming(taskTiming);
    const updated = await prisma.generationTask.updateMany({ where: { id, startedAt, status: { in: ["RUNNING", "CANCELED"] } }, data: { outputPayload: json({ items, taskTiming }) } });
    if (!updated.count) throw new Error("批次已由其他请求接管，请刷新查看进度。");
  };
  const cancelChildIfStopped = async (projectId: string, runId: string) => {
    const current = await findBatch(id);
    if (current.status === "CANCELED" && current.startedAt?.getTime() === startedAt.getTime()) await controlDetailRun(projectId, runId, "cancel", {}, credentials);
  };
  try {
    for (const item of items) {
      if (!await active()) break;
      if (item.status === "COMPLETED" || (!item.language && (["PARTIAL", "WAITING_INPUT"].includes(item.status) || (item.status === "FAILED" && item.runId)))) continue;
      try {
        item.status = "RUNNING"; item.message = item.language ? "准备独立语言版本" : "理解商品并规划详情页"; await save();
        if (item.sourceProjectId && item.language) {
          await prepareTranslationProject(item.projectId, item.sourceProjectId, item.language, input.options.quality);
          if (!await active()) break;
          item.translationTaskId = translationTaskId(id, item.projectId); item.runId = undefined; await save();
          const translated = await runTranslationProject({ batchId: id, projectId: item.projectId, language: item.language, quality: input.options.quality, instruction: input.translationInstruction || "", retryFailed, active });
          item.status = translated?.status === "SUCCESS" ? "COMPLETED" : translated?.status || "FAILED";
          item.message = translated?.errorMessage || translated?.progress.message || "翻译未完成";
          await save();
          continue;
        }
        if (!await active()) break;
        // Deterministic child key recovers a run even if the parent crashed before saving its id.
        const key = `batch:${id}`;
        const known = await prisma.detailRun.findUnique({ where: { projectId_idempotencyKey: { projectId: item.projectId, idempotencyKey: key } } });
        let run = known ? await getDetailRun(item.projectId, known.id) : await createDetailRun(item.projectId, { ...input.options, idempotencyKey: key }, credentials);
        if (!run) throw new Error("子任务未创建。");
        item.runId = run.id; await save();
        if (!await active()) { await cancelChildIfStopped(item.projectId, run.id); break; }
        if (["INTERRUPTED", "CANCELED"].includes(run.status)) run = await controlDetailRun(item.projectId, run.id, "resume", {}, credentials);
        while (run && ["PENDING", "RUNNING"].includes(run.status)) {
          if (!await active()) { await cancelChildIfStopped(item.projectId, run.id); break; }
          item.message = run.stage; await save(); await pause();
          run = await getDetailRun(item.projectId, run.id);
        }
        if (!await active()) break;
        item.status = run?.status || "FAILED";
        item.message = run?.stage || "子任务不可用";
      } catch (error) {
        item.status = "FAILED";
        item.message = error instanceof Error ? error.message : "生成失败，请打开商品处理";
      }
      await save();
    }
    if (await active()) {
      const complete = items.every(i => i.status === "COMPLETED");
      await prisma.generationTask.updateMany({ where: { id, status: "RUNNING", startedAt }, data: { status: complete ? "SUCCESS" : "FAILED", completedAt: new Date(), errorMessage: complete ? null : input.translations ? "已保存成功译图。可继续未开始的图片，或手动重试失败图片。" : "批次已处理，部分商品需要补充信息或检查，请打开对应作品。" } });
    }
  } finally {
    clearInterval(heartbeat);
    taskTiming = touchTiming(taskTiming, true);
    await prisma.generationTask.updateMany({ where: { id, startedAt }, data: { outputPayload: json({ items, taskTiming }) } });
    // This worker may only finish its own claim, even when error handling fails.
    await prisma.generationTask.updateMany({ where: { id, status: "RUNNING", startedAt }, data: { status: "FAILED", errorMessage: "批次已暂停，已有结果已保留，可继续处理未完成任务。" } });
  }
}
