"use client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { X, Download } from "lucide-react";
import { agentFetch } from "@/lib/agent/client";
export function ArtifactPreview({ artifact }: { artifact: { id: string; name: string; kind: string; mimeType: string } }) {
  const [preview, setPreview] = useState<{ text?: string; image?: string; truncated?: boolean } | null>(null);
  const [error, setError] = useState("");
  const load = async (open: boolean) => {
    if (!open || preview) return;
    try { setPreview(await agentFetch(`/api/agent/artifacts/${artifact.id}/preview`)); }
    catch (error) { setError(error instanceof Error ? error.message : "暂时无法预览"); }
  };
  return <Dialog.Root onOpenChange={load}><Dialog.Trigger className="min-w-0 flex-1 truncate text-left text-xs hover:underline" aria-label={`预览 ${artifact.name}`}>{artifact.name}</Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[60] bg-black/40" /><Dialog.Content className="fixed left-1/2 top-1/2 z-[60] flex max-h-[85dvh] w-[min(92vw,900px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border bg-card p-6"><Dialog.Title className="pr-8 font-semibold">{artifact.name}</Dialog.Title><Dialog.Description className="mt-2 text-xs text-muted-foreground">文档文字预览。下载可查看原始排版与完整内容。</Dialog.Description><Dialog.Close aria-label="关闭预览" className="absolute right-5 top-5"><X className="h-5 w-5" /></Dialog.Close><div className="my-5 overflow-auto whitespace-pre-wrap break-words text-sm leading-7">{error || (!preview && "正在读取文件…")}{preview?.image ? <img src={preview.image} alt={artifact.name} className="max-h-[60dvh] object-contain" /> : artifact.name.endsWith(".md") ? <Markdown remarkPlugins={[remarkGfm]}>{preview?.text || ""}</Markdown> : preview?.text}{preview?.truncated && <p className="mt-3 text-muted-foreground">预览已截断，请下载查看全文。</p>}</div><a className="flex items-center gap-2 text-sm underline" href={`/api/agent/artifacts/${artifact.id}?download=1`}><Download className="h-4 w-4" />下载原文件</a></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
