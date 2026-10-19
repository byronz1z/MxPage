"use client";
import { useState } from "react";
import { toast } from "sonner";
import { readApiResponse, requestErrorMessage } from "@/lib/utils/request-error";
import type { TaskQueueItem } from "@/lib/tasks/queue";

export function ImageTaskAction({ item }: { item: TaskQueueItem }) {
  const [busy, setBusy] = useState(false), [url, setUrl] = useState<string>();
  if (url || item.imageUrl) return <a className="text-xs underline" href={url || item.imageUrl} target="_blank" rel="noreferrer">查看恢复图片</a>;
  if (!item.canQueryImage) return null;
  return <button type="button" disabled={busy} className="text-xs underline disabled:opacity-50" onClick={async () => {
    setBusy(true);
    try {
      const task = await readApiResponse(await fetch(`/api/tasks/${item.sourceId}/query-image`, { method: "POST" }));
      setUrl(task.outputPayload?.imageUrl); toast.success("图片结果已保存，可在作品或历史版本中查看。");
    } catch (error) { toast.error(requestErrorMessage(error)); }
    finally { setBusy(false); }
  }}>{busy ? "正在查询原任务…" : "查询原结果（不重新生成）"}</button>;
}
