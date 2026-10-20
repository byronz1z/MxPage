import type { DetailRun, GenerationTask } from "@prisma/client";
import { projectTaskDuration, type TaskDuration } from "./timing";

export type QueueKind = "detail" | "translation" | "xhs" | "image" | "analysis" | "export" | "batch";
export type TaskQueueItem = Partial<TaskDuration> & {
  id: string; sourceId: string; source: "run" | "task" | "request";
  kind: QueueKind; title: string; status: string; message: string; href: string;
  projectId?: string; createdAt: string; updatedAt: string;
  completed: number; total: number; failed: number; unit: string; error?: string;
  pendingQuery?: number; uncertain?: number; canQueryImage?: boolean; imageUrl?: string;
};
export const queueKindLabels: Record<QueueKind, string> = { detail: "详情页", translation: "翻译", xhs: "小红书", image: "图片处理", analysis: "分析规划", export: "导出", batch: "批量创作" };
export const taskIsRunning = (item: Pick<TaskQueueItem, "status">) => ["PENDING", "RUNNING"].includes(item.status);
export const taskNeedsAttention = (item: Pick<TaskQueueItem, "status"> & Partial<Pick<TaskQueueItem, "failed">>) => ["WAITING_INPUT", "WAITING_PROMPTS", "PARTIAL", "FAILED", "INTERRUPTED", "PENDING_QUERY", "UNCERTAIN"].includes(item.status) || (item.failed ?? 0) > 0;
export const taskShouldShow = (item: Pick<TaskQueueItem, "status"> & Partial<Pick<TaskQueueItem, "failed">>) => taskIsRunning(item) || taskNeedsAttention(item);
export const taskStatusLabels: Record<string, string> = { PENDING: "等待执行", RUNNING: "处理中", WAITING_INPUT: "需要补充信息", WAITING_PROMPTS: "等待确认提示词", SUCCESS: "已完成", COMPLETED: "已完成", PARTIAL: "部分完成，需检查", FAILED: "已失败", INTERRUPTED: "已中断", CANCELED: "已停止", PENDING_QUERY: "待查询上游结果", UNCERTAIN: "结果未确认" };
const stages: Record<string, string> = { PREPARE: "准备商品资料", PLAN: "规划商品内容", INPUT_SUGGESTIONS: "推断商品补充选项", ART_DIRECTION: "设计整套分镜", GENERATE: "生成图片", IMAGE_REVIEW: "检查图片", SET_REVIEW: "检查整套页面", WAITING_INPUT: "等待补充信息", WAITING_PROMPTS: "等待确认提示词" };
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const list = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.map(record) : [];
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
type ProjectName = { project: { name: string; platform: string } };
export type QueueTaskRow = GenerationTask & ProjectName;
export type QueueRunRow = DetailRun & ProjectName;

