import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUsageCharts } from "../lib/monitor/usage-charts";
import type { ApiUsageEntry } from "../lib/monitor/api-usage";

const start = Date.parse("2026-10-16T00:00:00Z");
const end = start + 86_400_000;
function entry(extra: Partial<ApiUsageEntry> = {}): ApiUsageEntry {
  return {
    id: "request", timestamp: new Date(start).toISOString(), providerBaseUrl: "https://example.test",
    endpoint: "/v1/chat/completions", finalEndpoint: null, method: "POST", model: "gpt-6-luna",
    projectId: "project-a", sectionId: null, operation: "test", category: "chat", success: true,
    statusCode: 200, durationMs: 1000, requestBytes: 10, responseBytes: 10, promptTokens: 10,
    completionTokens: 20, totalTokens: 30, actualCostUsd: null, attemptCount: 1, retrySummary: null,
    collapsedAttempts: [], quotaState: "ok", errorMessage: null, ...extra,
  };
}

test("timeline retains empty buckets and counts boundary timestamps exactly once", () => {
  const data = buildUsageCharts([
    entry(), entry({ timestamp: new Date(end).toISOString() }),
    entry({ timestamp: new Date(start - 1).toISOString() }),
    entry({ timestamp: new Date(end + 1).toISOString() }), entry({ timestamp: "invalid" }),
  ], start, end);
  assert.equal(data.timeline.length, 24);
  assert.equal(data.timeline[0].requests, 1);
  assert.equal(data.timeline.at(-1)!.requests, 1);
  assert.equal(data.timeline.filter(bucket => bucket.requests === 0).length, 22);
  assert.equal(data.totals.requests, 2);
  assert.equal(data.timeline.reduce((sum, point) => sum + point.requests, 0), 2);
});

test("all grouped metrics reconcile; retries are not counted as separate calls", () => {
  const data = buildUsageCharts([
    entry({ actualCostUsd: 0.2, attemptCount: 3 }),
    entry({ model: "gpt-image-2.5-flare", category: "image_edit", projectId: "project-b", actualCostUsd: 0.8, durationMs: 9000, totalTokens: 100 }),
    entry({ projectId: null, success: false, quotaState: "rate_limited", totalTokens: null, durationMs: 2000 }),
  ], start, end);
  assert.equal(data.totals.requests, 3);
  assert.equal(data.totals.success, 2);
  assert.equal(data.totals.failed, 1);
  assert.equal(data.retriedRequests, 1);
  assert.equal(data.errors.rate_limited, 1);
  assert.equal(data.p95DurationMs, 9000);
  assert.equal(data.totals.tokens, 130);
  for (const rows of [data.models, data.categories, data.projects, data.timeline]) {
    assert.equal(rows.reduce((sum, row) => sum + row.requests, 0), 3);
    assert.equal(rows.reduce((sum, row) => sum + row.costUsd, 0), 1);
    assert.equal(rows.reduce((sum, row) => sum + row.durationMs, 0), 12000);
  }
});

test("unknown prices remain distinct from known zero and snapshot estimates are honored", () => {
  const data = buildUsageCharts([
    entry({ model: "unpriced" }),
    entry({ model: "free", actualCostUsd: 0 }),
    entry({ model: "estimated", actualCostUsd: null, billing: { costUsd: 0.01, source: "tokens" } as ApiUsageEntry["billing"] }),
  ], start, end);
  assert.equal(data.totals.priced, 2);
  assert.equal(data.totals.costUsd, 0.01);
  assert.equal(data.models.find(row => row.key === "unpriced")!.priced, 0);
  assert.equal(data.models.find(row => row.key === "free")!.priced, 1);
});

test("empty and short time windows have stable zero-value chart states", () => {
  const data = buildUsageCharts([], start, start + 3_600_000);
  assert.equal(data.timeline.length, 12);
  assert.equal(data.totals.requests, 0);
  assert.equal(data.p95DurationMs, 0);
  assert.deepEqual(data.models, []);
  assert.ok(data.timeline.every(point => point.requests === 0 && point.costUsd === 0));
});
