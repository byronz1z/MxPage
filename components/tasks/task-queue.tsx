"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useStore } from "zustand";
import { AlertCircle, BookOpenText, CheckCircle2, ChevronDown, FolderKanban, Image, Languages, ListTodo, Loader2, ScanSearch, Download, X } from "lucide-react";
import { TranslationQueueItem } from "@/components/translation/translation-queue";
import { queueIsActive, translationQueue, translationShouldShow } from "@/lib/translation/client-queue";
import { dismissTaskRequest, hydrateTaskRequests, taskRequests } from "@/lib/tasks/client-requests";
import { nextQueueExpanded, queueKindLabels, taskIsRunning, taskNeedsAttention, taskShouldShow, taskStatusLabels, type TaskQueueItem } from "@/lib/tasks/queue";
import { cn } from "@/lib/utils";
import { TaskTimer } from "./task-timer";
import { ImageTaskAction } from "./image-task-action";
import { projectTaskDuration } from "@/lib/tasks/timing";

const HIDDEN_KEY = "mxpage:task-queue-dismissed:v1";
const icons = { detail: FolderKanban, translation: Languages, xhs: BookOpenText, image: Image, analysis: ScanSearch, export: Download, batch: FolderKanban };

function TaskItem({ item, onRemove, onNavigate }: { item: TaskQueueItem; onRemove: () => void; onNavigate: () => void }) {
  const running = taskIsRunning(item), attention = taskNeedsAttention(item);
  const Icon = running ? Loader2 : attention ? AlertCircle : ["SUCCESS", "COMPLETED"].includes(item.status) ? CheckCircle2 : icons[item.kind];
  const percent = item.total ? Math.min(100, Math.floor(item.completed / item.total * 100)) : 0;
  return <article className="space-y-3 border-t p-4" aria-label={`${queueKindLabels[item.kind]}任务：${item.title}`}>
    <div className="flex items-start gap-2">
      <Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", running ? "animate-spin motion-reduce:animate-none" : attention ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400")} />
      <div className="min-w-0 flex-1"><p title={item.title} className="truncate text-sm font-medium">{item.title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{queueKindLabels[item.kind]} · {item.message || taskStatusLabels[item.status]}</p></div>
      {!running && !["WAITING_INPUT", "WAITING_PROMPTS"].includes(item.status) && <button type="button" aria-label={`移除队列记录：${item.title}`} onClick={onRemove} className="rounded-md p-1 text-muted-foreground hover:bg-accent"><X size={14} /></button>}
    </div>
    <TaskTimer timing={item.elapsedMs === undefined ? projectTaskDuration(item) : { elapsedMs: item.elapsedMs, timerStartedAt: taskIsRunning(item) ? item.timerStartedAt : undefined, timingEstimated: item.timingEstimated }}/>
    <div className="space-y-1.5"><div className="flex justify-between gap-3 text-xs"><span>{item.total ? `${item.completed}/${item.total} ${item.unit}${item.failed ? ` · ${item.failed} ${item.unit}未完成` : ""}` : "准备中"}</span><span>{item.total ? `${percent}%` : ""}</span></div>
      <progress aria-label={`${item.title}进度`} className="block h-1.5 w-full accent-primary" value={item.total ? item.completed : undefined} max={item.total || 1} /></div>
    {item.error && <p className="line-clamp-3 text-xs leading-5 text-destructive" title={item.error}>{item.error}</p>}
    {(!!item.pendingQuery || !!item.uncertain) && <p className="text-xs text-amber-700 dark:text-amber-400">{item.pendingQuery ? `${item.pendingQuery} 项可查询或下载已有结果，请进入任务恢复。` : ""}{item.uncertain ? `${item.uncertain} 项模型请求结果未确认，请先核对调用记录，再决定是否授权重新提交。` : ""}</p>}
    <ImageTaskAction item={item}/>
    <Link href={item.href} onClick={onNavigate} className="inline-flex text-xs underline underline-offset-4">{item.status === "WAITING_PROMPTS" ? "预览并确认提示词" : item.status === "WAITING_INPUT" ? "补充信息 / 继续任务" : running ? "查看任务" : "查看结果 / 处理任务"}</Link>
  </article>;
}

