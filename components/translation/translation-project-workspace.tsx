"use client";

import Link from "next/link";
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { contentLanguageLabels, normalizeContentLanguage } from "@/lib/utils/content-language";
import { TRANSLATION_WORKFLOW, type TranslationProgress } from "@/lib/translation/contracts";
import type { getProjectDetail } from "@/lib/services/project-service";
import { ApiRequestError, fetchApiProgress, requestErrorMessage } from "@/lib/utils/request-error";
import { ImageGenerationLoading } from "@/components/shared/image-generation-loading";
import { TaskTimer } from "@/components/tasks/task-timer";
import { projectTaskDuration } from "@/lib/tasks/timing";
import { translationNeedsPolling } from "@/lib/translation/polling";

type Project = NonNullable<Awaited<ReturnType<typeof getProjectDetail>>>;
export function TranslationProjectWorkspace({ initialProject }: { initialProject: Project }) {
  const [project, setProject] = useState(initialProject);
  const [compare, setCompare] = useState(true);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const base = `/api/projects/${project.id}`;
  const task = project.tasks.find(task => (task.inputPayload as any)?.workflow === TRANSLATION_WORKFLOW);
  const input = task?.inputPayload as { batchId?: string; language?: string } | null;
  const progress = task?.outputPayload as TranslationProgress | null;
  const snapshot = project.modelSnapshot as { previewConfig?: { contentLanguage?: string } } | null;
  const language = contentLanguageLabels[normalizeContentLanguage(input?.language || snapshot?.previewConfig?.contentLanguage)];
  const completed = project.sections.filter(section => section.imageUrl).length;
  const complete = project.sections.length > 0 && completed === project.sections.length;
  const batchHref = input?.batchId ? `/translate/${encodeURIComponent(input.batchId)}` : "/translate";
  useEffect(() => {
    let disposed = false, failures = 0, inFlight = false, active = true, lastRequest = 0;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const visible = () => document.visibilityState !== "hidden";
    async function poll() {
      if (disposed || inFlight || !visible()) return;
      clearTimeout(timer);
      inFlight = true; lastRequest = Date.now();
      try {
        const body = await fetchApiProgress<Project>(base, controller.signal);
        if (!disposed) { setProject(body); setError(""); failures = 0; active = translationNeedsPolling(body); }
      } catch (error) {
        if (!disposed) {
          if (error instanceof ApiRequestError && error.status === 404) { setMissing(true); disposed = true; }
          else { failures++; setError(requestErrorMessage(error)); }
        }
      }
      finally {
        inFlight = false;
        if (!disposed && visible() && (active || (failures > 0 && failures < 3))) timer = setTimeout(poll, Math.min(30000, 2500 * 2 ** Math.min(failures, 4)));
      }
    }
    const sync = () => { if (Date.now() - lastRequest >= 500) void poll(); };
    const visibility = () => { if (document.visibilityState === "hidden") clearTimeout(timer); else sync(); };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); window.removeEventListener("focus", sync); document.removeEventListener("visibilitychange", visibility); };
  }, [base]);
  if (missing) return <section className="space-y-4 p-6"><h1 className="text-xl font-semibold">该翻译作品已不存在</h1><Link href="/history?category=translation" className="underline">返回我的翻译作品</Link></section>;
  return <section className="mx-auto max-w-5xl space-y-6 py-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><Link href="/history?category=translation" className="text-sm text-muted-foreground">← 我的翻译作品</Link><h1 className="mt-3 text-2xl font-semibold">{project.name}</h1><p className="mt-2 text-sm text-muted-foreground">{language} · 已翻译 {completed}/{project.sections.length} 张 · 按原图顺序展示</p></div>
      <div className="flex flex-wrap gap-2">
        {completed > 0 && <a className="rounded-xl border px-4 py-2 text-sm" href={`${base}/export/images`}>下载译图 ZIP</a>}
        {complete && <a className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground" href={`${base}/export/long-image`}>下载翻译长图</a>}
      </div>
    </header>
    {task && <TaskTimer timing={projectTaskDuration({ ...task, createdAt: new Date(task.createdAt).toISOString(), updatedAt: new Date(task.updatedAt).toISOString(), startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null, completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : null, timing: progress?.taskTiming })}/>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!complete && <div className="space-y-3 rounded-2xl border bg-muted/30 p-5"><p className="text-sm">{task?.errorMessage || progress?.message || (project.sections.length ? "等待批量翻译" : `已保存 ${project.assets.length} 张原图，请到翻译入口查看或继续批次。`)}</p>{project.sections.length > 0 && <progress className="h-2 w-full" aria-label="翻译进度" max={project.sections.length} value={completed}/>}<Link className="inline-block text-sm underline" href={batchHref}>查看批次、继续或重试失败图片</Link></div>}
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex gap-2"><Button variant={compare ? "default" : "outline"} onClick={() => setCompare(true)}>原图与译图对照</Button><Button variant={!compare ? "default" : "outline"} onClick={() => setCompare(false)}>译图长页预览</Button></div><Link href={batchHref} className="text-sm underline">返回翻译批次</Link></div>
    <div className={compare ? "space-y-6" : "mx-auto max-w-2xl overflow-hidden rounded-2xl border"}>
      {project.sections.length === 0 && project.assets.map(asset => asset.url && <figure key={asset.id} className="rounded-2xl border p-4"><figcaption className="mb-3 text-sm">原图 · {asset.fileName}</figcaption><img src={asset.url} alt={asset.fileName} className="mx-auto h-auto max-w-full"/></figure>)}
      {project.sections.map((section, index) => {
        const sourceId = (section.editableData as { translationSourceAssetId?: string } | null)?.translationSourceAssetId;
        const original = project.assets.find(asset => asset.id === sourceId);
        const state = progress?.images.find(image => image.sectionId === section.id);
        return <article key={section.id} className={compare ? "rounded-2xl border bg-card p-4" : ""}>
          {compare && <h2 className="mb-4 text-sm font-medium">{index + 1}. {section.title}</h2>}
          <div className={compare ? "grid gap-4 sm:grid-cols-2" : ""}>
            {compare && <figure><figcaption className="mb-2 text-xs text-muted-foreground">原图</figcaption>{original?.url && <img src={original.url} alt={`原图：${section.title}`} className="h-auto w-full"/>}</figure>}
            <figure>{compare && <figcaption className="mb-2 text-xs text-muted-foreground">译图 · {language}</figcaption>}<div className="relative">{section.imageUrl ? <a href={section.imageUrl} target="_blank" rel="noreferrer"><img src={section.imageUrl} alt={`译图：${section.title}`} className="block h-auto w-full"/></a> : state?.status === "RUNNING" && task?.status === "RUNNING" ? <ImageGenerationLoading label="正在翻译图片" className="min-h-64"/> : <div className="flex min-h-64 items-center justify-center bg-muted/30 p-6 text-center text-sm text-muted-foreground">{state?.error || "等待翻译"}</div>}{section.imageUrl && state?.status === "RUNNING" && task?.status === "RUNNING" && <ImageGenerationLoading overlay label="正在更新译图"/>}</div></figure>
          </div>
        </article>;
      })}
    </div>
  </section>;
}
