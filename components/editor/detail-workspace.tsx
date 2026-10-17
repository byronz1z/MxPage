"use client";

import { Select } from "@/components/ui/select";
import { imageDisplayProgress } from "@/lib/tasks/image-progress";
import { DetailTaskTiming } from "./detail-task-timing";
import type { RequestTiming, TimingHistoryEntry } from "@/lib/detail-runs/timing";
import { ImageGenerationLoading } from "@/components/shared/image-generation-loading";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, Download, ChevronLeft, ChevronRight, Smartphone, LayoutGrid, Expand, X } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { ProductPhonePreview, ProductImage, imageReview } from "./product-phone-preview";
import { listingFields, type ListingPreview } from "./taobao-product-preview";
import { CommercePlanSummary } from "./commerce-plan-summary";
import { SupplementalInfoDialog } from "./supplemental-info-dialog";
import { normalizeSupplementalQuestions, supplementalQuestionSetId } from "@/lib/detail-runs/supplemental-input";
import { CommerceContentCoverage } from "./commerce-content-coverage";
import { Input } from "@/components/ui/input";
import { platformLabels } from "@/types/domain";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { fileToBase64Payload } from "@/lib/utils/base64-upload";
import { contentLanguageOptions, contentLanguageLabels } from "@/lib/utils/content-language";
import type { RunCheckpoint } from "@/lib/detail-runs/contracts";
import { designIssueLabel } from "@/lib/detail-runs/art-direction";
import { ApiRequestError, fetchApiProgress, readApiResponse as read, requestErrorMessage } from "@/lib/utils/request-error";

