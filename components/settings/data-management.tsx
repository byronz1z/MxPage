"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import type { dataOverview, previewDataRestore } from "@/lib/storage/data-backups";
import type { listTrash } from "@/lib/services/recycle-bin";
type Overview = Awaited<ReturnType<typeof dataOverview>> & { trash: Awaited<ReturnType<typeof listTrash>> };
type Preview = Awaited<ReturnType<typeof previewDataRestore>>;
async function request(body?: unknown) {
  const response = await fetch("/api/data", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error?.message || "数据操作失败");
  return result.data;
}
export function DataManagement() {
  const [data, setData] = useState<Overview>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const reload = async () => setData(await request());
  useEffect(() => { void reload().catch(error => setError(error.message)); }, []);
  async function act(action: string, id?: string) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await request({ action, id });
      if (action === "preview") setPreview(result);
      else {
        setPreview(undefined);
        setMessage(action === "backup" ? "备份已完成，数据库和全部素材已保存。" : action === "untrash" ? "作品已还原，原图、结果与版本记录均保留。" : `恢复完成，补回 ${result.restored} 个作品。当前已有作品未被覆盖，恢复前已自动备份。`);
        await reload();
      }
    } catch (error) { setError(error instanceof Error ? error.message : "数据操作失败"); }
    finally { setBusy(false); }
  }
  return <div className="space-y-6">
    <h1 className="text-2xl font-semibold">数据管理</h1>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {busy && <p role="status" className="text-sm text-muted-foreground">正在校验或复制数据，请保持页面打开…</p>}
    {!data ? <Button disabled={busy} onClick={() => void reload().catch(error => setError(error.message))}>重新读取数据</Button> : <>
      <section className="space-y-3 rounded-2xl border p-6"><h2 className="font-semibold">当前数据位置</h2><p className="text-sm">{data.projects} 个作品（含回收站） · {data.assets} 个素材</p><dl className="space-y-2 break-all text-sm"><dt className="text-muted-foreground">数据库</dt><dd>{data.database}</dd><dt className="text-muted-foreground">素材目录</dt><dd>{data.storage}</dd><dt className="text-muted-foreground">备份目录</dt><dd>{data.backupDirectory}</dd></dl><p className="text-sm text-muted-foreground">桌面版和源码版可能使用不同的数据目录。若作品数量不符，请先核对位置。</p></section>
      <section className="space-y-4 rounded-2xl border p-6"><h2 className="font-semibold">备份与恢复</h2><p className="text-sm text-muted-foreground">备份保存数据库快照、原图、生成结果和历史版本素材。浏览器内的未提交上传草稿、个人设置和 API Key 不在恢复范围内。请将整个备份目录另存到其他磁盘；换机时复制回这里显示的备份目录后刷新。</p><Button disabled={busy} onClick={() => void act("backup")}>创建备份</Button><p className="text-sm text-muted-foreground">恢复前先校验并显示待补回作品；恢复只补回缺失作品，不覆盖同 ID 作品的当前内容。回收站中的作品请在下方还原。未完成任务不会自动调用模型。</p>
        <ul className="divide-y">{data.backups.map(backup => <li key={backup.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="text-sm">{new Date(backup.createdAt).toLocaleString()} · {backup.projects} 个作品 · {backup.files} 个素材</p><p className="break-all text-xs text-muted-foreground">{backup.id}</p></div><Button variant="outline" disabled={busy} onClick={() => void act("preview", backup.id)}>校验并预览恢复</Button></li>)}</ul>{!data.backups.length && <p className="text-sm text-muted-foreground">暂无完整备份。</p>}
      </section>
      <section className="space-y-4 rounded-2xl border p-6"><h2 className="font-semibold">回收站</h2><p className="text-sm text-muted-foreground">移入回收站的作品不显示在作品列表中，文件和版本记录完整保留，不会自动清理。</p><ul className="divide-y">{data.trash.map(project => <li key={project.id} className="flex items-center justify-between gap-3 py-3"><div><p>{project.name}</p><p className="text-xs text-muted-foreground">{new Date(project.trashedAt).toLocaleString()}</p></div><Button variant="outline" disabled={busy} onClick={() => void act("untrash", project.id)}>还原作品</Button></li>)}</ul>{!data.trash.length && <p className="text-sm text-muted-foreground">回收站为空。</p>}</section>
    </>}
    <ConfirmDialog open={!!preview} title="确认恢复缺失作品？" description={preview ? `校验通过，将补回 ${preview.missing.length} 个作品，保留 ${preview.preserved} 个已有作品。${preview.missing.slice(0, 5).map(project => project.name).join("、")}。恢复前会自动保存当前数据备份。` : ""} confirmText="恢复缺失作品" loading={busy} onCancel={() => { if (!busy) setPreview(undefined); }} onConfirm={() => preview && act("restore", preview.id)}/>
  </div>;
}
