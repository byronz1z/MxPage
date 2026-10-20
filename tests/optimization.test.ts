import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { readLastLines } from "../lib/monitor/log-tail";
import { imageCapabilities, commonImageOptions } from "../lib/ai/image-capabilities";
import { imageOutcome } from "../lib/tasks/image-outcome";
import { buildTaskQueue } from "../lib/tasks/queue";

let directory: string;
let db: typeof import("../lib/db/prisma").prisma;
let recover: typeof import("../lib/services/image-task-recovery");
let runtime: typeof import("../lib/services/provider-runtime");
let projectId: string, sectionId: string, snapshot: any;
const credential = { apiKey: "mock-only", baseUrl: "https://api.evolink.ai" };
const originalFetch = globalThis.fetch;
const requests: string[] = [];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6L8AAAAASUVORK5CYII=";
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mxpage-optimization-"));
  const filename = path.join(directory, "test.db");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const sqlite = new DatabaseSync(filename);
  for (const name of (await readdir("prisma/migrations")).sort()) if (!name.includes(".")) sqlite.exec(await readFile(`prisma/migrations/${name}/migration.sql`, "utf8"));
  sqlite.close();
  process.env.DATABASE_URL = `file:${filename.replaceAll("\\", "/")}`;
  process.env.STORAGE_ROOT = path.join(directory, "storage");
  delete process.env.LOCK_BASE_URL; delete process.env.FORCED_API_BASE; delete process.env.FORCED_API_BASE_URL;
  db = (await import("../lib/db/prisma")).prisma;
  recover = await import("../lib/services/image-task-recovery"); runtime = await import("../lib/services/provider-runtime");
  const provider = await db.providerConfig.create({ data: { name: "Mock", baseUrl: credential.baseUrl, apiKeyEncrypted: "unused", textProtocol: "auto", isActive: true } });
  snapshot = { id: provider.id, baseUrl: credential.baseUrl, models: [], textProtocol: "responses", structuredOutputMode: "json_schema", imageProtocol: "evolink_tasks", imageModelSettings: { "original-model-A": { protocol: "evolink_tasks" } } };
  const project = await db.project.create({ data: { name: "Mock project", platform: "general_ecommerce", style: "clean", sections: { create: { sectionKey: "hero-1", type: "HERO", title: "Image", goal: "test", copy: "copy", visualPrompt: "test", order: 0 } } }, include: { sections: true } });
  projectId = project.id; sectionId = project.sections[0].id;
  globalThis.fetch = async (input, init) => {
    const url = String(input); requests.push(url);
    assert.equal(init?.method || "GET", "GET", "recovery must never submit/probe/upload");
    if (url.startsWith("https://api.evolink.ai/v1/tasks/")) return Response.json({ id: decodeURIComponent(url.split("/").at(-1)!), status: "completed", results: ["https://mock-result.test/image.png"] });
    assert.equal(url, "https://mock-result.test/image.png");
    return new Response(Buffer.from(png, "base64"));
  };
});
after(async () => { globalThis.fetch = originalFetch; await db?.$disconnect(); if (directory && path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith("mxpage-optimization-")) await rm(directory, { recursive: true, force: true }); });
async function pendingTask(overrides: Record<string, unknown> = {}) {
  return db.generationTask.create({ data: { projectId, sectionId, taskType: "GENERATE", status: "FAILED", inputPayload: { providerSnapshot: snapshot }, outputPayload: { imageRecovery: { model: "original-model-A", prompt: "original prompt", copy: "original copy", baseImageAssetId: null }, upstreamImageTask: { id: `receipt-${requests.length}`, protocol: "evolink_tasks", status: "pending" }, imageOutcome: "pending_query", ...overrides } } });
}
test("bounded log tail handles UTF-8 split blocks, CRLF, partial lines and zero limit", async () => {
  const file = path.join(directory, "usage.jsonl");
  const rows = Array.from({ length: 7000 }, (_, i) => JSON.stringify({ id: i, text: "中文图像".repeat(5) }));
  await writeFile(file, `${rows.join("\r\n")}\r\n`, "utf8");
  assert.deepEqual(await readLastLines(file, 3), rows.slice(-3));
  assert.deepEqual(await readLastLines(file, 0), []);
  await writeFile(file, `${rows.join("\n")}\n{"partial":`, "utf8");
  assert.deepEqual(await readLastLines(file, 2), [rows.at(-1), '{"partial":']);
});
test("documented capabilities restrict options; unknown routes retain compatibility", () => {
  const known = imageCapabilities("https://api.evolink.ai", { modelId: "gpt-image-2.5-flare" });
  assert.equal(known.evidence, "documented"); assert.equal(known.routeVerified, false);
  const unknown = imageCapabilities("https://private.test/v1", { modelId: "custom-unchanged" });
  assert.equal(unknown.evidence, "inferred"); assert.equal(unknown.maxReferences, null); assert.ok(unknown.qualities.includes("max"));
  assert.deepEqual(commonImageOptions([known, unknown], "qualities"), known.qualities);
});
test("outcomes distinguish receipts, definite rejection, and transport uncertainty", () => {
  assert.equal(imageOutcome(new Error("timeout")), "uncertain");
  assert.equal(imageOutcome({ status: 401 }), "failed");
  assert.equal(imageOutcome({ status: 408 }), "uncertain");
  assert.equal(imageOutcome(new Error("invalid size"), undefined, false), "failed");
  assert.equal(imageOutcome({ status: 404 }, { id: "t", protocol: "evolink_tasks", status: "pending" }), "pending_query");
});
test("query-only recovery saves once, preserves original model and is idempotent", async () => {
  const task = await pendingTask();
  await db.providerConfig.update({ where: { id: snapshot.id }, data: { textProtocol: "chat_completions" } });
  const result = await runtime.runWithProviderCredentials(credential, () => recover.queryImageTask(task.id));
  assert.equal(result.status, "SUCCESS"); assert.equal((result.outputPayload as any).usedModel, "original-model-A");
  const versionCount = await db.sectionVersion.count({ where: { sectionId } });
  const count = requests.length;
  await runtime.runWithProviderCredentials(credential, () => recover.queryImageTask(task.id));
  assert.equal(requests.length, count); assert.equal(await db.sectionVersion.count({ where: { sectionId } }), versionCount);
});
test("late recovered image cannot replace a newer current version", async () => {
  const before = await db.pageSection.findUniqueOrThrow({ where: { id: sectionId } });
  const task = await pendingTask();
  await runtime.runWithProviderCredentials(credential, () => recover.queryImageTask(task.id));
  assert.equal((await db.pageSection.findUniqueOrThrow({ where: { id: sectionId } })).currentImageAssetId, before.currentImageAssetId);
  assert.equal((await db.sectionVersion.findFirst({ where: { sectionId }, orderBy: { versionNumber: "desc" } }))?.isActive, false);
});
test("active queries, missing receipts and wrong provider never dispatch", async () => {
  const task = await pendingTask({ queryOwner: "other", queryUntil: Date.now() + 60000 });
  const count = requests.length;
  await assert.rejects(runtime.runWithProviderCredentials(credential, () => recover.queryImageTask(task.id)), /仍在执行/);
  await assert.rejects(runtime.runWithProviderCredentials({ ...credential, baseUrl: "https://wrong.test" }, () => recover.queryImageTask(task.id)), /原模型服务/);
  const noReceipt = await pendingTask({ upstreamImageTask: null });
  await assert.rejects(runtime.runWithProviderCredentials(credential, () => recover.queryImageTask(noReceipt.id)), /没有可查询/);
  assert.equal(requests.length, count);
});

