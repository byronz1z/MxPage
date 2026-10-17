"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { hydrateTaskRequests, taskRequests } from "@/lib/tasks/client-requests";
import { queueKindLabels, taskStatusLabels, type TaskQueueItem } from "@/lib/tasks/queue";
import { projectTaskDuration } from "@/lib/tasks/timing";
import { TaskTimer } from "./task-timer";

export function TaskHistory() {
  const [items, setItems] = useState<TaskQueueItem[]>([]);
  const [kind, setKind] = useState("all"), [page, setPage] = useState(1);
  const [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const requests = useStore(taskRequests, state => state.entries);
  useEffect(() => {
    hydrateTaskRequests();
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch("/api/tasks/queue?history=1", { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!response.ok || !body.success || !Array.isArray(body.data)) throw new Error();
        if (!stopped) { setItems(body.data); setError(""); }
      } catch { if (!stopped) setError("暂时无法同步记录，已显示的耗时记录会保留。"); }
      finally { if (!stopped) { setLoading(false); timer = setTimeout(refresh, 5000); } }
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, []);
  const filtered = [...items, ...requests].filter(item => kind === "all" || item.kind === kind).sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const pages = Math.max(1, Math.ceil(filtered.length / 20)), currentPage = Math.min(page, pages);
  return <section className="space-y-6">
    <header><Link href="/history" className="text-sm text-muted-foreground">← 我的作品</Link><h1 className="mt-3 text-2xl font-semibold">任务耗时记录</h1><p className="mt-2 text-sm text-muted-foreground">查看详情页、翻译、小红书、图片处理、分析和导出的处理时间。保留最近 200 项服务端记录；本地识别记录仅保存在当前浏览器。</p></header>
    <div className="flex flex-wrap items-center gap-3"><label className="text-sm">任务类型 <select aria-label="任务类型" value={kind} onChange={event => { setKind(event.target.value); setPage(1); }} className="ml-2 rounded-xl border bg-background px-3 py-2"><option value="all">全部类型</option>{Object.entries(queueKindLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><span className="text-sm text-muted-foreground">{filtered.length} 项记录</span></div>
    {error && <p role="status" className="text-sm text-muted-foreground">{error}</p>}
    <div className="overflow-x-auto rounded-2xl border"><table className="w-full min-w-[540px] table-fixed text-left text-sm"><thead className="bg-muted/40 text-muted-foreground"><tr>{["任务", "状态", "处理耗时", ""].map((label,i) => <th key={i} className={`whitespace-nowrap px-3 py-3 font-medium ${["w-[38%]", "w-[23%]", "w-[25%]", "w-[14%]"][i]}`}>{label}</th>)}</tr></thead>
      <tbody>{filtered.slice((currentPage - 1) * 20, currentPage * 20).map(item => <tr key={item.id} className="border-t"><td className="px-3 py-4"><p className="truncate" title={item.title}>{item.title}</p><p className="mt-1 text-xs text-muted-foreground">{queueKindLabels[item.kind]} · {item.completed}/{item.total} {item.unit}</p><p className="mt-1 text-[11px] text-muted-foreground">{new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })}</p></td><td className="px-3 text-xs">{taskStatusLabels[item.status] || item.status}</td><td className="px-3"><TaskTimer timing={item.elapsedMs === undefined ? projectTaskDuration(item) : { elapsedMs: item.elapsedMs, timerStartedAt: item.status === "RUNNING" ? item.timerStartedAt : undefined, timingEstimated: item.timingEstimated }}/></td><td className="whitespace-nowrap px-3 text-xs"><Link className="underline underline-offset-4" href={item.href}>查看</Link></td></tr>)}</tbody></table>
      {!filtered.length && <p className="p-10 text-center text-sm text-muted-foreground">{loading ? "正在读取记录…" : "暂无任务记录"}</p>}
    </div>
    <div className="flex items-center justify-end gap-3"><Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</Button><span className="text-xs tabular-nums text-muted-foreground">{currentPage} / {pages}</span><Button variant="outline" size="sm" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>
    <p className="text-xs leading-5 text-muted-foreground">新任务累计处理时间，暂停后继续累计，不重复计算已完成的阶段。早期记录若缺少完整计时信息，会以“约”标示。</p>
  </section>;
}
