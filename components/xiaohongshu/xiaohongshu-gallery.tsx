"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, Expand, ImageOff, Minimize2, X, ZoomIn } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { imageReview, ProductImage, type PreviewSection } from "@/components/editor/product-phone-preview";
import { ImageGenerationLoading } from "@/components/shared/image-generation-loading";
import type { ImageProgress } from "@/lib/detail-runs/contracts";

export type XhsGallerySection = Pick<PreviewSection, "id" | "title" | "imageUrl" | "currentImageAssetId" | "currentImageAsset">;
const previewSection = (section: XhsGallerySection): PreviewSection => ({ ...section, type: "CUSTOM", order: 0 });

function GalleryImage({ section, progress, original = false }: {
  section: XhsGallerySection; progress: ImageProgress[]; original?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  if (!section.imageUrl) return <div className="w-full max-w-xs"><ProductImage section={previewSection(section)} progress={progress}/></div>;
  if (failedUrl === section.imageUrl) return <div role="status" className="flex h-full min-h-24 flex-col items-center justify-center gap-2 p-3 text-center text-xs text-muted-foreground"><ImageOff size={24}/>图片加载失败，可下载原图或刷新页面。</div>;
  return <>
    <img src={section.imageUrl} alt={section.title} onError={() => setFailedUrl(section.imageUrl!)}
      className={original ? "block max-w-none shrink-0" : "block h-full w-full object-contain"}/>
    {progress.some(item => item.sectionId === section.id && item.state === "generating") && <ImageGenerationLoading overlay label="正在更新图片"/>}
  </>;
}

export function XiaohongshuGallery({ projectId, sections, progress }: {
  projectId: string; sections: XhsGallerySection[]; progress: ImageProgress[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [original, setOriginal] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const activeThumbnail = useRef<HTMLButtonElement | null>(null);
  const index = sections.findIndex(section => section.id === selectedId);
  const selected = sections[index];
  const review = selected ? imageReview(previewSection(selected), progress) : undefined;
  function select(id: string) { setSelectedId(id); setOriginal(false); }
  function move(offset: number) {
    if (sections.length && index >= 0) select(sections[(index + offset + sections.length) % sections.length].id);
  }
  useEffect(() => { activeThumbnail.current?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [selectedId]);
  if (!sections.length) return null;
  return <section aria-label="小红书配图画廊" className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-semibold">配图画廊 <span className="ml-1 text-sm font-normal text-muted-foreground">{sections.length} 页</span></h2><p className="mt-1 text-xs text-muted-foreground">点击缩略图查看大图，按左右方向键翻页。</p></div>
      <div className="flex items-center gap-4 text-sm"><Link className="underline underline-offset-4" href={`/projects/${projectId}/editor`}>修改图片</Link>{sections.some(s => s.imageUrl) && <a className="inline-flex items-center gap-1 underline underline-offset-4" href={`/api/projects/${projectId}/export/images`}><Download size={14}/>下载图片 ZIP</a>}</div>
    </div>
    <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
      {sections.map((section, i) => <div key={section.id} className="min-w-0 space-y-2">
        <button type="button" aria-label={`查看第 ${i + 1} 页：${section.title}`} aria-haspopup="dialog"
          onClick={event => { trigger.current = event.currentTarget; select(section.id); }}
          className="group relative flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-xl border bg-muted/40 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          <GalleryImage section={section} progress={progress}/>
          <span className="absolute left-2 top-2 rounded-md bg-black/65 px-2 py-1 text-xs tabular-nums text-white">{String(i + 1).padStart(2, "0")}</span>
          <span aria-hidden="true" className="absolute bottom-2 right-2 rounded-full bg-black/65 p-2 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><Expand size={15}/></span>
        </button>
        <p className="line-clamp-2 text-sm leading-5" title={section.title}>{section.title}</p>
        {imageReview(previewSection(section), progress)?.passed === false && <p className="text-xs text-amber-700 dark:text-amber-400">需检查</p>}
      </div>)}
    </div>
    <Dialog.Root open={!!selected} onOpenChange={open => { if (!open) setSelectedId(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"/>
        <Dialog.Content className="fixed inset-0 z-50 flex h-[100dvh] min-w-0 flex-col bg-background sm:inset-4 sm:h-[calc(100dvh-2rem)] sm:rounded-2xl sm:border sm:shadow-2xl"
          onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}
          onKeyDown={event => {
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (original && (event.target as HTMLElement).closest('[aria-label="原图，可滚动查看"]')) return;
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); move(event.key === "ArrowLeft" ? -1 : 1); }
          }}>
          {selected && <>
            <div className="flex shrink-0 items-center gap-3 border-b px-3 py-2 sm:px-5">
              <div className="min-w-0 flex-1"><Dialog.Title className="truncate text-sm font-semibold">{selected.title}</Dialog.Title><Dialog.Description className="mt-1 text-xs text-muted-foreground">第 {index + 1} / {sections.length} 页 · {original ? "原始尺寸，可滚动查看" : "完整画面"}</Dialog.Description></div>
              <Dialog.Close asChild><Button variant="ghost" className="h-11 w-11 shrink-0 p-0" aria-label="关闭画廊"><X size={20}/></Button></Dialog.Close>
            </div>
            <div key={`${selected.id}:${original}`} className="min-h-0 flex-1 overflow-auto bg-muted/40" role="region" aria-label={original ? "原图，可滚动查看" : "当前大图"} tabIndex={original ? 0 : undefined}>
              <div className={original ? "relative flex min-h-full w-max min-w-full items-center justify-center p-3" : "relative flex h-full items-center justify-center p-3 sm:p-5"}>
                <GalleryImage key={selected.id} section={selected} progress={progress} original={original}/>
              </div>
            </div>
            {review?.passed === false && <p role="status" className="max-h-20 shrink-0 overflow-y-auto border-t px-4 py-2 text-xs text-amber-700 dark:text-amber-400">本页需检查：{review.issues.join("；") || "请核对图片内容。"}</p>}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-3 py-2 sm:px-5">
              <div className="flex items-center gap-1"><Button variant="ghost" className="h-11 w-11 p-0" disabled={sections.length < 2} aria-label="上一页" onClick={() => move(-1)}><ChevronLeft size={20}/></Button><span className="min-w-12 text-center text-sm tabular-nums" aria-live="polite">{index + 1} / {sections.length}</span><Button variant="ghost" className="h-11 w-11 p-0" disabled={sections.length < 2} aria-label="下一页" onClick={() => move(1)}><ChevronRight size={20}/></Button></div>
              <div className="flex gap-1"><Button variant="ghost" className="h-11 gap-2 px-3" disabled={!selected.imageUrl} onClick={() => setOriginal(!original)}>{original ? <Minimize2 size={16}/> : <ZoomIn size={16}/>}<span>{original ? "适应窗口" : "原始尺寸"}</span></Button>
                {selected.imageUrl ? <a className={buttonVariants({ variant: "outline", className: "h-11 gap-2 px-3" })} href={selected.imageUrl} download><Download size={16}/>下载本页</a> : <Button variant="outline" className="h-11" disabled>下载本页</Button>}</div>
            </div>
            <div aria-label="选择画廊页码" className="flex shrink-0 gap-2 overflow-x-auto border-t px-4 py-3">
              {sections.map((section, i) => <button key={section.id} type="button" ref={section.id === selected.id ? activeThumbnail : undefined}
                aria-label={`跳到第 ${i + 1} 页：${section.title}`} aria-current={section.id === selected.id ? "page" : undefined}
                onClick={() => select(section.id)}
                className={`relative flex h-20 w-[60px] shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${section.id === selected.id ? "border-foreground ring-2 ring-foreground ring-offset-2 ring-offset-background" : "opacity-60 hover:opacity-100"}`}>
                {section.imageUrl ? <img src={section.imageUrl} alt="" className="h-full w-full object-contain"/> : <ImageOff size={18}/>}
                <span className="absolute bottom-0 inset-x-0 bg-black/65 text-center text-[10px] leading-5 text-white">{i + 1}</span>
              </button>)}
            </div>
          </>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </section>;
}
