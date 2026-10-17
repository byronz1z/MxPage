"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BarChart3, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { UsageChartData, UsageMetrics } from "@/lib/monitor/usage-charts";
import { formatCostCny } from "@/lib/monitor/currency";

const compact = (value: number) => new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const seconds = (value: number) => `${(value / 1000).toFixed(1)}s`;
const time = (value: string, date = false) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", ...(date ? { month: "2-digit", day: "2-digit" } : {}), hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(value));

export const usageCategoryLabels: Record<string, string> = {
  models: "模型列表", chat: "文本生成", structured: "结构化输出", image_generation: "图像生成",
  image_edit: "图像编辑", google_generate_content: "Google 图像协议", unknown: "其他调用",
};
const categoryColors: Record<string, string> = {
  chat: "bg-blue-500", structured: "bg-violet-500", image_generation: "bg-amber-500",
  image_edit: "bg-teal-500", google_generate_content: "bg-sky-500", models: "bg-slate-400", unknown: "bg-slate-400",
};

function MetricSwitch<T extends string>({ value, options, onChange, label }: {
  value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; label: string;
}) {
  return <div role="group" aria-label={label} className="inline-flex shrink-0 gap-1 rounded-lg bg-muted/70 p-1">
    {options.map(option => <button key={option.value} type="button" aria-pressed={value === option.value}
      onClick={() => onChange(option.value)} className={cn("rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        value === option.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
      {option.label}
    </button>)}
  </div>;
}

function EmptyChart() {
  return <div className="flex min-h-44 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
    <BarChart3 aria-hidden="true" className="h-6 w-6 opacity-50" />
    当前筛选条件下暂无调用记录
  </div>;
}

export function RefreshUsageButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <Button variant="outline" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
    <RefreshCcw aria-hidden="true" className={cn("mr-2 h-4 w-4", pending && "animate-spin motion-reduce:animate-none")} />
    {pending ? "刷新中…" : "刷新数据"}
  </Button>;
}

function TrendChart({ data, usdToCny }: { data: UsageChartData; usdToCny: number }) {
  const [metric, setMetric] = useState<"requests" | "cost" | "duration">("requests");
  const [active, setActive] = useState<number | null>(null);
  const points = data.timeline;
  const value = (point: UsageMetrics) => metric === "requests" ? point.requests : metric === "cost" ? point.costUsd : point.requests ? point.durationMs / point.requests : 0;
  const format = (amount: number) => metric === "cost" ? formatCostCny(amount, usdToCny) : metric === "duration" ? seconds(amount) : `${compact(amount)} 次`;
  const peak = Math.max(...points.map(value), 0);
  const ceiling = metric === "requests" ? Math.max(2, Math.ceil(peak / 2) * 2) : peak || 1;
  const selected = active == null ? null : points[active];
  const hasDates = Date.parse(points.at(-1)!.end) - Date.parse(points[0].start) >= 86_400_000;
  const pointLabel = (point: typeof points[number]) => `${time(point.start, true)} – ${time(point.end, true)}：${metric === "cost" && point.priced === 0 && point.requests > 0 ? "未计价" : format(value(point))}，${point.success} 次成功，${point.failed} 次失败`;

  return <Card className="min-w-0 xl:col-span-2">
    <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 pb-3">
      <div className="space-y-1"><CardTitle>调用趋势</CardTitle><CardDescription>按时间段汇总 · 北京时间</CardDescription></div>
      <MetricSwitch label="趋势指标" value={metric} onChange={next => { setMetric(next); setActive(null); }} options={[
        { value: "requests", label: "调用量" }, { value: "cost", label: "费用" }, { value: "duration", label: "耗时" },
      ]} />
    </CardHeader>
    <CardContent>
      <div className="mb-5 flex min-h-8 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        {metric === "requests" ? <div className="flex gap-4"><span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-blue-500" />成功</span><span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-rose-500" />失败</span></div>
          : <span>{metric === "cost" ? "已记录费用（含估算）；未计价不视为免费" : "每段平均耗时，包含失败请求"}</span>}
        <span className="tabular-nums">{selected ? pointLabel(selected) : "悬停或聚焦柱条查看数据"}</span>
      </div>
      {data.totals.requests === 0 ? <EmptyChart /> : <>
        <div className="relative h-48 pl-16 sm:h-52">
          {[1, 0.5, 0].map(fraction => <div key={fraction} className="pointer-events-none absolute left-0 right-0 flex items-center gap-3" style={{ bottom: `${fraction * 100}%` }}>
            <span className="w-14 shrink-0 translate-y-1/2 text-right text-[10px] tabular-nums text-muted-foreground">{format(ceiling * fraction)}</span>
            <div className="w-full translate-y-1/2 border-t border-dashed border-border" />
          </div>)}
          <div className="relative grid h-full gap-1 sm:gap-2" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
            {points.map((point, index) => <button key={point.start} type="button" aria-label={pointLabel(point)} title={pointLabel(point)}
              onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(index)} onBlur={() => setActive(null)} onClick={() => setActive(index)}
              className={cn("relative flex h-full flex-col justify-end rounded-t-md outline-none focus-visible:ring-2 focus-visible:ring-ring", active === index && "bg-muted/60")}>
              {metric === "requests" ? <>
                <span className="w-full rounded-t-sm bg-rose-500" style={{ height: `${point.failed / ceiling * 100}%` }} />
                <span className={cn("w-full bg-blue-500", !point.failed && "rounded-t-sm")} style={{ height: `${point.success / ceiling * 100}%` }} />
              </> : <span className={cn("w-full rounded-t-sm", metric === "cost" ? "bg-teal-500" : "bg-violet-500")} style={{ height: `${value(point) / ceiling * 100}%` }} />}
            </button>)}
          </div>
        </div>
        <div className="mt-3 flex justify-between pl-16 text-[10px] tabular-nums text-muted-foreground">
          {[0, Math.floor(points.length / 2), points.length - 1].map((index, i) => <span key={index}>{time(i === 2 ? points[index].end : points[index].start, hasDates)}</span>)}
        </div>
      </>}
    </CardContent>
  </Card>;
}

