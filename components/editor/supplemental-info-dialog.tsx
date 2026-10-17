"use client";

import { useEffect, useId, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, ArrowRight, Loader2, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { buildSupplementalSubmission, supplementalQuestionsReady, type SupplementalQuestion, type SupplementalSelection, type SupplementalSubmission } from "@/lib/detail-runs/supplemental-input";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questions: SupplementalQuestion[];
  questionIssue?: string;
  busy: boolean;
  onSubmit: (submission: SupplementalSubmission) => Promise<boolean>;
  onPrepareSuggestions: () => Promise<boolean>;
  onUpload: (files: FileList | null) => Promise<void>;
};

/** The parent keys by run + question revision; polling and closing do not clear the three answers. */
export function SupplementalInfoDialog({ open, onOpenChange, questions, questionIssue, busy, onSubmit, onPrepareSuggestions, onUpload }: Props) {
  const [selections, setSelections] = useState<Record<string, SupplementalSelection>>({});
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const prefix = useId();
  const disabled = busy || submitting;
  const ready = supplementalQuestionsReady(questions) && !questionIssue;
  const question = ready ? questions[step] : undefined;
  const selected = question ? selections[question.id] : undefined;
  const answered = selected?.mode === "custom" ? Boolean(selected.customText?.trim()) : selected?.mode === "option" && selected.optionIndex !== undefined;
  const submission = buildSupplementalSubmission(questions, selections);
  const last = step === 2;
  const name = `${prefix}-${question?.id}`;

  useEffect(() => { if (open && ready) titleRef.current?.focus(); }, [step, open, ready]);
  function select(patch: SupplementalSelection) {
    if (question) setSelections(current => ({ ...current, [question.id]: { ...current[question.id], ...patch } }));
  }
  async function next() {
    if (!answered || disabled || submittingRef.current) return;
    if (!last) { setStep(current => current + 1); return; }
    if (!submission) return;
    submittingRef.current = true;
    setSubmitting(true);
    try { if (await onSubmit(submission)) onOpenChange(false); }
    finally { submittingRef.current = false; setSubmitting(false); }
  }

  return <>
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-2xl focus:outline-none">
          <div className="relative shrink-0 border-b px-5 py-5 sm:px-6">
            <p role="status" aria-live="polite" className="mb-3 text-xs font-medium text-muted-foreground">{ready ? `确认商品信息 · 第 ${step + 1} / 3 题` : "补充信息 · 准备候选答案"}</p>
            <Dialog.Title ref={titleRef} tabIndex={-1} className="whitespace-pre-line pr-6 text-lg font-semibold leading-7 tracking-tight outline-none">{question?.text || "为这个商品生成具体选项"}</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-muted-foreground">
              {ready ? "以下为模型根据商品模拟推测的答案，数值并非实测。选择后用于本次设计稿；有准确数据请自行填写。最后一题统一提交。" : "根据商品图片和描述生成三组具体模拟答案；规格选项将包含数值与单位，保留已有规划。"}
            </Dialog.Description>
            {ready && <div aria-hidden="true" className="mt-4 flex gap-1.5">{[0, 1, 2].map(index => <span key={index} className={cn("h-1 flex-1 rounded-full", index <= step ? "bg-primary" : "bg-muted")} />)}</div>}
            <Dialog.Close asChild><Button variant="ghost" size="sm" className="absolute right-3 top-3 h-8 w-8 p-0" aria-label="暂时关闭补充信息"><X className="h-4 w-4" /></Button></Dialog.Close>
          </div>
          {question ? <form onSubmit={event => { event.preventDefault(); void next(); }} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
              <fieldset key={question.id} disabled={disabled} className="min-w-0 space-y-2.5">
                <legend className="sr-only">{question.text}</legend>
                {[...question.options, "自行填写"].map((option, optionIndex) => {
                  const custom = optionIndex === 3;
                  const checked = custom ? selected?.mode === "custom" : selected?.mode === "option" && selected.optionIndex === optionIndex;
                  return <label key={optionIndex} className={cn("flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 text-sm leading-6 transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2", checked ? "border-primary bg-primary/5" : "border-border bg-background/50 hover:bg-accent", disabled && "pointer-events-none opacity-60")}>
                    <input type="radio" name={name} value={custom ? "custom" : optionIndex} checked={checked} className="sr-only"
                      onChange={() => select(custom ? { mode: "custom" } : { mode: "option", optionIndex })} />
                    <span aria-hidden="true" className={cn("mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", checked ? "border-primary bg-primary" : "border-muted-foreground/50")}>
                      {checked && <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />}
                    </span>
                    <span className="min-w-0 break-words">{option}</span>
                  </label>;
                })}
                {selected?.mode === "custom" && <div className="pt-1">
                  <label htmlFor={`${name}-custom`} className="sr-only">自行填写：{question.text}</label>
                  <Textarea id={`${name}-custom`} value={selected.customText || ""} maxLength={1200} required placeholder="填写实际信息或你的要求…" className="min-h-24 resize-y"
                    onChange={event => select({ customText: event.target.value })} />
                  <p className="mt-1 text-right text-[11px] text-muted-foreground">{selected.customText?.length || 0} / 1200</p>
                </div>}
              </fieldset>
              <details className="mt-4 rounded-xl border border-dashed px-4 py-3 text-sm">
                <summary className="cursor-pointer text-muted-foreground"><Paperclip className="mr-1.5 inline h-3.5 w-3.5" />补充商品图片（可选）</summary>
                <label className="mt-3 block space-y-2"><span className="text-xs text-muted-foreground">可上传规格标签、细节或其他角度的图片。</span>
                  <Input type="file" accept="image/*" multiple disabled={disabled} aria-label="补充商品图片" onChange={event => { const input = event.currentTarget; void onUpload(input.files).finally(() => { input.value = ""; }); }} />
                </label>
              </details>
            </div>
            <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-card px-5 py-4 sm:px-6">
              {step > 0 ? <Button type="button" variant="ghost" disabled={disabled} onClick={() => setStep(current => current - 1)}><ArrowLeft className="mr-1.5 h-4 w-4" />上一题</Button>
                : <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>稍后填写</Button>}
              <Button type="submit" disabled={disabled || !answered || (last && !submission)}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{last ? "确认并继续生成" : "确认，下一题"}{!last && <ArrowRight className="ml-1.5 h-4 w-4" />}
              </Button>
            </div>
          </form> : <div className="space-y-4 p-5 sm:p-6">
            <p className="text-sm text-muted-foreground">将进行一次商品候选推断，不会重新生成图片。生成后依次确认三个问题。</p>
            <Button disabled={disabled} onClick={() => void onPrepareSuggestions()}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}生成具体选项</Button>
          </div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {!open && <Button variant="secondary" disabled={disabled} onClick={() => onOpenChange(true)}>打开补充信息</Button>}
  </>;
}
