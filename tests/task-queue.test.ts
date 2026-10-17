import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskQueue, nextQueueExpanded, taskIsRunning, taskShouldShow, type QueueRunRow, type QueueTaskRow } from "../lib/tasks/queue";
import { describeQueueRequest, dismissTaskRequest, hydrateTaskRequests, taskRequests, trackQueueRequest } from "../lib/tasks/client-requests";

const now = new Date("2026-10-16T09:00:00Z");
function task(extra: Partial<QueueTaskRow> = {}): QueueTaskRow {
  return { id: "task-1", projectId: "product", sectionId: null, taskType: "GENERATE", status: "RUNNING", inputPayload: {}, outputPayload: {}, errorMessage: null, startedAt: now, completedAt: null, createdAt: now, updatedAt: now, project: { name: "测试商品", platform: "taobao" }, ...extra };
}
function run(extra: Partial<QueueRunRow> = {}): QueueRunRow {
  return { id: "run-1", projectId: "product", idempotencyKey: "new", status: "RUNNING", stage: "GENERATE", input: { workflowVersion: 4, mode: "create", heroCount: 1, detailCount: 2 }, checkpoint: { images: [{ assetId: "image-1", state: "generated" }, { state: "generating" }, { state: "pending" }] }, leaseToken: "private", leaseUntil: new Date(now.getTime() + 60_000), error: null, createdAt: now, updatedAt: now, project: { name: "测试商品", platform: "taobao" }, ...extra };
}

test("all persisted work types appear with usable progress and project links", () => {
  const rows = buildTaskQueue([
    task({ id: "edit", taskType: "REGENERATE", status: "SUCCESS" }),
    task({ id: "translation", taskType: "TRANSLATE_PAGE", inputPayload: { workflow: "image-translation-v1" }, outputPayload: { images: [{ status: "COMPLETED" }, { status: "RUNNING" }] } }),
    task({ id: "analysis", taskType: "ANALYZE" }),
    task({ id: "export", taskType: "EXPORT", status: "SUCCESS" }),
    task({ id: "xhs-old", taskType: "XHS_GENERATE", outputPayload: { totalItems: 3, completedItems: 1 } }),
  ], [run(), run({ id: "xhs", input: { mode: "xhs" } }), run({ id: "edit-v4", input: { mode: "edit" } })], now.getTime());
  assert.equal(rows.length, 8);
  assert.deepEqual(new Set(rows.map(row => row.kind)), new Set(["detail", "xhs", "image", "translation", "analysis", "export"]));
  assert.equal(rows.find(row => row.id === "run:run-1")?.completed, 1);
  assert.equal(rows.find(row => row.id === "run:run-1")?.total, 3);
  assert.equal(rows.find(row => row.id === "run:xhs")?.href, "/xiaohongshu?project=product");
  assert.equal(rows.find(row => row.id === "task:translation")?.completed, 1);
  assert.equal(rows.find(row => row.id === "task:export")?.completed, 1);
});

test("batch records replace their child runs and translation tasks", () => {
  const batch = task({ id: "batch", taskType: "BATCH_CREATE", inputPayload: { workflow: "detail-batch-v1", translations: ["en-US"] }, outputPayload: { items: [{ runId: "run-1", status: "COMPLETED" }, { translationTaskId: "child", status: "RUNNING" }] } });
  const rows = buildTaskQueue([batch, task({ id: "child" }), task({ id: "new-child", inputPayload: { batchId: "batch" } })], [run(), run({ id: "new-run", idempotencyKey: "batch:batch" })], now.getTime());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].href, "/translate?batch=batch");
  assert.deepEqual([rows[0].completed, rows[0].total, rows[0].unit], [1, 2, "套"]);
  const detail = buildTaskQueue([{ ...batch, inputPayload: { workflow: "detail-batch-v1" } }], [], now.getTime())[0];
  assert.equal(detail.href, "/?batch=batch");
  assert.equal(detail.kind, "batch");
});

test("partial results remain partial and stale workers are presented as interrupted without mutation", () => {
  const stale = run({ leaseUntil: new Date(now.getTime() - 1) });
  const staleTask = task({ id: "stale", inputPayload: { workflow: "detail-batch-v1" }, updatedAt: new Date(now.getTime() - 100_000) });
  const rows = buildTaskQueue([staleTask, task({ id: "failed", status: "FAILED", outputPayload: { totalItems: 4, completedItems: 3, failedItems: 1 } })], [stale], now.getTime());
  assert.equal(rows.find(row => row.id === "task:failed")?.completed, 3);
  assert.equal(rows.filter(row => row.status === "INTERRUPTED").length, 2);
  assert.equal(rows.some(taskIsRunning), false);
  assert.equal(stale.status, "RUNNING");
  assert.equal(staleTask.status, "RUNNING");
});

