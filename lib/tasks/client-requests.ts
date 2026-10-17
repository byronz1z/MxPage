import { createStore } from "zustand/vanilla";
import type { TaskQueueItem } from "./queue";
import { projectTaskDuration } from "./timing";

const STORAGE_KEY = "mxpage:request-queue:v1";
export function describeQueueRequest(path: string, method: string) {
  if (method.toUpperCase() !== "POST") return null;
  const brief = path.match(/^\/api\/projects\/([^/]+)\/brief$/);
  if (brief) return { kind: "analysis" as const, title: "商品初步识别", projectId: brief[1], href: `/projects/${brief[1]}/configure` };
  const xhs = path.match(/^\/api\/xiaohongshu\/(plan|edit|generate)$/);
  if (xhs) return { kind: "xhs" as const, title: xhs[1] === "plan" ? "小红书内容规划" : xhs[1] === "edit" ? "修改小红书图片" : "生成小红书图片", href: "/xiaohongshu" };
  return null;
}

// Only short request metadata is retained; request bodies, images and credentials are never read.
export const taskRequests = createStore<{ entries: TaskQueueItem[]; revision: number }>(() => ({ entries: [], revision: 0 }));
let hydrated = false;
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(taskRequests.getState().entries)); } catch { /* In-memory tracking remains available. */ }
}
export function hydrateTaskRequests() {
  if (hydrated) return;
  hydrated = true;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (Array.isArray(saved)) taskRequests.setState({ entries: saved.filter(item => item?.source === "request" && ["analysis", "xhs"].includes(item.kind) && typeof item.id === "string" && typeof item.title === "string" && typeof item.createdAt === "string" && typeof item.updatedAt === "string" && typeof item.status === "string" && typeof item.href === "string" && /^\/(?:projects\/[^/]+\/configure|xiaohongshu)$/.test(item.href)).slice(0, 30).map(item => ["RUNNING", "PENDING"].includes(item.status) ? { ...item, ...projectTaskDuration({ ...item, status: "INTERRUPTED", startedAt: item.createdAt }), timerStartedAt: undefined, status: "INTERRUPTED", message: "页面已刷新，请打开原任务确认结果" } : item) });
  } catch { /* Ignore corrupt local history. */ }
}
export function dismissTaskRequest(id: string) {
  taskRequests.setState(state => ({ entries: state.entries.filter(item => item.id !== id || item.status === "RUNNING") })); persist();
}

export function trackQueueRequest(path: string, method: string, perform: () => Promise<Response>): Promise<Response> {
  const descriptor = describeQueueRequest(path, method);
  const workflow = method.toUpperCase() === "POST" && /^\/api\/(projects|tasks|detail-batches|xiaohongshu)(\/|$)/.test(path);
  const id = descriptor ? `request:${crypto.randomUUID()}` : null;
  if (id && descriptor) {
    hydrateTaskRequests();
    const timestamp = new Date().toISOString();
    const item: TaskQueueItem = { ...descriptor, id, sourceId: id, source: "request", status: "RUNNING", message: "请求处理中，可切换页面", createdAt: timestamp, updatedAt: timestamp, elapsedMs: 0, timerStartedAt: timestamp, completed: 0, total: 1, failed: 0, unit: "项" };
    taskRequests.setState(state => ({ entries: [item, ...state.entries.filter((entry, index) => entry.status === "RUNNING" || index < 29)] })); persist();
  }
  function finish(success: boolean) {
    if (id) {
      const finishedAt = new Date().toISOString();
      taskRequests.setState(state => ({ entries: state.entries.map(item => item.id === id ? { ...item, ...projectTaskDuration({ status: "SUCCESS", createdAt: item.createdAt, startedAt: item.createdAt, updatedAt: finishedAt }), timerStartedAt: undefined, status: success ? "SUCCESS" : "FAILED", completed: success ? 1 : 0, failed: success ? 0 : 1, updatedAt: finishedAt, message: success ? "已完成，请在原页面查看结果" : "请求未完成，请打开任务查看原因" } : item) })); persist();
    }
    if (workflow) taskRequests.setState(state => ({ revision: state.revision + 1 }));
  }
  return Promise.resolve().then(perform).then(response => { finish(response.ok); return response; }, error => { finish(false); throw error; });
}
