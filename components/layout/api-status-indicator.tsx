"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ImageApiStatus } from "@/lib/monitor/provider-status";
import { cn } from "@/lib/utils";

const colors = { available: "bg-emerald-500", unavailable: "bg-rose-500", unverified: "bg-amber-400", unconfigured: "bg-slate-400" };
const labels = { available: "服务已连接", unavailable: "服务异常", unverified: "待连接验证", unconfigured: "未配置" };

export function ApiStatusIndicator() {
  const [status, setStatus] = useState<ImageApiStatus | null>(null);
  const [readError, setReadError] = useState(false);
  useEffect(() => {
    let stopped = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (document.hidden) return;
      controller?.abort();
      const active = new AbortController(); controller = active;
      try {
        const response = await fetch("/api/providers/status", { cache: "no-store", signal: active.signal });
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error("status unavailable");
        if (!stopped && !active.signal.aborted) { setStatus(payload.data); setReadError(false); }
      } catch {
        if (!stopped && !active.signal.aborted) setReadError(true);
      }
    };
    void load();
    const timer = window.setInterval(load, 30_000);
    window.addEventListener("focus", load);
    window.addEventListener("mxpage:provider-updated", load);
    window.addEventListener("storage", load);
    document.addEventListener("visibilitychange", load);
    return () => { stopped = true; controller?.abort(); clearInterval(timer); window.removeEventListener("focus", load); window.removeEventListener("mxpage:provider-updated", load); window.removeEventListener("storage", load); document.removeEventListener("visibilitychange", load); };
  }, []);
  const label = readError ? "状态读取失败" : status ? labels[status.state] : "读取状态中";
  const imageCheck = status?.imageVerification;
  const imageCheckLabel = imageCheck?.checkedAt
    ? `${imageCheck.source === "legacy-record" ? "历史图像验证" : "最近图像验证"}${imageCheck.state === "unavailable" ? "失败" : ""} ${new Date(imageCheck.checkedAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}`
    : status?.model ? "图像模型尚无验证记录" : "请选择图像模型";
  const description = `${readError ? "暂时无法读取服务状态，已保留上次验证记录。" : status?.note ?? "正在读取 API 状态。"}${status?.checkedAt ? ` 最近服务记录：${new Date(status.checkedAt).toLocaleString("zh-CN", { hour12: false })}。` : ""} ${imageCheckLabel}。图像验证仅依据该模型的实际生图或改图调用。${imageCheck?.source === "legacy-record" ? "历史记录未关联凭证，仅供参考，不能确认当前凭证的生图权限。" : ""}`;
  return <Link href="/settings/providers" title={description} aria-label={`${label} · ${status?.model ?? "未选择图像模型"}。${description}`} className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-2xl border border-border bg-background px-3 py-2 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
    <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", readError ? colors.unverified : status ? colors[status.state] : "bg-slate-400")} />
    <span className="shrink-0 text-muted-foreground">{label}</span><span className="h-3 w-px shrink-0 bg-border" />
    <span className="flex min-w-0 max-w-[260px] flex-col gap-0.5">
      <span className="truncate font-medium">{status?.model ?? "未选择图像模型"}</span>
      <span className={cn("text-[10px] leading-4", imageCheck?.state === "unavailable" ? "text-rose-500" : "text-muted-foreground")}>
        {imageCheckLabel}
      </span>
    </span>
  </Link>;
}