type Run = { createdAt?: string; updatedAt?: string; id: string; status: string; stage: string; error?: string; draining?: boolean; timingHistory?: TimingHistoryEntry[]; checkpoint: RunCheckpoint & { workflowVersion?: number; setReviewAssetIds?: string[]; requests?: Record<string, { state: string }>; requestTimings?: Record<string, RequestTiming> } };
const workflowStageLabels: Record<string, string> = { INPUT_SUGGESTIONS: "推断商品补充选项", PREPARE: "准备商品资料", PLAN: "规划商品内容", WAITING_INPUT: "等待补充信息", ART_DIRECTION: "设计整套视觉分镜", GENERATE: "生成商品图片", IMAGE_REVIEW: "检查图片质量", SET_REVIEW: "检查整套页面" };
const post = (url: string, data: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(read);

export function DetailWorkspace({ initialProject }: { initialProject: any }) {
  const [project, setProject] = useState(initialProject);
  const [run, setRun] = useState<Run | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generatingSectionId, setGeneratingSectionId] = useState<string>();
  const [connectionError, setConnectionError] = useState("");
  const [missing, setMissing] = useState(false);
  const [selected, setSelected] = useState<string>(initialProject.sections[0]?.id || "");
  const [heroIndex, setHeroIndex] = useState(0);
  const [view, setView] = useState<"phone" | "images">("phone");
  const [skin, setSkin] = useState<"taobao" | "generic">(initialProject.platform === "xiaohongshu" ? "generic" : "taobao");
  const [listing, setListing] = useState<ListingPreview>(initialProject.modelSnapshot?.listingPreview || {});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [downloadLink, setDownloadLink] = useState<{ url: string; name: string } | null>(null);
  useEffect(() => () => { if (downloadLink) URL.revokeObjectURL(downloadLink.url); }, [downloadLink]);
  const [instruction, setInstruction] = useState("");
  const [language, setLanguage] = useState("en-US");
  const [retryUncertain, setRetryUncertain] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const locked = useRef(false);
  const startKey = useRef<string>();
  const refreshSequence = useRef(0);
  const expandedTrigger = useRef<HTMLElement | null>(null);
  function openImage(id: string) {
    expandedTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setExpanded(id);
  }
  const base = `/api/projects/${project.id}`;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++refreshSequence.current;
    // Read the checkpoint first so a completed run cannot precede its images.
    const r = await fetchApiProgress(`${base}/detail-runs?includeTimings=1`, signal);
    const p = await fetchApiProgress(base, signal);
    if (signal?.aborted || sequence !== refreshSequence.current) return;
    setProject(p); setRun(r); setLoaded(true); setConnectionError("");
    setSelected(current => p.sections.some((s: any) => s.id === current) ? current : p.sections[0]?.id || "");
  }, [base]);
  useEffect(() => {
    let stopped = false, failures = 0; let timeout: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try { await refresh(controller.signal); failures = 0; }
      catch (error) {
        if (!stopped) {
          if (error instanceof ApiRequestError && error.status === 404) { setMissing(true); stopped = true; }
          else { failures++; setConnectionError(requestErrorMessage(error, "暂时无法更新进度，正在重新连接，已显示的图片会保留。")); }
        }
      }
      finally { if (!stopped) timeout = setTimeout(poll, Math.min(30000, 2500 * 2 ** Math.min(failures, 4))); }
    };
    void poll(); return () => { stopped = true; controller.abort(); clearTimeout(timeout); refreshSequence.current++; };
  }, [refresh]);
  useEffect(() => {
    if (run?.status === "WAITING_INPUT") setInputOpen(true);
  }, [run?.id, run?.status]);
  const active = !loaded || Boolean(run && (["PENDING", "RUNNING", "WAITING_INPUT"].includes(run.status) || run.draining));
  const sections = [...project.sections].sort((a, b) => a.order - b.order) as any[];
  const heroes = sections.filter(s => s.type === "HERO");
  const details = sections.filter(s => s.type !== "HERO");
  const section = sections.find(s => s.id === selected);
  const expandedSection = sections.find(s => s.id === expanded);
  const progress = run?.checkpoint.images || [];
  const displayProgress = imageDisplayProgress(progress, run?.status === "RUNNING" || run?.draining === true, project.tasks || [], generatingSectionId);
  const generated = progress.filter(i => i.assetId).length;
  const uncertain = progress.some(i => !i.assetId && ["uncertain", "generating"].includes(i.state))
    || Object.values(run?.checkpoint.requests || {}).some(request => ["uncertain", "running"].includes(request.state));
  const reviewAssets = run?.checkpoint.setReviewAssetIds || progress.map(image => image.assetId);
  const v4ReviewAssetsMatch = reviewAssets.length === sections.length && sections.every((s, i) => s.currentImageAssetId && s.currentImageAssetId === reviewAssets[i]);
  const needsPageReview = (run?.checkpoint.workflowVersion === 4 || ((run?.checkpoint.plan as { version?: number } | undefined)?.version || 0) >= 2) && (!run?.checkpoint.setReview || (run?.checkpoint.workflowVersion === 4 && !v4ReviewAssetsMatch));
  const pendingWork = needsPageReview || !progress.length || progress.some(i => !i.assetId || i.state !== "checked" || (run?.checkpoint.workflowVersion !== 4 && i.check?.passed === false && i.correctionCount < 1));
  const reviewOnly = run?.status === "PARTIAL" && !pendingWork;
  const showProgress = Boolean(run && run.status !== "COMPLETED" && !reviewOnly);
  const supplementalQuestions = normalizeSupplementalQuestions(run?.checkpoint.questions);
  const gate = run?.checkpoint.firstHeroGate;
  const gateNeedsEdit = gate?.passed === false && gate.assetId && gate.assetId === heroes[0]?.currentImageAssetId && !uncertain;
  const blockedSingle = (run?.checkpoint.creativeVersion || 0) >= 2 && !section?.imageUrl && !run?.checkpoint.artDirection;
  const pageReview = run?.checkpoint.setReview;
  const legacyPageReviewCurrent = pageReview && Array.isArray((pageReview as any).assetIds)
    && (pageReview as any).assetIds.length === sections.length
    && (pageReview as any).assetIds.every((id: string, i: number) => id === sections[i]?.currentImageAssetId);
  const v4PageReviewCurrent = v4ReviewAssetsMatch && pageReview && Array.isArray((pageReview as any).issues)
    && (pageReview as any).issues.every((issue: any) => Array.isArray(issue?.sectionIndexes));
  const pageReviewCurrent = Boolean(legacyPageReviewCurrent || v4PageReviewCurrent);
  const config = project.modelSnapshot?.previewConfig || {};
  const totalImages = progress.length || (config.heroImageCount ?? 4) + (config.detailSectionCount ?? 6);
  const availableImages = sections.filter(s => s.imageUrl).length;
  const selectedReview = section && imageReview(section, progress);
  const completeDetails = details.length > 0 && details.every(s => s.imageUrl) && details.length >= (config.detailSectionCount || details.length);
  async function act(fn: () => Promise<unknown>) {
    if (locked.current) return false;
    locked.current = true; setBusy(true);
    try {
      await fn();
      // An accepted action must not appear to have failed just because the following GET failed.
      try { await refresh(); } catch (error) { setConnectionError(requestErrorMessage(error)); }
      return true;
    } catch (error) { toast.error(requestErrorMessage(error)); return false; }
    finally { locked.current = false; setBusy(false); }
  }
  async function start(mode = "create") {
    if ((mode === "edit" || mode === "regenerate") && !selected) return;
    if (mode === "edit" || mode === "regenerate") {
      await act(async () => {
        setGeneratingSectionId(selected);
        try {
        const path = mode === "edit" ? "edit" : "regenerate";
        await post(`${base}/sections/${selected}/${path}`, mode === "edit"
          ? { editMode: "repaint", instruction: instruction.trim() }
          : {});
        setInstruction("");
        } finally { setGeneratingSectionId(undefined); }
      });
      return;
    }
    if (mode === "translate") {
      const targets = sections.filter(item => item.imageUrl);
      if (!targets.length) return;
      await act(async () => {
        // Translation is a per-image edit operation in V4. Keep the same
        // bounded concurrency as image generation instead of creating a new
        // planning run and duplicating the page sections.
        const failures: string[] = [];
        for (let index = 0; index < targets.length; index += 2) {
          const batch = targets.slice(index, index + 2);
          const results = await Promise.allSettled(batch.map(item => post(`${base}/sections/${item.id}/edit`, {
            editMode: "translate",
            targetLanguage: language,
          })));
          results.forEach((result, resultIndex) => {
            if (result.status === "rejected") failures.push(`${batch[resultIndex].title}: ${result.reason instanceof Error ? result.reason.message : "翻译失败"}`);
          });
        }
        if (failures.length) throw new Error(`部分图片翻译失败：${failures.join("；")}`);
        toast.success("整套图片已完成翻译");
      });
      return;
    }
    await act(async () => {
      startKey.current ??= crypto.randomUUID();
      await post(`${base}/detail-runs`, { idempotencyKey: startKey.current, mode, sectionId: selected || undefined, instruction,
        language: mode === "translate" ? language : config.contentLanguage || "zh-CN", quality: config.quality || "auto", heroCount: config.heroImageCount || 4, detailCount: config.detailSectionCount || 6 });
      startKey.current = undefined; setInstruction("");
    });
  }
  const control = (action: string, data: unknown = {}) => act(async () => { await post(`${base}/detail-runs/${run!.id}/${action}`, data); setRetryUncertain(false); });
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    await act(async () => {
      for (const file of Array.from(files)) {
        if (file.size > 10 * 1024 * 1024) throw new Error("每张图片不得超过 10MB");
        await post(`${base}/assets/upload`, { type: "ANGLE", ...await fileToBase64Payload(file) });
      }
      toast.success("素材已补充");
    });
  }
  async function downloadOutput(kind: "long-image" | "images") {
    await act(async () => {
      const response = await fetch(`${base}/export/${kind}`);
      if (!response.ok) { await read(response); return; }
      const url = URL.createObjectURL(await response.blob());
      const name = kind === "images" ? "mxpage-images.zip" : "mxpage-detail.png";
      setDownloadLink({ url, name });
      const a = document.createElement("a"); a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
    });
  }
  if (missing) return <section className="space-y-4 rounded-2xl border p-6"><h1 className="text-xl font-semibold">该作品已不存在</h1><p className="text-sm text-muted-foreground">作品可能已在其他页面删除。请选择其他作品继续。</p><Link href="/history" className="inline-block underline">返回我的作品</Link></section>;
  return <div className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><Link className="text-sm text-muted-foreground" href="/history">← 我的作品</Link><h1 className="mt-3 text-2xl font-semibold">{project.name}</h1><p className="mt-2 text-sm text-muted-foreground">整套商品图 · 预览、修改与下载</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || !availableImages} onClick={() => downloadOutput("images")}><Download className="mr-2 h-4 w-4"/>分图 ZIP{availableImages ? `（${availableImages}）` : ""}</Button><Button disabled={!completeDetails || busy || Boolean(active)} onClick={() => downloadOutput("long-image")}>下载详情长图</Button></div></header>
    {downloadLink && <p role="status" className="text-sm text-muted-foreground">文件已准备好。如未自动下载，<a href={downloadLink.url} download={downloadLink.name} className="text-foreground underline underline-offset-4">点击保存 {downloadLink.name}</a>。</p>}
    {showProgress && run && <section aria-label="任务进度" className="space-y-2" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-sm"><span className="flex items-center gap-2">{run.status === "RUNNING" && <Loader2 className="h-4 w-4 animate-spin"/>}{workflowStageLabels[run.stage] || run.stage}</span><span className="shrink-0 tabular-nums text-muted-foreground">{generated}/{totalImages} 张</span></div>
      <progress aria-label="生成进度" className="block h-2 w-full" max={totalImages} value={generated}/>
    </section>}
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-6">
        <div className="flex flex-wrap gap-2" role="group" aria-label="预览方式"><Button variant={view === "phone" ? "default" : "outline"} aria-pressed={view === "phone"} onClick={() => setView("phone")}><Smartphone className="mr-2 h-4 w-4"/>手机预览</Button><Button variant={view === "images" ? "default" : "outline"} aria-pressed={view === "images"} onClick={() => setView("images")}><LayoutGrid className="mr-2 h-4 w-4"/>图片列表</Button></div>
        {view === "phone" ? <><div className="flex items-center gap-3 text-sm"><span className="shrink-0 text-muted-foreground">预览外观</span><Select aria-label="预览外观" value={skin} onValueChange={v => setSkin(v as "taobao" | "generic")}><option value="taobao">淘宝 · 参考界面</option><option value="generic">通用 · 纯图片预览</option></Select></div><ProductPhonePreview skin={skin} listing={listing} name={project.name} platform={platformLabels[project.platform as keyof typeof platformLabels] || "通用电商"} sections={sections} progress={displayProgress} selected={selected} onSelect={setSelected} onExpand={openImage}/></> : <>
        {heroes.length > 0 && <section className="rounded-2xl border p-4"><div className="mb-3 flex items-center justify-between"><h2 className="font-medium">商品头图</h2><div className="flex items-center gap-2"><Button size="sm" variant="ghost" aria-label="上一张头图" onClick={() => setHeroIndex((heroIndex + heroes.length - 1) % heroes.length)}><ChevronLeft size={18}/></Button><span className="text-sm">{heroIndex % heroes.length + 1}/{heroes.length}</span><Button size="sm" variant="ghost" aria-label="下一张头图" onClick={() => setHeroIndex((heroIndex + 1) % heroes.length)}><ChevronRight size={18}/></Button></div></div><ImageCard section={heroes[heroIndex % heroes.length]} progress={displayProgress} selected={selected} onSelect={setSelected}/></section>}
        {details.length > 0 && <section className="rounded-2xl border p-4"><h2 className="mb-4 font-medium">商品详情</h2><div className="mx-auto max-w-xl space-y-1">{details.map(s => <ImageCard key={s.id} section={s} progress={displayProgress} selected={selected} onSelect={setSelected}/>)}</div></section>}
        {!sections.length && <div className="flex min-h-64 items-center justify-center rounded-2xl border border-dashed p-8 text-center text-muted-foreground">{active ? "正在理解商品，生成的图片将逐张出现在这里" : "你的整套商品图会显示在这里"}</div>}
        </>}
        <CommerceContentCoverage plan={run?.checkpoint.plan || project.modelSnapshot?.commercePlan}/>
        <CommercePlanSummary value={run?.checkpoint.plan || project.modelSnapshot?.commercePlan} artDirection={run?.checkpoint.artDirection || project.modelSnapshot?.commerceArtDirection} references={run?.checkpoint.styleReferences || project.modelSnapshot?.commerceStyleReferences} adaptations={run?.checkpoint.adaptations || project.modelSnapshot?.commerceAdaptations} sectionIds={sections.map(s => s.id)} onSelect={setSelected}/>
        {(run?.checkpoint.plan || run?.checkpoint.agentSummary) && <details className="rounded-2xl border p-5 text-sm"><summary className="cursor-pointer">查看商品理解与设计方案</summary><div className="mt-3 space-y-3 leading-6"><p>{run.checkpoint.plan?.facts.join("；")}</p><p>{run.checkpoint.plan?.style}</p><p>{run.checkpoint.agentSummary}</p></div></details>}
      </div>
      <aside className="min-w-0 space-y-5">
      <section aria-label="商品信息与图片修改" className="space-y-5 rounded-2xl border p-5">
        {skin === "taobao" && view === "phone" && <details className="border-b pb-4"><summary className="cursor-pointer text-sm font-medium">商品页信息</summary><p className="mt-3 text-xs leading-5 text-muted-foreground">填写真实信息以预览淘宝页面；仅用于手机预览，不会写入图片或发布到店铺。</p><div className="mt-4 grid gap-3">{listingFields.map(([key, label]) => <label key={key} className="space-y-1 text-xs">{label}<Input value={listing[key] || ""} maxLength={300} onChange={e => setListing(current => ({ ...current, [key]: e.target.value }))}/></label>)}<Button size="sm" variant="outline" disabled={busy || active} onClick={() => act(async () => { const latest = await fetch(base, { cache: "no-store" }).then(read); await fetch(base, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelSnapshot: { ...latest.modelSnapshot, listingPreview: listing } }) }).then(read); toast.success("预览信息已保存"); })}>保存预览信息</Button></div></details>}
        <h2 className="font-medium">修改图片</h2><p className="text-sm text-muted-foreground">选择图片，描述想调整的内容。</p>
        <Select aria-label="选择图片" className="h-11 " value={selected} onValueChange={value => setSelected(value)}>{sections.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</Select>
        {section?.imageUrl && <button type="button" aria-label="放大当前图片" onClick={() => openImage(section.id)} className="relative block w-full overflow-hidden rounded-xl border bg-muted/20"><img className="h-44 w-full object-contain" src={section.imageUrl} alt={section.title}/>{displayProgress.find(image => image.sectionId === section.id)?.state === "generating" && <ImageGenerationLoading overlay label="正在更新图片"/>}<span className="absolute bottom-2 right-2 rounded-md bg-background/90 p-1.5"><Expand size={16}/></span></button>}
        {selectedReview?.passed === false && <p className="text-sm text-amber-700 dark:text-amber-400">需检查：{selectedReview.issues.join("；") || "请人工核对"}</p>}
        {section?.imageUrl && !selectedReview && <p className="text-xs text-muted-foreground">此版本暂无模型检查记录，请核对原图。</p>}
        <Textarea aria-label="图片修改要求" value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="例如：保留商品，把背景改为暖白色，标题缩短…" rows={4}/>
        {progress.find(i => i.sectionId === selected)?.error && <p className="text-xs text-amber-700 dark:text-amber-400">{progress.find(i => i.sectionId === selected)?.error}</p>}
        <Button className="w-full" disabled={busy || Boolean(active) || !section?.imageUrl || !instruction.trim()} onClick={() => start("edit")}>按要求修改</Button>
        <Button className="w-full" variant="outline" disabled={busy || Boolean(active) || !section || blockedSingle} onClick={() => start("regenerate")}>{section?.imageUrl ? "重新生成这张" : "生成这张图片"}</Button>
        {section?.imageUrl && <a href={section.imageUrl} download className="block text-center text-sm underline">下载当前图片</a>}
        {section?.versions?.length > 0 && <details><summary className="cursor-pointer text-sm">历史版本（{section.versions.length}）</summary><div className="mt-3 space-y-2">{section.versions.map((v: any) => <Button key={v.id} variant="outline" className="w-full" disabled={busy || Boolean(active) || v.isActive} onClick={() => act(() => fetch(`${base}/sections/${section.id}/versions/${v.id}/activate`, { method: "PATCH" }).then(read))}>版本 {v.versionNumber}{v.isActive ? " · 当前" : " · 切换"}</Button>)}</div></details>}
        <details className="border-t pt-4"><summary className="cursor-pointer text-sm">更多操作</summary><div className="mt-4 space-y-3"><label className="block text-sm">整页翻译<Select className="mt-2" value={language} onValueChange={value => setLanguage(value)}>{contentLanguageOptions.map(l => <option key={l} value={l}>{contentLanguageLabels[l]}</option>)}</Select></label><Button variant="outline" className="w-full" disabled={busy || Boolean(active) || !sections.length || sections.some(s => !s.imageUrl)} onClick={() => start("translate")}>翻译整套图片</Button><a className="block text-sm underline" href={`${base}/export/json`}>导出项目 JSON</a><Link className="block text-sm underline" href="/settings/providers">AI 配置</Link></div></details>
        <p className="text-xs leading-5 text-muted-foreground">自动检查不能保证消除所有错字或商品失真，发布前请核对。</p>
      </section>
      <DetailTaskTiming run={run} sections={sections}/>
      </aside>
    </div>
    {!completeDetails && details.length > 0 && <p className="text-xs text-muted-foreground">详情图尚未补齐，完整长图暂不可导出；已有图片可下载分图 ZIP。</p>}
    {connectionError && <p role="alert" className="rounded-xl border border-amber-300 p-4 text-sm">暂时无法刷新进度：{connectionError}。正在重连，后台任务不受页面刷新影响。</p>}
    {run ? <section aria-label="设计检查" className="space-y-4 rounded-2xl border bg-muted/30 p-5" aria-live="polite">
      {!!run.checkpoint.contentWarnings?.length && <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">内容整理提示 · 不影响生成</summary><ul className="mt-2 list-disc space-y-1 pl-4">{run.checkpoint.contentWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-medium">设计检查</h2><p className="mt-1 text-sm text-muted-foreground">{reviewOnly ? "图片已生成，部分需检查" : workflowStageLabels[run.stage] || run.stage}</p></div>{active && <Button variant="outline" disabled={busy} onClick={() => control("cancel")}>停止任务</Button>}</div>
    {pageReviewCurrent && pageReview && pageReview.passed === false && <div role="status" className="rounded-xl border border-amber-300/60 bg-amber-50/50 p-4 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-300"><p className="font-medium">整套设计需检查</p><ul className="mt-2 list-disc space-y-1 pl-4">{pageReview.issues.length ? pageReview.issues.map((issue, i) => <li key={i}>{issue.message}</li>) : <li>整套视觉检查未通过，请核对页面后修改。</li>}</ul></div>}
      {run.error && <p className="text-sm text-amber-700 dark:text-amber-400">{run.error}</p>}
      {(run.checkpoint as RunCheckpoint & { lastError?: { message?: string } }).lastError?.message && (run.checkpoint as RunCheckpoint & { lastError?: { message?: string } }).lastError?.message !== run.error && <p className="text-sm text-amber-700 dark:text-amber-400">{(run.checkpoint as RunCheckpoint & { lastError?: { message?: string } }).lastError?.message}</p>}
      {!!Object.keys(run.checkpoint.reviewErrors || {}).length && <p className="text-sm text-amber-700 dark:text-amber-400">{Object.keys(run.checkpoint.reviewErrors || {}).length} 张图片的质量检查暂未完成，图片已保存；继续任务可补做检查。</p>}
      {!!run.checkpoint.planningReview?.issues.length && <details open className="text-sm"><summary className="cursor-pointer">内容方案检查 · 草稿已保留</summary><ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">{run.checkpoint.planningReview.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></details>}
      {!!run.checkpoint.designReview?.issues.length && <details className="text-sm"><summary className="cursor-pointer">设计检查说明 · 方案与图片位置均保留</summary><ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">{run.checkpoint.designReview.issues.map((issue, i) => <li key={i}>{issue.resolved ? "已局部修正：" : "待检查："}{designIssueLabel(issue.message)}</li>)}</ul></details>}
      {gateNeedsEdit && <div className="text-sm"><p>首图需检查，其余图片可继续生成。可单独修改首图或切换版本，已完成图片会保留。</p><Button variant="outline" size="sm" className="mt-2" onClick={() => setSelected(gate.sectionId)}>选中首图调整</Button><ul className="mt-2 list-disc pl-4 text-muted-foreground">{progress[0]?.check?.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></div>}
      {run.status === "CANCELED" && <p className="text-sm text-muted-foreground">{run.draining ? "已停止安排后续请求，正在等待已发出的请求结束并保存结果；收尾完成后可继续。" : "任务已停止，已完成的图片和检查结果均已保留。"}</p>}
      {run.checkpoint.workflowVersion === 4 && needsPageReview && generated > 0 && !active && <p className="text-sm text-amber-700 dark:text-amber-400">整套质量检查尚未完成，不代表检查通过。继续任务会保留现有图片；结果不确定的请求默认跳过。</p>}
      {["INTERRUPTED", "PARTIAL", "FAILED", "CANCELED"].includes(run.status) && <div className="space-y-3">
        {uncertain && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={retryUncertain} onChange={e => setRetryUncertain(e.target.checked)}/>重试结果不确定的请求，可能产生额外费用</label>}
        {reviewOnly ? <p className="text-sm text-amber-700 dark:text-amber-400">图片已生成，检查结果仅作提示。请选中标记为需检查的图片核对或修改；已有图片和完整长图仍可下载。</p> : <Button disabled={busy || run.draining} onClick={() => control("resume", { retryUncertain })}>{run.draining ? "等待请求收尾" : uncertain && !retryUncertain ? "继续其余任务（跳过不确定请求）" : "继续未完成部分"}</Button>}
      </div>}
          {run.status === "WAITING_INPUT" && <SupplementalInfoDialog
            key={`${run.id}:${supplementalQuestionSetId(supplementalQuestions)}`}
            open={inputOpen} onOpenChange={setInputOpen} questions={supplementalQuestions} busy={busy}
            questionIssue={run.checkpoint.supplementalQuestionIssue} onPrepareSuggestions={() => control("suggestions")}
            onSubmit={submission => control("answers", submission)} onUpload={upload}
          />}
    </section> : loaded && !sections.some(s => s.imageUrl) && <section className="space-y-4 rounded-2xl border p-5"><p>素材已保存，启动后将自动完成分析、规划和整套图片生成。</p><Button disabled={busy} onClick={() => start()}>{busy ? "检测并启动中…" : "一键生成详情页"}</Button><label className="block text-sm">补充素材<input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={busy} onChange={e => { void upload(e.target.files); e.target.value = ""; }}/></label></section>}
    <Dialog.Root open={Boolean(expandedSection?.imageUrl)} onOpenChange={open => { if (!open) setExpanded(null); }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/75"/><Dialog.Content onCloseAutoFocus={event => { event.preventDefault(); expandedTrigger.current?.focus(); }} className="fixed inset-3 z-50 flex min-h-0 flex-col rounded-2xl border bg-background p-4 shadow-xl sm:inset-8"><div className="mb-3 flex items-center justify-between gap-3"><div className="min-w-0"><Dialog.Title className="truncate font-medium">{expandedSection?.title}</Dialog.Title><Dialog.Description className="mt-1 text-xs text-muted-foreground">当前生效版本 · 按原比例显示，可滚动查看 · Esc 关闭</Dialog.Description></div><Dialog.Close asChild><Button variant="ghost" aria-label="关闭原图"><X size={20}/></Button></Dialog.Close></div><div className="min-h-0 flex-1 overflow-auto rounded-lg bg-muted/30">{expandedSection?.imageUrl && <img src={expandedSection.imageUrl} alt={expandedSection.title} className="mx-auto block h-auto max-w-full"/>}</div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}

function ImageCard({ section, progress, selected, onSelect }: { section: any; progress: RunCheckpoint["images"]; selected: string; onSelect: (id: string) => void }) {
  const p = progress.find(i => i.sectionId === section.id);
  const review = imageReview(section, progress);
  return <button type="button" onClick={() => onSelect(section.id)} className={`block w-full overflow-hidden rounded-xl border text-left ${selected === section.id ? "ring-2 ring-slate-500" : ""}`}>
    <ProductImage section={section} progress={progress} square={section.type === "HERO"}/>
    <div className="bg-background p-3 text-sm"><span>{section.title}</span>{review && !review.passed && <p className="mt-1 text-amber-700 dark:text-amber-400">需检查：{review.issues.join("；") || "请人工核对"}</p>}{p?.error && <p className="mt-1 text-amber-700 dark:text-amber-400">{p.error}</p>}</div>
  </button>;
}
