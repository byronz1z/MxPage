"use client";

import React, { useEffect, useState } from "react";
import { Clock3, Loader2 } from "lucide-react";
import { TaskTimer } from "@/components/tasks/task-timer";
import { formatTaskDuration, projectTaskDuration } from "@/lib/tasks/timing";
import { detailTimingRows, type DetailTimingRun, type DetailTimingRow, type TimingSection } from "@/lib/detail-runs/timing";

export function DetailTaskTiming({ run, sections }: { run: DetailTimingRun | null; sections: TimingSection[] }) {
  const [now, setNow] = useState<number>();
  const running = run?.status === "RUNNING" || run?.draining === true;
  useEffect(() => {
    setNow(Date.now());
    if (!running) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [running, run]);
  const rows = run ? detailTimingRows(run, sections, now) : [];
  const textRows = rows.filter(row => row.group === "text");
  const imageRows = rows.filter(row => row.group === "image");
  const reviewRows = rows.filter(row => row.group === "review");
  return <section aria-label="任务耗时" className="min-w-0 space-y-4 rounded-2xl border p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 font-medium"><Clock3 size={16} aria-hidden="true"/>任务耗时</h2>
      {run?.createdAt && run.updatedAt && <TaskTimer timing={projectTaskDuration({ status: running ? "RUNNING" : run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, timing: run.checkpoint.taskTiming })}/>}
    </div>
    {!run ? <p className="text-xs text-muted-foreground">任务开始后显示文本与每张图片的处理耗时。</p> : <>
      <TimingGroup title="文本处理" rows={textRows}/>
      <TimingGroup title={`图片生成 · ${imageRows.length} 张`} rows={imageRows}/>
      <details className="border-t pt-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">质量检查耗时</summary>
        <dl className="mt-3 space-y-3">{reviewRows.map(row => <TimingRow key={row.key} row={row}/>)}</dl>
      </details>
      <p className="text-[11px] leading-5 text-muted-foreground">分项为各步骤累计处理时间，图片并行生成时不能直接相加。历史明细优先取自已有请求记录，缺失项显示“未记录”。</p>
    </>}
  </section>;
}

function TimingGroup({ title, rows }: { title: string; rows: DetailTimingRow[] }) {
  return <div className="space-y-3 border-t pt-3"><h3 className="text-xs font-medium text-muted-foreground">{title}</h3><dl className="space-y-3">{rows.map(row => <TimingRow key={row.key} row={row}/>)}</dl></div>;
}

function TimingRow({ row }: { row: DetailTimingRow }) {
  const stateLabel = row.state === "running" ? "处理中" : row.state === "uncertain" ? "已中断" : row.state === "pending" ? "未开始" : "已完成";
  const duration = row.duration ? `${row.duration.timingEstimated ? "约 " : ""}${formatTaskDuration(row.duration.elapsedMs)}`
    : row.state === "pending" ? "未开始" : row.state === "running" ? "计时中" : "未记录";
  return <div className="flex items-start justify-between gap-3 text-xs" title={`${stateLabel}${row.source === "monitor" ? " · 来自 API 请求记录" : ""}`}>
    <dt className="min-w-0 break-words leading-5">{row.label}</dt>
    <dd className="flex shrink-0 items-center gap-1 whitespace-nowrap leading-5 tabular-nums text-muted-foreground">
      {row.state === "running" && <Loader2 size={12} aria-label="处理中" className="animate-spin motion-reduce:animate-none"/>}
      {row.state === "uncertain" && <span className="text-amber-600 dark:text-amber-400">中断 · </span>}{duration}
    </dd>
  </div>;
}