test("concurrent recovery requests share one query and one version", async () => {
  const task = await pendingTask(), count = requests.length;
  const versions = await db.sectionVersion.count({ where: { sectionId } });
  const results = await Promise.allSettled([1, 2].map(() => runtime.runWithProviderCredentials(credential, () => recover.queryImageTask(task.id))));
  assert.ok(results.some(result => result.status === "fulfilled"));
  assert.equal(requests.slice(count).filter(url => url.includes("/v1/tasks/")).length, 1);
  assert.equal(await db.sectionVersion.count({ where: { sectionId } }), versions + 1);
});

test("recovery reuses an already downloaded image and committed version without any upstream call", async () => {
  const task = await pendingTask();
  const { saveGeneratedImage } = await import("../lib/storage/asset-manager");
  const asset = await saveGeneratedImage({ projectId, sectionId, prompt: "saved", source: { b64Json: png }, metadata: { recoveryTaskId: task.id } });
  const latest = await db.sectionVersion.findFirst({ where: { sectionId }, orderBy: { versionNumber: "desc" } });
  const version = await db.sectionVersion.create({ data: { sectionId, imageAssetId: asset.id, versionNumber: (latest?.versionNumber ?? 0) + 1, promptSnapshot: {}, copySnapshot: {}, isActive: false } });
  const count = requests.length, versions = await db.sectionVersion.count({ where: { sectionId } });
  const result = await runtime.runWithProviderCredentials(credential, () => recover.queryImageTask(task.id));
  assert.equal(requests.length, count); assert.equal((result.outputPayload as any).versionId, version.id);
  assert.equal(await db.sectionVersion.count({ where: { sectionId } }), versions);
});
test("queue separates pending/uncertain results from definite failures", async () => {
  const task = await pendingTask();
  const feed = buildTaskQueue([{ ...task, project: { name: "test", platform: "general_ecommerce" } }], []);
  assert.equal(feed[0].status, "PENDING_QUERY"); assert.equal(feed[0].failed, 0); assert.equal(feed[0].pendingQuery, 1); assert.equal(feed[0].canQueryImage, true);
  const unknown = buildTaskQueue([{ ...task, outputPayload: { imageOutcome: "uncertain" }, project: { name: "test", platform: "general_ecommerce" } }], []);
  assert.equal(unknown[0].status, "UNCERTAIN"); assert.equal(unknown[0].failed, 0);
});