function HealthChart({ data }: { data: UsageChartData }) {
  const { requests, success, failed } = data.totals;
  const rate = requests ? success / requests * 100 : 0;
  return <Card className="min-w-0">
    <CardHeader className="pb-3"><CardTitle>请求健康度</CardTitle><CardDescription>按最终结果统计，不重复计算内部重试</CardDescription></CardHeader>
    <CardContent>
      <div className="flex flex-wrap items-center justify-center gap-6 py-3">
        <div role="img" aria-label={requests ? `成功率 ${rate.toFixed(1)}%，成功 ${success} 次，失败 ${failed} 次` : "暂无调用记录"}
          className="grid h-36 w-36 shrink-0 place-items-center rounded-full bg-muted"
          style={requests ? { background: `conic-gradient(#14b8a6 0% ${rate}%, #f43f5e ${rate}% 100%)` } : undefined}>
          <div className="flex h-28 w-28 flex-col items-center justify-center rounded-full bg-card">
            <span className="text-2xl font-semibold tabular-nums">{requests ? `${rate.toFixed(1)}%` : "—"}</span><span className="mt-1 text-xs text-muted-foreground">成功率</span>
          </div>
        </div>
        <div className="space-y-3 text-sm">
          <p className="flex items-center gap-2"><i className="h-2 w-2 rounded-full bg-teal-500" />成功 <strong className="ml-2 tabular-nums">{success}</strong></p>
          <p className="flex items-center gap-2"><i className="h-2 w-2 rounded-full bg-rose-500" />失败 <strong className="ml-2 tabular-nums">{failed}</strong></p>
          <p className="text-xs text-muted-foreground">含重试 {data.retriedRequests} 次调用</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 border-t border-border pt-4 text-xs text-muted-foreground">
        {([["限流", data.errors.rate_limited], ["额度不足", data.errors.spending_limited], ["鉴权异常", data.errors.auth_error], ["其他失败", data.errors.other_error]] as const).map(([label, count]) => <p key={label} className="flex justify-between gap-2">{label}<span className={cn("tabular-nums", count > 0 && "font-semibold text-rose-600 dark:text-rose-300")}>{count}</span></p>)}
      </div>
    </CardContent>
  </Card>;
}

