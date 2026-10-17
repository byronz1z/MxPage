import { createStore } from "zustand/vanilla";
import { fileToBase64Payload } from "@/lib/utils/base64-upload";
import type { ContentLanguage } from "@/lib/utils/content-language";
import { taskNeedsAttention } from "@/lib/tasks/queue";

export type TranslationBatch = {
  id: string; status: string; error?: string | null;
  items: Array<{ projectId: string; ready?: boolean; language?: ContentLanguage; name: string; status: string; message: string;
    translationProgress?: { completed: number; failed: number; total: number };
    images: Array<{ id: string; type: string; url: string | null }> }>;
};
export type QueueEntry = {
  id: string; title: string; total: number; createdAt: number;
  phase: "uploading" | "tracking" | "error";
  message: string; uploaded: number; uploadTotal: number;
  batch?: TranslationBatch; error?: string; busy?: boolean; canRetryUpload?: boolean;
};
export type TranslationSubmission = { groups: Array<{ name: string; files: File[] }>; languages: ContentLanguage[]; quality: string; instruction: string };
export const QUEUE_STORAGE_KEY = "mxpage:translation-queue:v1";
const activeStatuses = ["PENDING", "RUNNING"];
export function queueIsActive(entry: QueueEntry) {
  return entry.phase === "uploading" || (entry.phase === "tracking" && (!entry.batch || activeStatuses.includes(entry.batch.status) || entry.batch.items.some(item => item.status === "RUNNING")));
}
export function queueProgress(entry: QueueEntry) {
  const items = entry.batch?.items || [];
  const completed = items.reduce((n, item) => n + (item.translationProgress?.completed ?? item.images.length), 0);
  const failed = items.reduce((n, item) => n + (item.translationProgress?.failed || 0), 0);
  const total = Math.max(entry.total, items.reduce((n, item) => n + (item.translationProgress?.total ?? item.images.length), 0));
  return { completed, failed, total, percent: total ? Math.min(100, Math.floor(completed / total * 100)) : 0 };
}
export function translationShouldShow(entry: QueueEntry) {
  return queueIsActive(entry) || entry.phase === "error" || taskNeedsAttention({ status: entry.batch?.status ?? "", failed: queueProgress(entry).failed });
}