/** Project only public task metadata; prompts, images and provider credentials never enter the feed. */
export function buildTaskQueue(tasks: QueueTaskRow[], runs: QueueRunRow[], now = Date.now()): TaskQueueItem[] {
  const parents = tasks.filter(task => record(task.inputPayload).workflow === "detail-batch-v1");
  const parentIds = new Set(parents.map(task => task.id));
  const childRunIds = new Set(parents.flatMap(task => list(record(task.outputPayload).items).map(item => item.runId)));
  const childTaskIds = new Set(parents.flatMap(task => list(record(task.outputPayload).items).map(item => item.translationTaskId)));
  for (const task of tasks) {
    const output = record(task.outputPayload);
    if (typeof output.currentTaskId === "string") childTaskIds.add(output.currentTaskId);
  }
  const items: TaskQueueItem[] = [];
  for (const run of runs) {
    if (childRunIds.has(run.id) || (run.idempotencyKey.startsWith("batch:") && parentIds.has(run.idempotencyKey.slice(6)))) continue;
    const input = record(run.input), cp = record(run.checkpoint), images = list(cp.images);
    const kind: QueueKind = input.mode === "xhs" ? "xhs" : input.mode === "translate" ? "translation" : ["edit", "regenerate"].includes(input.mode) ? "image" : "detail";
    const interrupted = taskIsRunning(run) && (!run.leaseUntil || run.leaseUntil.getTime() < now);
    const requests = Object.values(record(cp.requests)).map(record);
    const pendingQuery = requests.filter(r => r.state !== "completed" && r.state !== "succeeded" && r.upstreamTask?.id && r.upstreamTask.status !== "failed").length;
    const uncertain = requests.filter(r => ["uncertain", "running"].includes(r.state) && !r.upstreamTask?.id).length;
    const baseStatus = interrupted ? "INTERRUPTED" : run.status;
    const status = !taskIsRunning({ status: baseStatus }) && !["COMPLETED", "CANCELED", "WAITING_INPUT", "WAITING_PROMPTS"].includes(baseStatus) ? pendingQuery ? "PENDING_QUERY" : uncertain ? "UNCERTAIN" : baseStatus : baseStatus;
    const total = images.length || (["edit", "regenerate"].includes(input.mode) ? 1 : count(input.heroCount) + count(input.detailCount));
    items.push({ id: `run:${run.id}`, sourceId: run.id, source: "run", kind, projectId: run.projectId, title: run.project.name,
      status, message: ["PENDING_QUERY", "UNCERTAIN"].includes(status) ? taskStatusLabels[status] : interrupted ? "执行已中断，已保存当前进度" : stages[run.stage] || run.stage || taskStatusLabels[status],
      href: kind === "xhs" ? `/xiaohongshu?project=${run.projectId}` : `/projects/${run.projectId}/editor`,
      createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(),
      ...projectTaskDuration({ status, createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(), timing: cp.taskTiming }, now),
      completed: images.filter(image => image.assetId).length, total, pendingQuery, uncertain, failed: requests.filter(r => ["failed", "rejected"].includes(r.state) || r.upstreamTask?.status === "failed").length, unit: "张",
      error: run.error || record(cp.lastError).message || undefined });
  }
  for (const task of tasks) {
    const input = record(task.inputPayload), output = record(task.outputPayload);
    if (childTaskIds.has(task.id) || parentIds.has(input.batchId)) continue;
    const batch = input.workflow === "detail-batch-v1", translation = batch && Array.isArray(input.translations);
    const children = list(output.items).map(item => {
      const child = batch && !translation && item.runId ? runs.find(run => run.id === item.runId) : undefined;
      return child ? { ...item, status: child.status, message: child.stage } : item;
    }), images = list(output.images);
    const kind: QueueKind = translation || task.taskType === "TRANSLATE_PAGE" || input.editMode === "translate" ? "translation" : task.taskType === "XHS_GENERATE" ? "xhs" : batch || task.taskType === "BATCH_CREATE" ? "batch" : ["ANALYZE", "PLAN"].includes(task.taskType) ? "analysis" : task.taskType === "EXPORT" ? "export" : "image";
    const labels: Record<string, string> = { ANALYZE: "分析商品", PLAN: "规划页面", GENERATE: "生成图片", REGENERATE: "修改图片", EXPORT: "导出作品", BATCH_CREATE: "批量创作", TRANSLATE_PAGE: "翻译图片", XHS_GENERATE: "生成小红书图文", QA_CHECK: "检查图片" };
    // Display a stale worker as interrupted without restarting or mutating paid work.
    const heartbeatJob = batch || input.workflow === "image-translation-v1" || !!output.heartbeatAt;
    const staleAfter = heartbeatJob ? 90_000 : 30 * 60_000;
    const interrupted = taskIsRunning(task) && now - task.updatedAt.getTime() > staleAfter;
    let status = interrupted ? "INTERRUPTED" : task.status;
    let pendingQuery = 0, uncertain = 0;
    let total = count(output.totalItems), completed = count(output.completedItems), failed = count(output.failedItems);
    if (batch) {
      total = children.length; completed = children.filter(item => item.status === "COMPLETED").length; failed = children.filter(item => ["FAILED", "PARTIAL", "INTERRUPTED"].includes(item.status)).length;
      if (!translation && !taskIsRunning({ status }) && status !== "CANCELED") {
        if (total > 0 && completed === total) status = "SUCCESS";
        else if (children.some(item => ["PENDING", "RUNNING"].includes(item.status))) status = "RUNNING";
        else if (children.some(item => item.status === "WAITING_PROMPTS") && children.every(item => ["COMPLETED", "WAITING_PROMPTS"].includes(item.status))) status = "WAITING_PROMPTS";
      }
    }
    else if (input.workflow === "image-translation-v1") {
      total = images.length; completed = images.filter(image => image.status === "COMPLETED").length;
      pendingQuery = images.filter(image => !image.assetId && image.upstreamTask?.id && image.upstreamTask.status !== "failed").length;
      uncertain = images.filter(image => image.status === "UNCERTAIN" && !image.upstreamTask?.id).length;
      failed = images.filter(image => image.upstreamTask?.status === "failed" || image.status === "FAILED" && !image.upstreamTask?.id).length;
    }
    else if (!total) { total = 1; completed = status === "SUCCESS" ? 1 : 0; failed = status === "FAILED" ? 1 : 0; }
    const hasReceipt = Boolean(!output.imageAssetId && output.upstreamImageTask?.id && output.upstreamImageTask.status !== "failed");
    const canQueryImage = hasReceipt && Boolean(output.imageRecovery);
    if (hasReceipt) { pendingQuery = 1; failed = 0; }
    else if (!output.imageAssetId && output.imageOutcome === "uncertain") { uncertain = 1; failed = 0; }
    if (!taskIsRunning({ status }) && status !== "CANCELED") status = pendingQuery ? "PENDING_QUERY" : uncertain ? "UNCERTAIN" : status;
    const system = task.project.platform === "__mxpage_system_task__";
    const activeChild = children.find(item => ["RUNNING", "running"].includes(item.status || item.state));
    items.push({ id: `task:${task.id}`, sourceId: task.id, source: "task", kind, projectId: system ? undefined : task.projectId,
      title: batch ? `${translation ? "批量翻译" : "批量详情页"} · ${children.length} 套` : system ? labels[task.taskType] : `${task.project.name} · ${labels[task.taskType]}`,
      status, message: ["PENDING_QUERY", "UNCERTAIN"].includes(status) ? taskStatusLabels[status] : interrupted ? "执行已中断，请打开任务查看" : activeChild?.message || output.message || taskStatusLabels[status],
      href: batch ? translation ? `/translate?batch=${task.id}` : `/?batch=${task.id}` : input.batchId ? `/translate?batch=${input.batchId}` : system ? "/history" : `/projects/${task.projectId}/editor`,
      createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString(),
      ...projectTaskDuration({ status, createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString(), startedAt: task.startedAt?.toISOString(), completedAt: task.completedAt?.toISOString(), timing: output.taskTiming }, now),
      completed: Math.min(completed, total), total, failed, pendingQuery, uncertain, canQueryImage: canQueryImage && !taskIsRunning({ status }), imageUrl: typeof output.imageUrl === "string" && output.imageUrl.startsWith("/api/files/") ? output.imageUrl : undefined,
      unit: batch || task.taskType === "BATCH_CREATE" ? "套" : ["analysis", "export"].includes(kind) ? "项" : "张", error: ["SUCCESS", "WAITING_PROMPTS"].includes(status) ? undefined : task.errorMessage || undefined });
  }
  return items.sort((a,b) => Number(taskIsRunning(b)) - Number(taskIsRunning(a)) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** New running work opens the dock; terminal transitions collapse it but preserve records. */
export function nextQueueExpanded(expanded: boolean, previousRunning: string[], running: string[]) {
  if (running.some(id => !previousRunning.includes(id))) return true;
  if (previousRunning.length > 0 && running.length === 0) return false;
  return expanded;
}
