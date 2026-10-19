"use client";

import Link from "next/link";
import { CheckCircle2, Languages, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { contentLanguageLabels } from "@/lib/utils/content-language";
import { queueIsActive, queueProgress, translationQueue, type QueueEntry } from "@/lib/translation/client-queue";
import { TaskTimer } from "@/components/tasks/task-timer";
import type { TaskQueueItem } from "@/lib/tasks/queue";

export function TranslationQueueItem({ entry, timing, onRemove, onNavigate, showRemove = true, showDetailsLink = true }: { entry: QueueEntry; timing?: TaskQueueItem; onRemove: () => void; onNavigate?: () => void; showRemove?: boolean; showDetailsLink?: boolean }) {
  const progress = queueProgress(entry);
  const active = queueIsActive(entry);
  const uploading = entry.phase === "uploading";
  const running = !!entry.batch && ["PENDING", "RUNNING"].includes(entry.batch.status);
  const finishing = !running && entry.batch?.items.some(item => item.status === "RUNNING");
  const success = entry.batch?.status === "SUCCESS";
  return <article className="space-y-3 border-t p-4" aria-label={`翻译任务：${entry.title}`} onClick={event => { if ((event.target as Element).closest("a")) onNavigate?.(); }}>
    <div className="flex items-start gap-2">
      {active ? <Loader2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 animate-spin"/> : success ? <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"/> : <Languages aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0"/>}
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium" title={entry.title}>{entry.title}</p><p className="mt-1 text-xs text-muted-foreground">{uploading ? `${entry.message} · ${entry.uploaded}/${entry.uploadTotal} 张` : !entry.batch && active ? "正在恢复任务进度…" : success ? "翻译完成" : finishing ? "正在保存已发出的图片请求…" : entry.batch?.status === "CANCELED" ? "已停止，可继续未完成图片" : active ? "后台翻译中，可切换页面" : "翻译未完成，请查看任务"}</p></div>
      {showRemove && !active && <button disabled={entry.busy} aria-label={`移除队列记录：${entry.title}`} onClick={onRemove} className="rounded p-1 text-muted-foreground hover:bg-accent"><X size={14}/></button>}
    </div>
    <div className="space-y-1.5"><div className="flex justify-between text-xs"><span>{uploading ? "原图上传" : `已翻译 ${progress.completed}/${progress.total} 张${progress.failed ? ` · ${progress.failed} 张失败` : ""}`}</span><span>{uploading ? `${entry.uploadTotal ? Math.floor(entry.uploaded / entry.uploadTotal * 100) : 0}%` : `${progress.percent}%`}</span></div><progress aria-label={`${entry.title}${uploading ? "上传" : "翻译"}进度`} className="block h-1.5 w-full accent-primary" value={uploading ? entry.uploaded : progress.completed} max={Math.max(1, uploading ? entry.uploadTotal : progress.total)}/></div>
    {timing?.elapsedMs !== undefined ? <TaskTimer timing={{ elapsedMs: timing.elapsedMs, timerStartedAt: timing.timerStartedAt, timingEstimated: timing.timingEstimated }}/> : uploading ? <TaskTimer timing={{ elapsedMs: 0, timerStartedAt: new Date(entry.createdAt).toISOString() }}/> : null}
    {entry.error && <p role="status" className="text-xs leading-5 text-destructive">{entry.error}</p>}
    {entry.batch && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">{entry.batch.items.length} 套语言版本与结果</summary><ul className="mt-2 max-h-40 space-y-2 overflow-auto">{entry.batch.items.map(item => <li key={item.projectId} className="flex justify-between gap-3"><span className="min-w-0 truncate">{item.name} · {item.language ? contentLanguageLabels[item.language] : ""} · {item.translationProgress?.completed ?? item.images.length}/{item.translationProgress?.total ?? item.images.length} 张</span>{item.ready !== false && <Link className="shrink-0 underline" href={`/projects/${item.projectId}/editor`}>查看</Link>}</li>)}</ul></details>}
    <div className="flex flex-wrap items-center gap-2">
      {showDetailsLink && <Link href={`/translate/${encodeURIComponent(entry.id)}`} className="mr-auto text-xs underline">{success ? "查看结果 / 下载" : "查看详情"}</Link>}
      {entry.canRetryUpload && <Button size="sm" variant="outline" disabled={entry.busy} onClick={() => void translationQueue.retryUpload(entry.id)}>继续上传 / 提交</Button>}
      {running ? <Button size="sm" variant="outline" disabled={entry.busy} onClick={() => void translationQueue.control(entry.id, "cancel")}>停止</Button> : entry.batch && !success && <>
        {progress.completed + progress.failed < progress.total && <Button size="sm" variant="outline" disabled={entry.busy || finishing} onClick={() => void translationQueue.control(entry.id, "resume")}>继续未完成</Button>}
        {progress.failed > 0 && <Button size="sm" variant="outline" disabled={entry.busy || finishing} onClick={() => void translationQueue.control(entry.id, "resume", true)}>重试失败图片</Button>}
      </>}
    </div>
    {!active && progress.failed > 0 && <p className="text-[11px] leading-5 text-muted-foreground">超时或中断的图片重试可能再次计费；成功译图不会重做。</p>}
  </article>;
}

