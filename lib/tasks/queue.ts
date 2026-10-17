import type { DetailRun, GenerationTask } from "@prisma/client";
import { projectTaskDuration, type TaskDuration } from "./timing";

export type QueueKind = "detail" | "translation" | "xhs" | "image" | "analysis" | "export" | "batch";
export type TaskQueueItem = Partial<TaskDuration> & {
  id: string; sourceId: string; source: "run" | "task" | "request";
  kind: QueueKind; title: string; status: string; message: string; href: string;
  projectId?: string; createdAt: string; updatedAt: string;
  completed: number; total: number; failed: number; unit: string; error?: string;
};
export const queueKindLabels: Record<QueueKind, string> = { detail: "详情页", translation: "翻译", xhs: "小红书", image: "图片处理", analysis: "分析规划", export: "导出", batch: "批量创作" };
export const taskIsRunning = (item: Pick<TaskQueueItem, "status">) => ["PENDING", "RUNNING"].includes(item.status);
export const taskNeedsAttention = (item: Pick<TaskQueueItem, "status"> & Partial<Pick<TaskQueueItem, "failed">>) => ["WAITING_INPUT", "PARTIAL", "FAILED", "INTERRUPTED"].includes(item.status) || (item.failed ?? 0) > 0;
export const taskShouldShow = (item: Pick<TaskQueueItem, "status"> & Partial<Pick<TaskQueueItem, "failed">>) => taskIsRunning(item) || taskNeedsAttention(item);
export const taskStatusLabels: Record<string, string> = { PENDING: "等待执行", RUNNING: "处理中", WAITING_INPUT: "需要补充信息", SUCCESS: "已完成", COMPLETED: "已完成", PARTIAL: "部分完成，需检查", FAILED: "未完成", INTERRUPTED: "已中断", CANCELED: "已停止" };
const stages: Record<string, string> = { PREPARE: "准备商品资料", PLAN: "规划商品内容", INPUT_SUGGESTIONS: "推断商品补充选项", ART_DIRECTION: "设计整套分镜", GENERATE: "生成图片", IMAGE_REVIEW: "检查图片", SET_REVIEW: "检查整套页面", WAITING_INPUT: "等待补充信息" };
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
    const status = interrupted ? "INTERRUPTED" : run.status;
    const total = images.length || (["edit", "regenerate"].includes(input.mode) ? 1 : count(input.heroCount) + count(input.detailCount));
    items.push({ id: `run:${run.id}`, sourceId: run.id, source: "run", kind, projectId: run.projectId, title: run.project.name,
      status, message: interrupted ? "执行已中断，已保存当前进度" : stages[run.stage] || run.stage || taskStatusLabels[status],
      href: kind === "xhs" ? `/xiaohongshu?project=${run.projectId}` : `/projects/${run.projectId}/editor`,
      createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(),
      ...projectTaskDuration({ status, createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(), timing: cp.taskTiming }, now),
      completed: images.filter(image => image.assetId).length, total, failed: images.filter(image => image.state === "uncertain").length, unit: "张",
      error: run.error || record(cp.lastError).message || undefined });
  }
  for (const task of tasks) {
    const input = record(task.inputPayload), output = record(task.outputPayload);
    if (childTaskIds.has(task.id) || parentIds.has(input.batchId)) continue;
    const batch = input.workflow === "detail-batch-v1", translation = batch && Array.isArray(input.translations);
    const children = list(output.items), images = list(output.images);
    const kind: QueueKind = translation || task.taskType === "TRANSLATE_PAGE" || input.editMode === "translate" ? "translation" : task.taskType === "XHS_GENERATE" ? "xhs" : batch || task.taskType === "BATCH_CREATE" ? "batch" : ["ANALYZE", "PLAN"].includes(task.taskType) ? "analysis" : task.taskType === "EXPORT" ? "export" : "image";
    const labels: Record<string, string> = { ANALYZE: "分析商品", PLAN: "规划页面", GENERATE: "生成图片", REGENERATE: "修改图片", EXPORT: "导出作品", BATCH_CREATE: "批量创作", TRANSLATE_PAGE: "翻译图片", XHS_GENERATE: "生成小红书图文", QA_CHECK: "检查图片" };
    // Display a stale worker as interrupted without restarting or mutating paid work.
    const heartbeatJob = batch || input.workflow === "image-translation-v1" || !!output.heartbeatAt;
    const staleAfter = heartbeatJob ? 90_000 : 30 * 60_000;
    const interrupted = taskIsRunning(task) && now - task.updatedAt.getTime() > staleAfter;
    const status = interrupted ? "INTERRUPTED" : task.status;
    let total = count(output.totalItems), completed = count(output.completedItems), failed = count(output.failedItems);
    if (batch) { total = children.length; completed = children.filter(item => item.status === "COMPLETED").length; failed = children.filter(item => ["FAILED", "PARTIAL", "INTERRUPTED"].includes(item.status)).length; }
    else if (input.workflow === "image-translation-v1") { total = images.length; completed = images.filter(image => image.status === "COMPLETED").length; failed = images.filter(image => ["FAILED", "UNCERTAIN"].includes(image.status)).length; }
    else if (!total) { total = 1; completed = status === "SUCCESS" ? 1 : 0; failed = status === "FAILED" ? 1 : 0; }
    const system = task.project.platform === "__mxpage_system_task__";
    const activeChild = children.find(item => ["RUNNING", "running"].includes(item.status || item.state));
    items.push({ id: `task:${task.id}`, sourceId: task.id, source: "task", kind, projectId: system ? undefined : task.projectId,
      title: batch ? `${translation ? "批量翻译" : "批量详情页"} · ${children.length} 套` : system ? labels[task.taskType] : `${task.project.name} · ${labels[task.taskType]}`,
      status, message: interrupted ? "执行已中断，请打开任务查看" : activeChild?.message || output.message || taskStatusLabels[status],
      href: batch ? translation ? `/translate?batch=${task.id}` : `/?batch=${task.id}` : input.batchId ? `/translate?batch=${input.batchId}` : system ? "/history" : `/projects/${task.projectId}/editor`,
      createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString(),
      ...projectTaskDuration({ status, createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString(), startedAt: task.startedAt?.toISOString(), completedAt: task.completedAt?.toISOString(), timing: output.taskTiming }, now),
      completed: Math.min(completed, total), total, failed, unit: batch || task.taskType === "BATCH_CREATE" ? "套" : ["analysis", "export"].includes(kind) ? "项" : "张", error: task.errorMessage || undefined });
  }
  return items.sort((a,b) => Number(taskIsRunning(b)) - Number(taskIsRunning(a)) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** New running work opens the dock; terminal transitions collapse it but preserve records. */
export function nextQueueExpanded(expanded: boolean, previousRunning: string[], running: string[]) {
  if (running.some(id => !previousRunning.includes(id))) return true;
  if (previousRunning.length > 0 && running.length === 0) return false;
  return expanded;
}