test("only public summary metadata leaves the queue projection", () => {
  const rows = buildTaskQueue([task({ inputPayload: { apiKey: "private-key", prompt: "private-copy" }, outputPayload: { base64: "private-image" } })], [run({ input: { apiKey: "private-key" }, checkpoint: { plan: { secret: "private-plan" }, images: [] } })], now.getTime());
  assert.doesNotMatch(JSON.stringify(rows), /private-|leaseToken|inputPayload|checkpoint|base64/);
});

test("empty and attention-only queues start collapsed; newly running work opens once", () => {
  assert.equal(nextQueueExpanded(false, [], []), false);
  assert.equal(nextQueueExpanded(false, [], ["one"]), true);
  assert.equal(nextQueueExpanded(false, ["one"], ["one"]), false, "Manual collapse survives polling");
  assert.equal(nextQueueExpanded(false, ["one"], ["one", "two"]), true);
  assert.equal(nextQueueExpanded(true, ["one", "two"], ["two"]), true);
  assert.equal(nextQueueExpanded(true, ["two"], []), false, "Completion collapses without deleting history");
  assert.equal(nextQueueExpanded(true, [], []), true, "User can reopen tasks needing attention");
});

test("successful tasks disappear while partial failures and actionable runs remain", () => {
  const rows = buildTaskQueue([
    task({ id: "success", status: "SUCCESS" }),
    task({ id: "canceled", status: "CANCELED" }),
    task({ id: "failed", status: "FAILED" }),
    task({ id: "partly-successful", status: "SUCCESS", outputPayload: { totalItems: 2, completedItems: 1, failedItems: 1 } }),
  ], [
    run({ id: "complete", status: "COMPLETED" }),
    run({ id: "review", status: "PARTIAL" }),
    run({ id: "input", status: "WAITING_INPUT" }),
    run(),
  ], now.getTime());
  assert.deepEqual(new Set(rows.filter(taskShouldShow).map(row => row.id)), new Set(["task:failed", "task:partly-successful", "run:review", "run:input", "run:run-1"]));
  assert.equal(rows.length, 8, "Visibility filtering does not delete source records");
});

test("only synchronous unpersisted jobs get client entries, not provider probes or polling", () => {
  assert.equal(describeQueueRequest("/api/projects/p/brief", "POST")?.kind, "analysis");
  assert.equal(describeQueueRequest("/api/xiaohongshu/plan", "POST")?.kind, "xhs");
  for (const [url, method] of [["/api/providers/test", "POST"], ["/api/projects/p/brief", "GET"], ["/api/tasks/queue", "GET"], ["/api/detail-batches", "POST"]]) assert.equal(describeQueueRequest(url, method), null);
});

test("refresh restores interrupted request metadata, never resends requests", () => {
  const storage = new Map<string, string>();
  storage.set("mxpage:request-queue:v1", JSON.stringify([{ id: "request:prior", sourceId: "prior", source: "request", kind: "analysis", title: "识别", href: "/projects/p/configure", status: "RUNNING", createdAt: now.toISOString(), updatedAt: now.toISOString(), completed: 0, total: 1, failed: 0, unit: "项" }, { id: "bad", kind: "missing" }]));
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, configurable: true });
  hydrateTaskRequests();
  assert.equal(taskRequests.getState().entries.length, 1);
  assert.equal(taskRequests.getState().entries[0].status, "INTERRUPTED");
  dismissTaskRequest("request:prior");
  assert.equal(taskRequests.getState().entries.length, 0);
});

test("in-flight requests stay tracked with no component subscription and return the original unread response", async () => {
  let resolve!: (value: Response) => void;
  const response = Response.json({ success: true, data: { result: "original" } });
  let calls = 0;
  const request = trackQueueRequest("/api/projects/p/brief", "POST", () => { calls++; return new Promise(done => { resolve = done; }); });
  const item = taskRequests.getState().entries[0];
  assert.equal(item.status, "RUNNING");
  dismissTaskRequest(item.id);
  assert.equal(taskRequests.getState().entries[0].id, item.id);
  await Promise.resolve(); resolve(response);
  assert.equal(await request, response);
  assert.equal(response.bodyUsed, false);
  assert.equal(calls, 1);
  assert.equal(taskRequests.getState().entries[0].status, "SUCCESS");
  assert.equal(taskRequests.getState().entries[0].completed, 1);
  assert.equal(taskShouldShow(taskRequests.getState().entries[0]), false);
});

test("failed and thrown requests are recorded once without automatic retries", async () => {
  let calls = 0;
  const failed = Response.json({ error: "timeout" }, { status: 504 });
  assert.equal(await trackQueueRequest("/api/xiaohongshu/plan", "POST", async () => { calls++; return failed; }), failed);
  assert.equal(taskRequests.getState().entries[0].status, "FAILED");
  assert.equal(taskRequests.getState().entries[0].completed, 0);
  assert.equal(taskShouldShow(taskRequests.getState().entries[0]), true);
  await assert.rejects(trackQueueRequest("/api/xiaohongshu/edit", "POST", () => { calls++; throw new Error("connection lost"); }), /connection lost/);
  assert.equal(taskRequests.getState().entries[0].status, "FAILED");
  assert.equal(calls, 2);
});