export function TaskQueue() {
  const allTranslations = useStore(translationQueue.store, state => state.entries);
  const translations = allTranslations.filter(translationShouldShow);
  const requests = useStore(taskRequests);
  const [feed, setFeed] = useState<TaskQueueItem[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const previousRunning = useRef<string[]>([]);
  const fetching = useRef(false);
  const lastQueueRead = useRef(0);
  const serverActive = useRef(false);
  const mounted = useRef(false);
  const dock = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(async () => {
    if (fetching.current || document.visibilityState === "hidden") return;
    fetching.current = true;
    lastQueueRead.current = Date.now();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch("/api/tasks/queue", { cache: "no-store", signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || !payload.success || !Array.isArray(payload.data)) throw new Error("无法读取任务队列");
      if (mounted.current) { serverActive.current = payload.data.some(taskIsRunning); setFeed(payload.data); setError(""); }
    } catch { if (mounted.current) setError("暂时无法同步任务进度，正在重新连接。任务不会因此停止。"); }
    finally { clearTimeout(timeout); fetching.current = false; }
  }, []);

  useEffect(() => {
    mounted.current = true;
    hydrateTaskRequests(); translationQueue.hydrate();
    try { const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) || "{}"); if (saved && typeof saved === "object" && !Array.isArray(saved)) setDismissed(saved); } catch { /* Use an empty dismissal list. */ }
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      const active = serverActive.current || translationQueue.store.getState().entries.some(queueIsActive) || taskRequests.getState().entries.some(taskIsRunning);
      if (active || Date.now() - lastQueueRead.current >= 30000) void refresh();
      void translationQueue.tick();
    };
    const sync = () => { if (document.visibilityState !== "hidden") { void refresh(); void translationQueue.tick(); } };
    tick();
    const timer = setInterval(tick, 2500);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => { mounted.current = false; clearInterval(timer); window.removeEventListener("focus", sync); document.removeEventListener("visibilitychange", sync); };
  }, [refresh]);
  useEffect(() => { if (requests.revision) void refresh(); }, [requests.revision, refresh]);

  const translationIds = new Set(allTranslations.map(entry => `task:${entry.id}`));
  const items = [...requests.entries, ...feed].filter(item => taskShouldShow(item) && !translationIds.has(item.id) && (taskIsRunning(item) || !dismissed[item.id] || item.updatedAt > dismissed[item.id]));
  const runningIds = [...items.filter(taskIsRunning).map(item => item.id), ...translations.filter(entry => entry.phase === "uploading" || (!!entry.batch && queueIsActive(entry))).map(entry => `task:${entry.id}`)].sort();
  const runningKey = runningIds.join(",");
  const attention = items.filter(taskNeedsAttention).length + translations.filter(entry => !queueIsActive(entry)).length;
  const total = items.length + translations.length;
  useEffect(() => {
    const running = runningKey ? runningKey.split(",") : [];
    const previous = previousRunning.current;
    previousRunning.current = running;
    setExpanded(current => nextQueueExpanded(current, previous, running));
  }, [runningKey]);
  useEffect(() => { if (!total) setExpanded(false); }, [total]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !dock.current?.contains(event.target)) setExpanded(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setExpanded(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [expanded]);
  function dismiss(id: string) {
    const next = { ...dismissed, [id]: new Date().toISOString() };
    setDismissed(next);
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(next)); } catch { /* Dismiss for this session. */ }
    if (id.startsWith("request:")) dismissTaskRequest(id);
  }
  const rows = [
    ...translations.map(entry => ({ id: `task:${entry.id}`, active: queueIsActive(entry), createdAt: entry.createdAt, content: <TranslationQueueItem key={entry.id} entry={entry} timing={feed.find(item => item.id === `task:${entry.id}`)} onNavigate={() => setExpanded(false)} onRemove={() => { dismiss(`task:${entry.id}`); translationQueue.remove(entry.id); }} /> })),
    ...items.map(item => ({ id: item.id, active: taskIsRunning(item), createdAt: Date.parse(item.createdAt), content: <TaskItem key={item.id} item={item} onRemove={() => dismiss(item.id)} onNavigate={() => setExpanded(false)} /> })),
  ].sort((a,b) => Number(b.active) - Number(a.active) || b.createdAt - a.createdAt);
  return <aside ref={dock} aria-label="全局任务队列" className="fixed bottom-5 right-4 z-40 flex flex-col items-end sm:right-6">
    {expanded && <section id="global-task-queue-items" aria-label="任务列表" className="mb-3 w-[calc(100vw-2rem)] max-w-sm overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-xl">
      <div className="flex items-center justify-between gap-3 p-4"><div><h2 className="text-sm font-semibold">任务队列</h2><p className="mt-1 text-xs text-muted-foreground">{runningIds.length ? `${runningIds.length} 项处理中${attention ? ` · ${attention} 项需查看` : ""}` : attention ? `${attention} 项需查看` : total ? "正在读取进度…" : "暂无任务"}</p></div><button type="button" aria-label="收起任务队列" onClick={() => { setExpanded(false); trigger.current?.focus(); }} className="rounded-lg p-2 text-muted-foreground hover:bg-accent"><ChevronDown size={18} /></button></div>
      <Link href="/tasks" onClick={() => setExpanded(false)} className="block border-t px-4 py-3 text-xs underline underline-offset-4">查看全部类型的任务耗时记录</Link>
      <div className="max-h-[min(55vh,560px)] overflow-y-auto overscroll-contain">
        {error && <p role="status" className="px-4 pb-3 text-xs text-amber-600 dark:text-amber-400">{error}</p>}
        {!total && <p className="border-t p-6 text-center text-sm text-muted-foreground">暂无进行中或需处理的任务。已完成作品可在“我的作品”中查看。</p>}
        {rows.map(row => row.content)}
        {!!total && <p className="border-t p-4 text-[11px] leading-5 text-muted-foreground">成功任务自动从队列隐藏；失败或待处理任务可在此查看。已完成作品请前往“我的作品”。</p>}
      </div>
    </section>}
    <button ref={trigger} type="button" aria-label={expanded ? "收起任务队列" : `打开任务队列${runningIds.length ? `，${runningIds.length} 项处理中` : ""}`} aria-expanded={expanded} aria-controls="global-task-queue-items" title={runningIds.length ? `${runningIds.length} 项任务处理中` : attention ? `${attention} 项任务需查看` : "任务队列"} onClick={() => setExpanded(current => !current)} className="relative inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-border bg-card text-foreground shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {runningIds.length ? <Loader2 aria-hidden="true" size={20} className="animate-spin motion-reduce:animate-none" /> : <ListTodo aria-hidden="true" size={20} />}
      {(runningIds.length > 0 || attention > 0) && <span aria-hidden="true" className={cn("absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-medium", runningIds.length ? "bg-primary text-primary-foreground" : "bg-amber-500 text-black")}>{runningIds.length || attention}</span>}
    </button>
  </aside>;
}
