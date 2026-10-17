import type { ApiUsageEntry } from "./api-usage";

export type UsageMetrics = {
  requests: number;
  success: number;
  failed: number;
  costUsd: number;
  priced: number;
  tokens: number;
  durationMs: number;
};

function emptyMetrics(): UsageMetrics {
  return { requests: 0, success: 0, failed: 0, costUsd: 0, priced: 0, tokens: 0, durationMs: 0 };
}

function addEntry(metrics: UsageMetrics, entry: ApiUsageEntry) {
  metrics.requests++;
  metrics[entry.success ? "success" : "failed"]++;
  const cost = entry.billing?.costUsd ?? entry.actualCostUsd;
  if (cost != null && Number.isFinite(cost) && cost >= 0) {
    metrics.costUsd += cost;
    metrics.priced++;
  }
  metrics.tokens += Math.max(0, entry.totalTokens ?? 0);
  metrics.durationMs += Math.max(0, entry.durationMs);
}

/** Aggregate the full filtered window before pagination; empty time buckets stay visible. */
export function buildUsageCharts(entries: ApiUsageEntry[], since: number, until: number) {
  const hours = (until - since) / 3_600_000;
  const bucketCount = hours <= 6 ? 12 : hours <= 72 ? 24 : hours <= 168 ? 28 : 30;
  const bucketMs = Math.max(1, (until - since) / bucketCount);
  const timeline = Array.from({ length: bucketCount }, (_, index) => ({
    ...emptyMetrics(),
    start: new Date(since + index * bucketMs).toISOString(),
    end: new Date(Math.min(until, since + (index + 1) * bucketMs)).toISOString(),
  }));
  const models = new Map<string, UsageMetrics>();
  const categories = new Map<string, UsageMetrics>();
  const projects = new Map<string, UsageMetrics>();
  const totals = emptyMetrics();
  const durations: number[] = [];
  let retriedRequests = 0;
  const errors = { rate_limited: 0, spending_limited: 0, auth_error: 0, other_error: 0 };

  for (const entry of entries) {
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < since || timestamp > until) continue;
    addEntry(totals, entry);
    const index = Math.min(bucketCount - 1, Math.floor((timestamp - since) / bucketMs));
    addEntry(timeline[index], entry);
    for (const [map, key] of [
      [models, entry.model || "未知模型"],
      [categories, entry.category],
      [projects, entry.projectId || "unassigned"],
    ] as const) {
      const metrics = map.get(key) ?? emptyMetrics();
      addEntry(metrics, entry);
      map.set(key, metrics);
    }
    if (entry.attemptCount > 1) retriedRequests++;
    if (!entry.success) errors[entry.quotaState in errors ? entry.quotaState as keyof typeof errors : "other_error"]++;
    durations.push(Math.max(0, entry.durationMs));
  }
  durations.sort((a, b) => a - b);
  const rows = (map: Map<string, UsageMetrics>) => Array.from(map, ([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key));
  return {
    timeline, totals, models: rows(models), categories: rows(categories), projects: rows(projects),
    retriedRequests, errors,
    p95DurationMs: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : 0,
  };
}

export type UsageChartData = ReturnType<typeof buildUsageCharts>;