// Root-level store owns uploads and tracking; page unmounts never cancel work.
export function createTranslationQueue(deps: {
  fetcher?: typeof fetch; readFile?: typeof fileToBase64Payload;
  storage?: Pick<Storage, "getItem" | "setItem">; uuid?: () => string;
} = {}) {
  const store = createStore<{ entries: QueueEntry[]; expanded: boolean }>(() => ({ entries: [], expanded: true }));
  const storage = () => deps.storage ?? window.localStorage;
  const jobs = new Map<string, { input: TranslationSubmission; projects: Array<{ id: string; uploaded: number }> }>();
  const polling = new Set<string>();
  const epochs = new Map<string, number>();
  let hydrated = false;
  const get = (id: string) => store.getState().entries.find(entry => entry.id === id);
  function persist() {
    try { storage().setItem(QUEUE_STORAGE_KEY, JSON.stringify(store.getState().entries.map(({ id, title, total, createdAt }) => ({ id, title, total, createdAt })))); } catch { /* Tracking still works if local storage is unavailable. */ }
  }
  function update(id: string, patch: Partial<QueueEntry>) {
    store.setState(state => ({ entries: state.entries.map(entry => entry.id === id ? { ...entry, ...patch } : entry) }));
  }
  async function request(url: string, body?: unknown) {
    const response = await (deps.fetcher ?? fetch)(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || !result.success) throw Object.assign(new Error(result.error?.message || "请求失败"), { status: response.status });
    return result.data;
  }
  async function refresh(id: string) {
    const entry = get(id);
    if (!entry || entry.phase === "uploading" || entry.busy || polling.has(id)) return;
    polling.add(id);
    const epoch = epochs.get(id) || 0;
    try {
      const batch = await request(`/api/detail-batches/${encodeURIComponent(id)}`) as TranslationBatch;
      if ((epochs.get(id) || 0) !== epoch) return;
      if (!batch.items.every(item => item.language)) { update(id, { phase: "error" }); remove(id); return; }
      const current = get(id);
      if (!current) return;
      const title = current.title === "详情页翻译" && batch.items[0]?.name ? batch.items[0].name : current.title;
      const total = Math.max(current.total, batch.items.reduce((n, item) => n + (item.translationProgress?.total ?? item.images.length), 0));
      jobs.delete(id);
      update(id, { batch, title, total, phase: "tracking", error: undefined, message: "", canRetryUpload: false });
      if (title !== current.title || total !== current.total) persist();
    } catch (error) {
      if ((epochs.get(id) || 0) !== epoch) return;
      const missing = (error as { status?: number }).status === 404;
      update(id, { ...(missing ? { phase: "error" as const } : {}), error: missing ? "任务尚未提交或已删除。若上传时刷新了浏览器，请重新选择原图。" : "暂时无法读取进度，任务不会因此停止；正在重新连接。" });
    } finally { polling.delete(id); }
  }
  function watch(id: string, title = "详情页翻译") {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) return;
    if (!get(id)) {
      store.setState(state => ({ entries: [{ id, title, total: 0, createdAt: Date.now(), phase: "tracking", message: "正在读取进度…", uploaded: 0, uploadTotal: 0 }, ...state.entries] }));
      persist();
    }
    void refresh(id);
  }
  function hydrate() {
    if (hydrated) return;
    hydrated = true;
    try {
      const saved = storage().getItem(QUEUE_STORAGE_KEY);
      const entries: unknown = saved ? JSON.parse(saved) : [];
      if (Array.isArray(entries)) for (const item of entries.reverse()) {
        if (typeof item?.id !== "string") continue;
        watch(item.id, typeof item.title === "string" ? item.title : undefined);
        update(item.id, { total: Number.isFinite(item.total) ? Math.max(0, item.total) : 0, createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now() });
      }
      if (saved === null) { const legacy = storage().getItem("mxpage:last-translation-batch"); if (legacy) watch(legacy); }
      persist();
    } catch { /* Ignore damaged local metadata; server records remain available in My works. */ }
  }
  async function upload(id: string) {
    const job = jobs.get(id);
    if (!job || get(id)?.busy) return;
    epochs.set(id, (epochs.get(id) || 0) + 1);
    update(id, { phase: "uploading", busy: true, error: undefined, canRetryUpload: false });
    try {
      for (const [index, group] of job.input.groups.entries()) {
        update(id, { message: `上传原图 · ${group.name}` });
        let project = job.projects[index];
        if (!project) {
          const created = await request("/api/projects", { name: group.name.slice(0, 80).padEnd(2, "商品"), platform: "general_ecommerce", style: "generic_clean", description: job.input.instruction });
          project = { id: created.id, uploaded: 0 }; job.projects[index] = project;
        }
        const response = await (deps.fetcher ?? fetch)(`/api/projects/${project.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelSnapshot: { workType: "translation" } }) });
        const patched = await response.json();
        if (!response.ok || !patched.success) throw new Error(patched.error?.message || "保存翻译项目失败");
        for (let i = project.uploaded; i < group.files.length; i++) {
          await request(`/api/projects/${project.id}/assets/upload`, { type: i === 0 ? "MAIN" : "ANGLE", ...await (deps.readFile ?? fileToBase64Payload)(group.files[i]) });
          project.uploaded = i + 1;
          update(id, { uploaded: job.projects.reduce((n, p) => n + p.uploaded, 0) });
        }
      }
      update(id, { message: "原图已上传，正在提交翻译任务…" });
      const batch = await request("/api/detail-batches", { id, projectIds: job.projects.map(p => p.id), translations: job.input.languages, translationInstruction: job.input.instruction, options: { language: "zh-CN", quality: job.input.quality } });
      update(id, { batch, phase: "tracking", message: "", busy: false });
      jobs.delete(id); // Release original Files after the server accepts the task.
    } catch (error) {
      update(id, { phase: "error", busy: false, canRetryUpload: true, error: error instanceof Error ? error.message : "上传或提交失败" });
    }
  }
  function enqueue(input: TranslationSubmission) {
    hydrate();
    const id = (deps.uuid ?? (() => crypto.randomUUID()))();
    const uploadTotal = input.groups.reduce((n, group) => n + group.files.length, 0);
    const title = input.groups.length === 1 ? input.groups[0].name : `${input.groups[0].name} 等 ${input.groups.length} 套`;
    jobs.set(id, { input, projects: [] });
    store.setState(state => ({ expanded: true, entries: [{ id, title, total: uploadTotal * input.languages.length, createdAt: Date.now(), phase: "uploading", message: "准备上传…", uploaded: 0, uploadTotal }, ...state.entries] }));
    persist(); void upload(id);
    return id;
  }
  async function control(id: string, action: "cancel" | "resume", retryFailed = false) {
    if (!get(id)?.batch || get(id)?.busy) return;
    epochs.set(id, (epochs.get(id) || 0) + 1);
    update(id, { busy: true, error: undefined });
    try { update(id, { batch: await request(`/api/detail-batches/${encodeURIComponent(id)}`, { action, retryFailed }), phase: "tracking" }); }
    catch (error) { update(id, { error: error instanceof Error ? error.message : "操作失败" }); }
    finally { update(id, { busy: false }); }
  }
  function remove(id: string) {
    if (get(id) && (queueIsActive(get(id)!) || get(id)!.busy)) return;
    jobs.delete(id);
    store.setState(state => ({ entries: state.entries.filter(entry => entry.id !== id) })); persist();
  }
  return { store, enqueue, hydrate, watch: (id: string, title?: string) => { hydrate(); watch(id, title); }, refresh, control, remove, retryUpload: upload,
    tick: () => Promise.all(store.getState().entries.filter(entry => entry.phase === "tracking" && (queueIsActive(entry) || entry.error)).map(entry => refresh(entry.id))),
    setExpanded: (expanded: boolean) => store.setState({ expanded }),
  };
}

export const translationQueue = createTranslationQueue();
