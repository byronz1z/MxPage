"use client";
import React, { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import { formatTaskDuration, taskElapsed, type TaskDuration } from "@/lib/tasks/timing";

export function TaskTimer({ timing }: { timing: TaskDuration }) {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    setNow(Date.now());
    if (!timing.timerStartedAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [timing.timerStartedAt]);
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs tabular-nums text-muted-foreground" title={timing.timingEstimated ? "历史记录按已有时间戳估算" : "累计处理时间；暂停后继续会接着累计"}>
    <Clock3 aria-hidden="true" size={13}/>{timing.timerStartedAt ? "已用时" : "耗时"} {timing.timingEstimated ? "约 " : ""}{formatTaskDuration(now === undefined ? timing.elapsedMs : taskElapsed(timing, now))}
  </span>;
}
