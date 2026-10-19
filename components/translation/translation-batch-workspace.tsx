"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useStore } from "zustand";
import { translationQueue } from "@/lib/translation/client-queue";
import { contentLanguageLabels } from "@/lib/utils/content-language";
import { TranslationQueueItem } from "./translation-queue";

export function TranslationBatchWorkspace({ batchId }: { batchId: string }) {
  const entry = useStore(translationQueue.store, state => state.entries.find(item => item.id === batchId));
  useEffect(() => {
    translationQueue.watch(batchId);
    const sync = () => { if (document.visibilityState !== "hidden") void translationQueue.refresh(batchId); };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => { window.removeEventListener("focus", sync); document.removeEventListener("visibilitychange", sync); };
  }, [batchId]);
  return <section className="mx-auto max-w-5xl space-y-6 py-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><Link href="/history?category=translation" className="text-sm text-muted-foreground">← 我的翻译作品</Link><h1 className="mt-3 text-2xl font-semibold">翻译进度与预览</h1><p className="mt-2 text-sm text-muted-foreground">每张译图完成后自动显示，结果按原图顺序排列。</p></div>
      <Link href="/translate" className="rounded-xl border px-4 py-2 text-sm">新建翻译</Link>
    </header>
    {entry ? <>
      <div className="overflow-hidden rounded-2xl border"><TranslationQueueItem entry={entry} onRemove={() => {}} showRemove={false} showDetailsLink={false}/></div>
      {entry.batch?.items.map(item => <article key={item.projectId} className="space-y-4 rounded-2xl border p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{item.name}{item.language ? ` · ${contentLanguageLabels[item.language]}` : ""}</h2><p className="mt-2 text-sm text-muted-foreground">{item.message}</p></div>{item.ready !== false && <Link href={`/projects/${item.projectId}/editor`} className="text-sm underline">原图对照与长页预览</Link>}</div>
        {item.images.length ? <>
          <div className="grid gap-4 sm:grid-cols-2">{item.images.map((image, index) => image.url && <a key={image.id} href={image.url} target="_blank" rel="noreferrer" className="overflow-hidden rounded-xl border"><img src={image.url} alt={`译图 ${index + 1}`} className="h-auto w-full"/></a>)}</div>
          <a href={`/api/projects/${item.projectId}/export/images`} className="inline-block text-sm underline">下载已完成译图 ZIP</a>
        </> : <p className="rounded-xl bg-muted/30 p-8 text-center text-sm text-muted-foreground">{item.status === "FAILED" || item.status === "CANCELED" || item.status === "INTERRUPTED" ? "尚无译图，请查看任务状态后继续或重试。" : "等待译图完成，预览将自动更新。"}</p>}
      </article>)}
    </> : <p role="status">正在读取翻译任务…</p>}
  </section>;
}