test("Xiaohongshu saves generated files locally and can edit that stored image without losing the original model", async t => {
  const { generateXiaohongshuImages, editXiaohongshuImage } = await import("../lib/services/xiaohongshu-service");
  const { xiaohongshuPlanSchema } = await import("../lib/ai/schemas/xiaohongshu");
  const ids: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(init?.method, "POST");
    if (String(url).endsWith("/chat/completions")) {
      assert.equal(JSON.parse(String(init?.body)).model, "text-original");
      return Response.json({ choices: [{ message: { content: JSON.stringify({ finalPrompt: "A clear image with legible text and preserved product details." }) } }] });
    }
    if (String(url).endsWith("/images/edits")) {
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get("model"), "image-original");
      assert.ok(init.body.get("image") instanceof Blob);
    } else {
      assert.ok(String(url).endsWith("/images/generations"));
      ids.push(JSON.parse(String(init?.body)).model);
    }
    return Response.json({ data: [{ b64_json: png }] });
  });
  const providerSnapshot = { ...snapshot, textProtocol: "chat_completions", imageModelSettings: { "image-original": { protocol: "openai_images" } }, models: [
    { modelId: "text-original", capabilities: { text: true, vision: true }, isDefaultPlanning: true },
    { modelId: "image-original", capabilities: { image_gen: true, image_edit: true }, isDefaultHeroImage: true, isDefaultImageEdit: true },
  ] };
  const plan = xiaohongshuPlanSchema.parse({ topic: "Mock", pages: [{ pageNumber: 1, title: "Original", imagePrompt: "test image" }] });
  const images = await runtime.runWithProviderCredentials({ ...credential, providerSnapshot }, () => generateXiaohongshuImages(plan));
  assert.ok(images[0].imageUrl.startsWith("/api/files/")); assert.deepEqual(ids, ["image-original"]);
  const edited = await runtime.runWithProviderCredentials({ ...credential, providerSnapshot }, () => editXiaohongshuImage({ imageUrl: images[0].imageUrl, prompt: "Keep the product" }));
  assert.ok(edited.imageUrl.startsWith("/api/files/")); assert.notEqual(edited.imageUrl, images[0].imageUrl);
  assert.equal(edited.model, "image-original");
});

