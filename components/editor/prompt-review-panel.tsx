"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { PromptReview } from "@/lib/detail-runs/prompt-review";

export function PromptReviewPanel({ review, busy, onSubmit }: {
  review: PromptReview;
  busy: boolean;
  onSubmit: (action: "save-prompts" | "confirm-prompts", data: unknown) => Promise<boolean>;
}) {
  const [pages, setPages] = useState(review.pages);
  const [base, setBase] = useState(review);
  const [saved, setSaved] = useState(false);
  const confirmation = useRef<string>();
  const submitted = useRef<typeof pages>();
  const dirty = pages.some((page, index) => page.prompt !== base.pages[index]?.prompt);
  const conflict = review.revision !== base.revision;
  const valid = pages.length > 0 && pages.every(page => page.prompt.trim() && page.prompt.length <= 30000);
  // Polls and edits in another tab must not replace an unsaved local draft.
  useEffect(() => {
    if (review.revision === base.revision) return;
    const matchesSubmission = submitted.current?.every((page, index) => page.sectionId === review.pages[index]?.sectionId && page.prompt === review.pages[index]?.prompt);
    if (!dirty || matchesSubmission) { setBase(review); setPages(review.pages); submitted.current = undefined; }
  }, [review, base.revision, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function submit(confirm: boolean) {
    if (confirm) confirmation.current ??= crypto.randomUUID();
    submitted.current = pages;
    const success = await onSubmit(confirm ? "confirm-prompts" : "save-prompts", {
      revision: base.revision,
      pages: pages.map(({ sectionId, prompt }) => ({ sectionId, prompt })),
      ...(confirm ? { confirmationId: confirmation.current } : {}),
    });
    if (success && !confirm) setSaved(true);
  }
  if (!pages.length) return null;
  return <section aria-label="生成前提示词确认" className="space-y-5 rounded-2xl border bg-card p-5 sm:p-6">
    <div><h2 className="text-lg font-semibold">生成前，统一确认提示词</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">所有图片的完整提示词都在本页，可直接修改构图、背景和画面文字。统一确认后才会开始生成。</p></div>
    <div className="space-y-4">{pages.map((page, index) => <div key={page.sectionId} className="space-y-3 rounded-xl border p-4">
      <div><p className="text-xs text-muted-foreground">第 {index + 1} 张 · {page.kind === "HERO" ? "主图" : "详情图"}</p><h3 className="mt-1 font-medium">{page.title}</h3></div>
      <label className="block space-y-2 text-sm"><span>第 {index + 1} 页完整提示词</span><Textarea value={page.prompt} rows={8} maxLength={30000} disabled={busy} onChange={event => { const prompt = event.target.value; setPages(current => current.map(item => item.sectionId === page.sectionId ? { ...item, prompt } : item)); setSaved(false); confirmation.current = undefined; }} className="min-h-48 leading-6"/></label>
    </div>)}</div>
    <p className="text-xs leading-5 text-muted-foreground">如需修改图片上的文字，请同时更新提示词中的 Exact copy（画面文字）部分，避免出现互相冲突的要求。</p>
    {!valid && <p role="alert" className="text-sm text-amber-700">每页提示词均需填写，最多 30,000 字符。</p>}
    {conflict && <div role="alert" className="space-y-2 text-sm text-amber-700"><p>已保存的提示词有新版本，当前修改仍保留在此。请载入最新版本后再编辑和确认。</p><Button variant="outline" disabled={busy} onClick={() => { setBase(review); setPages(review.pages); confirmation.current = undefined; }}>放弃当前修改，载入最新版本</Button></div>}
    <div className="flex flex-wrap items-center gap-3 border-t pt-4"><Button variant="outline" disabled={busy || !valid || conflict} onClick={() => submit(false)}>保存修改</Button><Button disabled={busy || !valid || conflict} onClick={() => submit(true)}>{busy ? "正在提交…" : `确认全部 ${pages.length} 页并生成`}</Button><span role="status" className="text-sm text-muted-foreground">{dirty ? "有未保存的修改；确认时会一并保存" : saved ? "已保存，尚未开始生图" : "提示词已保存，等待确认"}</span></div>
  </section>;
}
