import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { ImageGenerationResult, ImageTaskLifecycle } from "@/lib/ai/provider-client";
import { imageOutcome } from "@/lib/tasks/image-outcome";
import { readTaskTiming, startTiming, touchTiming } from "@/lib/tasks/timing";
import { assetPublicUrl, saveGeneratedImage } from "@/lib/storage/asset-manager";
import { getProviderAdapter, type ProviderSnapshot } from "./provider-service";
import { assertTaskNotCanceled } from "./task-service";

type Recovery = { model: string; prompt: string; copy: string; baseImageAssetId: string | null; metadata?: Record<string, unknown>; title?: string; pageNumber?: number };
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function patchOutput(taskId: string, patch: Record<string, unknown>) {
  return prisma.$transaction(async tx => {
    const task = await tx.generationTask.findUniqueOrThrow({ where: { id: taskId } });
    // Receipts from accepted requests must survive stop and HTTP disconnect.
    return tx.generationTask.update({ where: { id: taskId }, data: { outputPayload: json({ ...record(task.outputPayload), ...patch }) } });
  });
}
export const prepareImageRecovery = (taskId: string, recovery: Recovery) => patchOutput(taskId, { imageRecovery: recovery, imagePhase: "prepared" });
export function imageTaskLifecycle(taskId: string): ImageTaskLifecycle {
  return {
    beforeSubmit: async () => {
      await assertTaskNotCanceled(taskId);
      await patchOutput(taskId, { imagePhase: "submitted" });
    },
    onUpstreamTask: async upstreamImageTask => { await patchOutput(taskId, { upstreamImageTask }); },
  };
}
export async function trackedImageRequest<T>(taskId: string, execute: () => Promise<T>) {
  try { return await execute(); }
  catch (error) {
    const task = await prisma.generationTask.findUniqueOrThrow({ where: { id: taskId } });
    const output = record(task.outputPayload);
    await patchOutput(taskId, { imageOutcome: imageOutcome(error, output.upstreamImageTask, output.imagePhase === "submitted") });
    throw error;
  }
}