function Ranking({ rows, total, label, format, color = () => "bg-blue-500" }: {
  rows: Array<{ key: string; value: number; caption?: string }>; total: number;
  label: (key: string) => string; format: (value: number) => string; color?: (key: string) => string;
}) {
  if (!rows.length) return <EmptyChart />;
  const visible = [...rows].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key)).slice(0, 6);
  const max = Math.max(...visible.map(row => row.value), 1e-12);
  return <div className="space-y-4">
    {visible.map(row => <div key={row.key}>
      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
        <span title={label(row.key)} className="min-w-0 truncate font-medium">{label(row.key)}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{row.caption ?? format(row.value)}</span>
      </div>
      <div role="img" aria-label={`${label(row.key)}：${row.caption ?? format(row.value)}${total > 0 && !row.caption ? `，占 ${((row.value / total) * 100).toFixed(1)}%` : ""}`} className="h-2 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", color(row.key))} style={{ width: `${row.value / max * 100}%` }} />
      </div>
    </div>)}
    {rows.length > 6 && <p className="text-xs text-muted-foreground">展示前 6 项，其余 {rows.length - 6} 项共 {format(rows.reduce((sum, row) => sum + row.value, 0) - visible.reduce((sum, row) => sum + row.value, 0))}</p>}
  </div>;
}

export function UsageCharts({ data, projectNames, usdToCny }: { data: UsageChartData; projectNames: Record<string, string>; usdToCny: number }) {
  const [modelMetric, setModelMetric] = useState<"requests" | "costUsd" | "tokens">("requests");
  const modelValue = (value: number) => modelMetric === "costUsd" ? formatCostCny(value, usdToCny) : `${compact(value)} ${modelMetric === "tokens" ? "tokens" : "次"}`;
  return <section aria-label="API 用量图表" className="space-y-5">
    <div className="grid gap-5 xl:grid-cols-3"><TrendChart data={data} usdToCny={usdToCny} /><HealthChart data={data} /></div>
    <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
      <Card className="min-w-0">
        <CardHeader className="gap-3 pb-4"><div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>模型用量</CardTitle>
          <MetricSwitch label="模型排行指标" value={modelMetric} onChange={setModelMetric} options={[{ value: "requests", label: "调用" }, { value: "costUsd", label: "费用" }, { value: "tokens", label: "Token" }]} />
        </div><CardDescription>{modelMetric === "costUsd" ? `含估算费用 · ${data.totals.requests - data.totals.priced} 条未计价` : modelMetric === "tokens" ? "仅统计接口已返回的 Token 用量" : "定位使用最多的模型"}</CardDescription></CardHeader>
        <CardContent><Ranking rows={data.models.map(row => ({ key: row.key, value: row[modelMetric], caption: modelMetric === "costUsd" && !row.priced ? "未计价" : undefined }))} total={data.totals[modelMetric]} label={key => key} format={modelValue} color={() => modelMetric === "costUsd" ? "bg-teal-500" : modelMetric === "tokens" ? "bg-violet-500" : "bg-blue-500"} /></CardContent>
      </Card>
      <Card className="min-w-0">
        <CardHeader className="pb-4"><CardTitle>调用类型分布</CardTitle><CardDescription>识别文本与图像任务的调用占比</CardDescription></CardHeader>
        <CardContent><Ranking rows={data.categories.map(row => ({ key: row.key, value: row.requests }))} total={data.totals.requests} label={key => usageCategoryLabels[key] ?? key} format={value => `${value} 次 · ${(value / Math.max(1, data.totals.requests) * 100).toFixed(1)}%`} color={key => categoryColors[key] ?? "bg-slate-400"} /></CardContent>
      </Card>
      <Card className="min-w-0 lg:col-span-2 xl:col-span-1">
        <CardHeader className="pb-4"><CardTitle>项目调用排行</CardTitle><CardDescription>找出请求最密集的项目</CardDescription></CardHeader>
        <CardContent><Ranking rows={data.projects.map(row => ({ key: row.key, value: row.requests }))} total={data.totals.requests} label={key => key === "unassigned" ? "未归属项目" : projectNames[key] ?? key} format={value => `${compact(value)} 次`} color={() => "bg-violet-500"} /></CardContent>
      </Card>
    </div>
  </section>;
}