test("concurrent requests reserve against one money budget and completed calls reuse results", async () => {
  const { settingsSchema } = await import("../lib/agent/contracts");
  const { reserveCall, completeCall } = await import("../lib/agent/store");
  const { settleSpend, summarizeBudget } = await import("../lib/agent/budget");
  const session = await db.agentSession.create({ data: { title: "Budget test" } });
  const run = await db.agentRun.create({ data: { sessionId: session.id, idempotencyKey: "budget-test", status: "RUNNING", leaseToken: "owner", leaseUntil: new Date(Date.now() + 60000), input: {}, snapshot: { settings: settingsSchema.parse({ moneyBudgetUsd: 1, requestReserveUsd: 0.4 }) } } });
  const results = await Promise.allSettled([1, 2, 3].map(i => reserveCall(run.id, "owner", `model-${i}`, "model", { i }, true)));
  const accepted = results.flatMap((result, index) => result.status === "fulfilled" ? [{ value: result.value, i: index + 1 }] : []);
  assert.equal(accepted.length, 2);
  // Concurrent reservations may acquire the transaction in any order.
  const first = accepted[0].value;
  await completeCall(run.id, "owner", first.call!.id, { answer: "saved" });
  const reused = await reserveCall(run.id, "owner", `model-${accepted[0].i}`, "model", { i: accepted[0].i }, true);
  assert.ok(reused.existing); assert.equal((await db.agentRun.findUniqueOrThrow({ where: { id: run.id } })).modelCalls, 2);
  await db.agentRun.update({ where: { id: run.id }, data: { status: "STOPPED" } });
  await settleSpend(run.id, "owner", first.budgetId, { model: "unknown-model", success: true, statusCode: 200, responseBody: '{"cost_usd":0.15}' });
  const summary = summarizeBudget(await db.agentEvent.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } }));
  assert.equal(summary.actual, 0.15); assert.equal(summary.reserved, 0.4);
  const second = accepted[1].value;
  await settleSpend(run.id, "owner", second.budgetId, { model: "gpt-image-2.5-flare", category: "image_generation", success: true, statusCode: 200, requestBody: { quality: "low", size: "1024x1024" }, responseBody: '{"data":[{"url":"mock"}]}' });
  const settled = summarizeBudget(await db.agentEvent.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } }));
  assert.ok(settled.estimated > 0, "Delegated images retain their billing category");
  assert.equal(settled.reserved, 0); assert.equal(settled.unknown, 0);
  await assert.rejects(reserveCall(run.id, "owner", "after-stop", "model", {}, true), /暂停/);
});

test("unknown cost retains its reservation and requires acknowledgment before another capped request", async () => {
  const { settingsSchema } = await import("../lib/agent/contracts");
  const { reserveCall } = await import("../lib/agent/store");
  const { settleSpend, summarizeBudget } = await import("../lib/agent/budget");
  const session = await db.agentSession.create({ data: { title: "Unknown cost" } });
  const run = await db.agentRun.create({ data: { sessionId: session.id, idempotencyKey: "unknown-budget", status: "RUNNING", leaseToken: "owner", leaseUntil: new Date(Date.now() + 60000), input: {}, snapshot: { settings: settingsSchema.parse({ moneyBudgetUsd: 5, requestReserveUsd: 1 }) } } });
  const first = await reserveCall(run.id, "owner", "first", "model", {}, true);
  await settleSpend(run.id, "different-owner", first.budgetId);
  let events = await db.agentEvent.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } });
  assert.equal(summarizeBudget(events).reserved, 1);
  await settleSpend(run.id, "owner", first.budgetId);
  await assert.rejects(reserveCall(run.id, "owner", "second", "model", {}, true), /费用未知/);
  events = await db.agentEvent.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } });
  const before = summarizeBudget(events); assert.equal(before.unknownReserve, 1);
  await db.agentEvent.create({ data: { runId: run.id, type: "cost_acknowledged", data: { throughEventId: before.lastEventId } } });
  await reserveCall(run.id, "owner", "second", "model", {}, true);
  assert.equal((await db.agentRun.findUniqueOrThrow({ where: { id: run.id } })).modelCalls, 2);
});