/** Explicit query-only recovery: never plans, uploads, probes, or POSTs to an image endpoint. */
export async function queryImageTask(taskId: string) {
  const initial = await prisma.generationTask.findUniqueOrThrow({ where: { id: taskId } });
  const input = record(initial.inputPayload), output = record(initial.outputPayload);
  if (output.imageAssetId) return initial;
  const recovery = output.imageRecovery as Recovery | undefined;
  const receipt = output.upstreamImageTask;
  if (!recovery || !input.providerSnapshot || receipt?.protocol !== "evolink_tasks" || !receipt.id || receipt.status === "failed") throw new Error("此记录没有可查询的上游任务编号。请核对服务端记录；不会自动重新提交。");
  // Resolve credentials before claiming work. The saved provider/protocol/model stay fixed.
  const { adapter } = await getProviderAdapter(undefined, input.providerSnapshot as ProviderSnapshot);
  const owner = randomUUID(), leaseMs = 240000;
  const claimed = await prisma.$transaction(async tx => {
    const task = await tx.generationTask.findUniqueOrThrow({ where: { id: taskId } });
    const saved = record(task.outputPayload);
    if (saved.imageAssetId) return false;
    if ((saved.queryOwner && saved.queryUntil > Date.now()) || (["PENDING", "RUNNING"].includes(task.status) && Date.now() - task.updatedAt.getTime() < leaseMs)) throw new Error("此任务仍在执行或查询中，请等待当前请求完成。");
    await tx.generationTask.update({ where: { id: taskId }, data: { outputPayload: json({ ...saved, queryOwner: owner, queryUntil: Date.now() + leaseMs, taskTiming: startTiming(readTaskTiming(saved.taskTiming)) }) } });
    return true;
  });
  if (!claimed) return prisma.generationTask.findUniqueOrThrow({ where: { id: taskId } });
  const owned = async (tx: Prisma.TransactionClient) => {
    const task = await tx.generationTask.findUniqueOrThrow({ where: { id: taskId } });
    const saved = record(task.outputPayload);
    if (saved.queryOwner !== owner || saved.queryUntil < Date.now()) throw new Error("查询所有权已失效，请刷新任务。");
    return { task, saved };
  };
  try {
    // A result may already be local if the process stopped before its version commit.
    const assets = await prisma.productAsset.findMany({ where: { projectId: initial.projectId, sectionId: initial.sectionId, type: "GENERATED" } });
    let asset = assets.find(asset => record(asset.metadata).recoveryTaskId === taskId);
    if (!asset) {
      const result: ImageGenerationResult = await adapter.generateImageOnce({
        model: recovery.model, prompt: recovery.prompt, upstreamTask: receipt, timeoutMs: 180000,
        monitor: { projectId: initial.projectId, sectionId: initial.sectionId ?? undefined, operation: "query_image_task" },
        onUpstreamTask: async upstreamImageTask => {
          await prisma.$transaction(async tx => { const { saved } = await owned(tx); await tx.generationTask.update({ where: { id: taskId }, data: { outputPayload: json({ ...saved, upstreamImageTask }) } }); });
        },
        beforeSubmit: async () => { throw new Error("恢复操作只允许查询已有任务。"); },
      });
      await prisma.$transaction(owned);
      asset = await saveGeneratedImage({ projectId: initial.projectId, sectionId: initial.sectionId, prompt: recovery.prompt, source: result, metadata: { ...recovery.metadata, usedModel: recovery.model, recoveryTaskId: taskId } });
    }
    return await prisma.$transaction(async tx => {
      const { task, saved } = await owned(tx);
      let versionId: string | undefined;
      if (task.sectionId) {
        const section = await tx.pageSection.findUniqueOrThrow({ where: { id: task.sectionId } });
        // A delayed result becomes a historical version if newer work already changed the section.
        const activate = task.status !== "CANCELED" && section.currentImageAssetId === recovery.baseImageAssetId;
        const existingVersion = await tx.sectionVersion.findFirst({ where: { sectionId: task.sectionId, imageAssetId: asset.id } });
        const latest = existingVersion ? null : await tx.sectionVersion.findFirst({ where: { sectionId: task.sectionId }, orderBy: { versionNumber: "desc" } });
        if (activate) await tx.sectionVersion.updateMany({ where: { sectionId: task.sectionId }, data: { isActive: false } });
        const version = existingVersion
          ? await tx.sectionVersion.update({ where: { id: existingVersion.id }, data: { isActive: activate || section.currentImageAssetId === asset.id } })
          : await tx.sectionVersion.create({ data: { sectionId: task.sectionId, versionNumber: (latest?.versionNumber ?? 0) + 1, imageAssetId: asset.id, promptSnapshot: { prompt: recovery.prompt }, copySnapshot: { copy: recovery.copy }, isActive: activate } });
        versionId = version.id;
        if (activate) await tx.pageSection.update({ where: { id: task.sectionId }, data: { currentImageAssetId: asset.id, status: "SUCCESS" } });
      }
      return tx.generationTask.update({ where: { id: taskId }, data: {
        status: task.status === "CANCELED" ? "CANCELED" : "SUCCESS", errorMessage: null, completedAt: new Date(),
        outputPayload: json({ ...saved, imageAssetId: asset.id, imageUrl: assetPublicUrl(asset), versionId, usedModel: recovery.model, imageOutcome: null, queryOwner: null, queryUntil: null, taskTiming: touchTiming(readTaskTiming(saved.taskTiming)!, true) }),
      } });
    });
  } catch (error) {
    await prisma.$transaction(async tx => {
      const task = await tx.generationTask.findUniqueOrThrow({ where: { id: taskId } }), saved = record(task.outputPayload);
      if (saved.queryOwner !== owner) return;
      await tx.generationTask.update({ where: { id: taskId }, data: { outputPayload: json({ ...saved, queryOwner: null, queryUntil: null, imageOutcome: imageOutcome(error, saved.upstreamImageTask), taskTiming: touchTiming(readTaskTiming(saved.taskTiming)!, true) }) } });
    });
    throw error;
  }
}
