"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ChevronLeft, ChevronRight, Layers3, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import type { ProjectHistoryPage } from "@/lib/services/project-history-service";
import { formatDate } from "@/lib/utils";
import { historyCategories, historyCategoryLabels, historyHref, historyPageNumbers } from "@/lib/utils/project-history";
import { platformLabels } from "@/types/domain";
import { workEntryHref } from "@/lib/utils/project-entry";

export function RecentProjectList({ history }: { history: ProjectHistoryPage }) {
  const { projects, category, page, totalPages, total, pageSize, counts } = history;
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!pendingDelete) return;

    setDeleting(true);
    try {
      const response = await fetch(`/api/projects/${pendingDelete.id}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message ?? "项目删除失败");
      setPendingDelete(null);
      // The server also clamps/redirects the page after deleting its last item.
      startTransition(() => router.refresh());
      toast.success("项目已移入回收站，可在设置 → 数据管理还原");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "项目删除失败，请重试");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6" aria-busy={refreshing}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <nav aria-label="作品分类" className="flex flex-wrap gap-2">
          {historyCategories.map(value => (
            <Link key={value} href={historyHref(value)} aria-current={category === value ? "page" : undefined} className={buttonVariants({ variant: category === value ? "default" : "outline", className: "gap-2" })}>
              {historyCategoryLabels[value]}<span className="text-xs tabular-nums opacity-70">{counts[value]}</span>
            </Link>
          ))}
        </nav>
        <p className="text-sm text-muted-foreground" role="status">共 {total} 个作品 · 每页 {pageSize} 个</p>
      </div>
      {projects.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border px-8 py-16 text-center">
          <Layers3 className="mx-auto mb-4 h-8 w-8 text-muted-foreground" />
          <p className="font-medium">{category === "all" ? "还没有作品" : `还没有${historyCategoryLabels[category]}作品`}</p>
          <p className="mt-2 text-sm text-muted-foreground">完成创作后，作品会自动保存在这里。</p>
          <Link href={category === "translation" ? "/translate" : category === "xiaohongshu" ? "/xiaohongshu" : "/"} className={buttonVariants({ variant: "outline", className: "mt-5" })}>开始创作</Link>
        </div>
      ) : <div className={`columns-1 gap-4 md:columns-2 xl:columns-4 ${refreshing ? "opacity-60" : ""}`}>
      {projects.map((project) => (
        <article key={project.id} className="group relative mb-4 break-inside-avoid overflow-hidden rounded-3xl border border-border bg-card shadow-sm transition-shadow hover:shadow-lg">
          <Link href={workEntryHref(project)} aria-label={`打开作品：${project.name}`} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground">
            {project.coverImageUrl ? <img src={project.coverThumbnailUrl || project.coverImageUrl} alt={project.name} loading="lazy" decoding="async" onError={event => { const image = event.currentTarget; const original = new URL(project.coverImageUrl!, window.location.href).href; if (image.src !== original) image.src = original; }} className="block h-auto min-h-52 w-full object-cover transition-transform duration-300 motion-reduce:transition-none group-hover:scale-[1.02]"/> : <div className="flex aspect-square items-center justify-center bg-muted text-muted-foreground"><Layers3 className="h-8 w-8"/></div>}
            <div className="project-card-overlay pointer-events-none absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/90 via-black/20 to-transparent p-5 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
              <h3 className="line-clamp-2 text-lg font-semibold">{project.name}</h3>
              <p className="mt-2 text-sm text-white/90">{platformLabels[project.platform as keyof typeof platformLabels] ?? project.platform} · {project.sectionCount} 个模块</p>
              <p className="mt-2 text-xs text-white/80">{formatDate(project.updatedAt)}</p>
              <span className="mt-3 text-sm">查看详情 ↗</span>
            </div>
          </Link>
          <span className="pointer-events-none absolute left-3 top-3 rounded-full border border-border bg-card/95 px-2.5 py-1 text-xs text-foreground">{historyCategoryLabels[project.category]}</span>
          <button type="button" disabled={deleting || refreshing} onClick={() => setPendingDelete({id:project.id,name:project.name})} aria-label={`删除项目 ${project.name}`} className="project-card-overlay absolute right-3 top-3 rounded-full border border-border bg-card p-2.5 text-foreground opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"><Trash2 className="h-4 w-4"/></button>
        </article>
      ))}
      </div>}

      <nav aria-label="作品分页" className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5">
        <p className="text-sm text-muted-foreground">第 {page} / {totalPages} 页{total > 0 && ` · 显示 ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} 项`}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {page > 1 ? <Link href={historyHref(category, page - 1)} rel="prev" className={buttonVariants({ variant: "outline", size: "sm" })}><ChevronLeft className="mr-1 h-4 w-4" />上一页</Link> : <Button variant="outline" size="sm" disabled><ChevronLeft className="mr-1 h-4 w-4" />上一页</Button>}
          {historyPageNumbers(page, totalPages).map((value, index) => value === "ellipsis" ? <span key={`ellipsis-${index}`} className="px-1 text-muted-foreground" aria-hidden>…</span> : <Link key={value} href={historyHref(category, value)} aria-label={`第 ${value} 页`} aria-current={page === value ? "page" : undefined} className={buttonVariants({ variant: page === value ? "default" : "outline", size: "sm", className: "min-w-9 tabular-nums" })}>{value}</Link>)}
          {page < totalPages ? <Link href={historyHref(category, page + 1)} rel="next" className={buttonVariants({ variant: "outline", size: "sm" })}>下一页<ChevronRight className="ml-1 h-4 w-4" /></Link> : <Button variant="outline" size="sm" disabled>下一页<ChevronRight className="ml-1 h-4 w-4" /></Button>}
        </div>
      </nav>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        loading={deleting}
        title={pendingDelete ? `删除项目「${pendingDelete.name}」？` : "删除项目？"}
        description="项目将移入回收站，原图、生成结果和版本记录全部保留，可在设置 → 数据管理还原。"
        confirmText="移入回收站"
        cancelText="暂不删除"
        destructive
        icon={<Trash2 className="h-5 w-5" />}
        onCancel={() => {
          if (!deleting) setPendingDelete(null);
        }}
        onConfirm={handleDelete}
      />
    </div>
  );
}
