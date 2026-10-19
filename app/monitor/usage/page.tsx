import { Select } from "@/components/ui/select";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Coins, Filter, RefreshCcw } from "lucide-react";
import Link from "next/link";

import { ClearUsageButton } from "@/components/monitor/clear-usage-button";
import { BillingSettings } from "@/components/monitor/billing-settings";
import { RefreshUsageButton, UsageCharts } from "@/components/monitor/usage-charts";
import { getBillingRules } from "@/lib/monitor/billing-settings";
import { billingSourceLabels } from "@/lib/monitor/billing";
import { formatCostCny } from "@/lib/monitor/currency";
import { DeleteUsageEntryButton } from "@/components/monitor/delete-usage-entry-button";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/db/prisma";
import { getApiUsageSummary, humanizeApiMonitorMessage, type ApiUsageEntry } from "@/lib/monitor/api-usage";

export const dynamic = "force-dynamic";

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function readSingle(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function projectLabel(projectId: string, projectNames: Map<string, string>) {
  if (projectId === "unassigned") {
    return "未归属项目";
  }
  return projectNames.get(projectId) ?? projectId;
}

function displayMonitorError(message: string | null | undefined, statusCode?: number | null) {
  return humanizeApiMonitorMessage({
    message,
    statusCode: statusCode ?? null,
  });
}

function buildMonitorPageHref(params: {
  hours: number;
  projectId: string;
  category: string;
  quotaState: string;
  success: string;
  page: number;
}) {
  const search = new URLSearchParams();
  search.set("hours", String(params.hours));
  search.set("projectId", params.projectId);
  search.set("category", params.category);
  search.set("quotaState", params.quotaState);
  search.set("success", params.success);
  search.set("page", String(params.page));
  return `/monitor/usage?${search.toString()}`;
}

export default async function ApiUsageMonitorPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const requestedHours = Number(readSingle(searchParams?.hours) ?? "24");
  const hours = Number.isFinite(requestedHours) ? Math.max(1, Math.min(24 * 30, requestedHours)) : 24;
  const projectId = readSingle(searchParams?.projectId) ?? "all";
  const category = readSingle(searchParams?.category) ?? "all";
  const quotaState = readSingle(searchParams?.quotaState) ?? "all";
  const success = readSingle(searchParams?.success) ?? "all";
  const page = Number(readSingle(searchParams?.page) ?? "1");
  const currentPage = Number.isFinite(page) ? Math.max(1, page) : 1;

  const summary = await getApiUsageSummary({
    hours: Number.isFinite(hours) ? Math.max(1, Math.min(24 * 30, hours)) : 24,
    limit: 12,
    page: currentPage,
    projectId: projectId === "all" ? null : projectId,
    category: category as never,
    quotaState: quotaState as never,
    success: success as never,
  });

  const allProjectIds = [
    ...summary.charts.projects.map((item) => item.key),
    ...(projectId !== "all" ? [projectId] : []),
    ...summary.recentEntries.map((entry) => entry.projectId).filter(Boolean),
  ].filter((value): value is string => Boolean(value) && value !== "unassigned");

  const projects = allProjectIds.length
    ? await prisma.project.findMany({
        where: { id: { in: [...new Set(allProjectIds)] } },
        select: { id: true, name: true },
      })
    : [];
  const projectNames = new Map(projects.map((item) => [item.id, item.name]));

  const filterProjectOptions = [...new Set(allProjectIds)];
  const billingRules = await getBillingRules();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="API 监控"
        title="API 用量总览"
        description="观察调用趋势、费用与响应表现，快速定位高用量模型和失败请求。"
        actions={<><RefreshUsageButton /><ClearUsageButton /></>}
      />

      <Card className="rounded-2xl">
        <CardContent className="overflow-x-auto p-4">
          <form aria-label="监控筛选" className="grid min-w-[780px] grid-cols-[1fr_1.4fr_1fr_0.85fr_1fr_auto] items-end gap-3" method="GET">
            <label className="min-w-0 space-y-1.5 text-xs">
              <span className="text-muted-foreground">时间范围</span>
              <Select aria-label="时间范围" className="h-9 text-xs" name="hours" defaultValue={String(hours)}>
                <option value="1">最近 1 小时</option>
                <option value="6">最近 6 小时</option>
                <option value="24">最近 24 小时</option>
                <option value="72">最近 3 天</option>
                <option value="168">最近 7 天</option>
                <option value="720">最近 30 天</option>
                {![1, 6, 24, 72, 168, 720].includes(hours) && <option value={String(hours)}>最近 {hours} 小时</option>}
              </Select>
            </label>
            <label className="min-w-0 space-y-1.5 text-xs">
              <span className="text-muted-foreground">项目</span>
              <Select aria-label="项目" className="h-9 text-xs" name="projectId" defaultValue={projectId}>
                <option value="all">全部项目</option>
                {filterProjectOptions.map((id) => (
                  <option key={id} value={id}>
                    {projectLabel(id, projectNames)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="min-w-0 space-y-1.5 text-xs">
              <span className="text-muted-foreground">调用类型</span>
              <Select aria-label="调用类型" className="h-9 text-xs" name="category" defaultValue={category}>
                <option value="all">全部类型</option>
                <option value="models">模型列表</option>
                <option value="chat">文本生成</option>
                <option value="structured">结构化输出</option>
                <option value="image_generation">图像生成</option>
                <option value="image_edit">图像编辑</option>
                <option value="google_generate_content">Google 图像协议</option>
              </Select>
            </label>
            <label className="min-w-0 space-y-1.5 text-xs">
              <span className="text-muted-foreground">状态</span>
              <Select aria-label="状态" className="h-9 text-xs" name="success" defaultValue={success}>
                <option value="all">全部状态</option>
                <option value="success">仅成功</option>
                <option value="failed">仅失败</option>
              </Select>
            </label>
            <label className="min-w-0 space-y-1.5 text-xs">
              <span className="text-muted-foreground">额度 / 限流</span>
              <Select aria-label="额度 / 限流" className="h-9 text-xs" name="quotaState" defaultValue={quotaState}>
                <option value="all">全部</option>
                <option value="spending_limited">额度已满</option>
                <option value="rate_limited">限流</option>
                <option value="auth_error">鉴权异常</option>
                <option value="other_error">其他错误</option>
                <option value="ok">正常</option>
              </Select>
            </label>
            <div className="flex justify-end">
              <input type="hidden" name="page" value="1" />
              <button
                type="submit"
                className="inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-xl bg-primary px-3 text-xs font-medium text-primary-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <Filter className="mr-2 h-4 w-4" />
                应用筛选
              </button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardContent className="flex items-center justify-between pt-6">
            <div>
              <p className="text-sm text-muted-foreground">总调用</p>
              <p className="mt-2 text-3xl font-semibold">{summary.totalRequests}</p>
              <p className="mt-1 text-xs text-muted-foreground">图像 {summary.imageRequests} 次 · 文本 {summary.chatRequests} 次</p>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 dark:bg-white/8">
              <Activity className="h-5 w-5 text-slate-700 dark:text-slate-200" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between pt-6">
            <div>
              <p className="text-sm text-muted-foreground">成功率</p>
              <p className="mt-2 text-3xl font-semibold">{summary.totalRequests ? `${(summary.successRequests / summary.totalRequests * 100).toFixed(1)}%` : "—"}</p>
              <p className="mt-1 text-xs text-muted-foreground">成功 {summary.successRequests} 次 · 失败 {summary.failedRequests} 次</p>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-sky-50 dark:bg-sky-500/10">
              <CheckCircle2 className="h-5 w-5 text-sky-600 dark:text-sky-300" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between pt-6">
            <div>
              <p className="text-sm text-muted-foreground">平均响应耗时</p>
              <p className="mt-2 text-3xl font-semibold">{summary.totalRequests ? `${(summary.averageDurationMs / 1000).toFixed(1)}s` : "—"}</p>
              <p className="mt-1 text-xs text-muted-foreground">P95 {summary.totalRequests ? `${(summary.charts.p95DurationMs / 1000).toFixed(1)}s` : "—"} · 含失败请求</p>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 dark:bg-amber-500/10">
              <Clock3 className="h-5 w-5 text-amber-600 dark:text-amber-300" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-start justify-between gap-2 pt-6">
            <div>
              <p className="text-sm text-muted-foreground">已记录费用（含估算）</p>
              <p className="mt-2 break-all text-3xl font-semibold tabular-nums">
                {summary.costSamples + summary.estimatedCostSamples > 0 ? formatCostCny(summary.recordedCostUsd, billingRules.usdToCny) : "—"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                接口 {formatCostCny(summary.actualCostUsd, billingRules.usdToCny)} · 估算 {formatCostCny(summary.estimatedCostUsd, billingRules.usdToCny)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">另有 {summary.unknownCostSamples} 条未计价，未计入总额</p>
            </div>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-500/10">
              <Coins className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
            </div>
          </CardContent>
        </Card>
      </div>

      {summary.spendingLimitedRequests + summary.rateLimitedRequests > 0 && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200">
          <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
          当前筛选范围：{summary.spendingLimitedRequests} 次额度不足，{summary.rateLimitedRequests} 次限流。可通过上方筛选查看明细。
        </div>
      )}

      <p className="text-xs text-muted-foreground">费用单位：人民币（CNY） · 按 1 USD = {billingRules.usdToCny} CNY 估算折合，可在计费规则中调整汇率。</p>
      <UsageCharts key={`${hours}-${projectId}-${category}-${quotaState}-${success}`} data={summary.charts} projectNames={Object.fromEntries(projectNames)} usdToCny={billingRules.usdToCny} />

      <BillingSettings initialRules={billingRules}/>

      <Card>
        <CardHeader>
          <CardTitle>最近请求明细</CardTitle>
          <CardDescription>
            同一次逻辑调用的内部重试会折叠展示，只保留最终结果作为主记录。当前第 {summary.page} / {summary.totalPages} 页，共 {summary.totalRequests} 条记录。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {summary.recentEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有 API 调用记录。</p>
          ) : (
            summary.recentEntries.map((entry: ApiUsageEntry) => (
              <div key={entry.id} className="rounded-2xl border border-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={entry.success ? "success" : "destructive"}>{entry.success ? "成功" : "失败"}</Badge>
                    <Badge variant="outline">{entry.category}</Badge>
                    {entry.quotaState === "spending_limited" ? <Badge variant="warning">额度已满</Badge> : null}
                    {entry.quotaState === "rate_limited" ? <Badge variant="warning">限流</Badge> : null}
                    {entry.attemptCount > 1 ? (
                      <Badge variant="outline">
                        <RefreshCcw className="mr-1 h-3 w-3" />
                        重试 {entry.attemptCount} 次
                      </Badge>
                    ) : null}
                    <span className="text-xs text-muted-foreground">{formatTime(entry.timestamp)}</span>
                  </div>
                  <DeleteUsageEntryButton entryId={entry.id} />
                </div>

                <div className="mt-3 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-[1fr_1.45fr_1fr_0.85fr_1fr]">
                  <div className="min-w-0">
                    <p className="text-muted-foreground">项目</p>
                    <p className="break-words font-medium">{entry.projectId ? projectLabel(entry.projectId, projectNames) : "未归属"}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-muted-foreground">操作</p>
                    <p className="break-all font-mono text-[13px] font-semibold leading-5">{entry.operation ?? "未标记"}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-muted-foreground">模型</p>
                    <p className="break-all font-mono text-[13px] font-semibold leading-5">{entry.model ?? "未知模型"}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-muted-foreground">耗时</p>
                    <p className="flex items-center gap-1 font-medium">
                      <Clock3 className="h-3.5 w-3.5" />
                      {entry.durationMs} ms
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-muted-foreground">用量与费用</p>
                    <p className="break-words font-medium">
                      {entry.totalTokens !== null ? `${entry.totalTokens} tokens` : "未返回 tokens"}
                    </p>
                    <p className="mt-1 font-semibold">{formatCostCny(entry.billing?.costUsd, billingRules.usdToCny, 6)} <span className="text-xs font-normal text-muted-foreground">{billingSourceLabels[entry.billing?.source || "unknown"]}</span></p>
                  </div>
                </div>

                {entry.billing && <details className="mt-3 rounded-xl bg-muted/30 p-3 text-xs text-muted-foreground"><summary className="cursor-pointer">计费依据 · {billingSourceLabels[entry.billing.source]}</summary><div className="mt-2 space-y-2">{entry.billing.notes.map((note,i) => <p key={i}>{note}</p>)}<p>人民币费用按 1 USD = {billingRules.usdToCny} CNY 折算。</p>{entry.billing.tokens && <p>参与估算的 tokens：{Object.entries(entry.billing.tokens).map(([key,value]) => `${key}=${value}`).join(" · ")}</p>}{entry.billing.rates && <p>折合单价（人民币 / 100 万 tokens）：{Object.entries(entry.billing.rates).map(([key,value]) => `${key}=${formatCostCny(value, billingRules.usdToCny)}`).join(" · ")}</p>}</div></details>}

                <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                  <p className="flex items-start gap-2 break-all">
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-sky-500" />
                    {entry.protocol && <span>协议：{entry.protocol}</span>}
                    {entry.upstreamModel && <span>上游返回模型：{entry.upstreamModel}</span>}
                    {entry.upstreamTaskId && <span>上游任务：{entry.upstreamTaskId}</span>}
                    <span>最终命中端点：{entry.finalEndpoint ?? entry.endpoint}</span>
                  </p>
                  {entry.retrySummary ? (
                    <p className="flex items-start gap-2">
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${entry.success ? "bg-amber-500" : "bg-rose-500"}`} />
                      <span>
                        {entry.success ? "内部重试摘要：" : "中间失败摘要："}
                        {displayMonitorError(entry.retrySummary, entry.statusCode)}
                      </span>
                    </p>
                  ) : null}
                </div>

                {entry.collapsedAttempts.length > 1 ? (
                  <div className="mt-3 rounded-xl bg-slate-50 p-3 dark:bg-white/[0.04]">
                    <p className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                      {entry.success ? "内部重试明细（最终已成功）" : "内部重试明细"}
                    </p>
                    <div className="space-y-2">
                      {entry.collapsedAttempts.map((attempt, index) => (
                        <div key={`${entry.id}-${attempt.endpoint}-${index}`} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300">
                          <p>{attempt.success ? "成功" : "失败"} · {attempt.statusCode}</p>
                          <p className="mt-1 break-all">{attempt.endpoint}</p>
                          {attempt.errorMessage ? (
                            <p className="mt-1 text-rose-600 dark:text-rose-300">{displayMonitorError(attempt.errorMessage, attempt.statusCode)}</p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {!entry.success && entry.errorMessage ? (
                  <>
                    <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                      <p className="flex items-start gap-2">
                        <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-rose-500" />
                        <span>{displayMonitorError(entry.errorMessage, entry.statusCode)}</span>
                      </p>
                    </div>
                    <p className="hidden">{displayMonitorError(entry.errorMessage, entry.statusCode)}</p>
                  </>
                ) : null}
              </div>
            ))
          )}

          {summary.totalPages > 1 ? (
            <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                第 {summary.page} / {summary.totalPages} 页，每页 {summary.pageSize} 条
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={buildMonitorPageHref({
                    hours,
                    projectId,
                    category,
                    quotaState,
                    success,
                    page: Math.max(1, summary.page - 1),
                  })}
                  aria-disabled={summary.page <= 1}
                  className={`inline-flex h-10 items-center rounded-xl border px-4 text-sm transition ${
                    summary.page <= 1
                      ? "cursor-not-allowed border-border bg-muted text-muted-foreground opacity-60 pointer-events-none dark:bg-white/[0.04]"
                      : "border-border bg-white hover:bg-muted dark:border-white/10 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
                  }`}
                >
                  上一页
                </Link>

                {Array.from({ length: summary.totalPages }, (_, index) => index + 1)
                  .filter((value) => {
                    if (summary.totalPages <= 7) return true;
                    return (
                      value === 1 ||
                      value === summary.totalPages ||
                      Math.abs(value - summary.page) <= 1
                    );
                  })
                  .map((value, index, list) => {
                    const previous = list[index - 1];
                    const showGap = previous && value - previous > 1;
                    return (
                      <div key={value} className="flex items-center gap-2">
                        {showGap ? <span className="text-sm text-muted-foreground">…</span> : null}
                        <Link
                          href={buildMonitorPageHref({
                            hours,
                            projectId,
                            category,
                            quotaState,
                            success,
                            page: value,
                          })}
                          className={`inline-flex h-10 min-w-10 items-center justify-center rounded-xl border px-3 text-sm transition ${
                            value === summary.page
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-white hover:bg-muted dark:border-white/10 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
                          }`}
                        >
                          {value}
                        </Link>
                      </div>
                    );
                  })}

                <Link
                  href={buildMonitorPageHref({
                    hours,
                    projectId,
                    category,
                    quotaState,
                    success,
                    page: Math.min(summary.totalPages, summary.page + 1),
                  })}
                  aria-disabled={summary.page >= summary.totalPages}
                  className={`inline-flex h-10 items-center rounded-xl border px-4 text-sm transition ${
                    summary.page >= summary.totalPages
                      ? "cursor-not-allowed border-border bg-muted text-muted-foreground opacity-60 pointer-events-none dark:bg-white/[0.04]"
                      : "border-border bg-white hover:bg-muted dark:border-white/10 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
                  }`}
                >
                  下一页
                </Link>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
