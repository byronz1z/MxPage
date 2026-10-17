import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

let directory: string;
let db: typeof import("../lib/db/prisma").prisma;
let batch: typeof import("../lib/detail-runs/batch");
let translation: typeof import("../lib/translation/service");
let storage: typeof import("../lib/storage/asset-manager");
let runtime: typeof import("../lib/services/provider-runtime");
let png: Buffer;
const originalFetch = globalThis.fetch;
const credentials = { apiKey: "isolated-test-key", baseUrl: "https://translation.test/v1" };
type Call = { prompt: string; model: string; quality: string; bytes: Buffer };
let calls: Call[] = [];
let inFlight = 0;
let peak = 0;
let response: (call: Call) => Promise<Response>;
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const success = () => Response.json({ data: [{ b64_json: png.toString("base64") }] });
async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await pause(); }
  throw new Error("Translation test did not settle");
}
async function settled(id: string) {
  await until(async () => {
    const task = await db.generationTask.findUniqueOrThrow({ where: { id } });
    return !["PENDING", "RUNNING"].includes(task.status) && !(globalThis as any).detailBatchWorkers?.has(id);
  });
  return batch.getBatch(id);
}
async function source(count = 2) {
  const project = await db.project.create({ data: { name: "翻译测试", platform: "general_ecommerce", style: "generic_clean" } });
  for (let i = 0; i < count; i++) await storage.saveUploadAsset({ projectId: project.id, type: i === 0 ? "MAIN" : "ANGLE", fileName: `${i + 1}.png`, fileBuffer: png, mimeType: "image/png", sortOrder: i });
  return project.id;
}
function request(projectId: string, translations = ["en-US"]) {
  return { id: randomUUID(), projectIds: [projectId], options: { quality: "low" }, translations, translationInstruction: "ACME 保留原文" };
}
function resetCalls() { calls = []; peak = 0; response = async () => { await pause(); return success(); }; }

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mxpage-translation-test-"));
  const filename = path.join(directory, "test.db");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const sqlite = new DatabaseSync(filename);
  const migrations = path.resolve("prisma/migrations");
  try {
    for (const entry of (await readdir(migrations, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) sqlite.exec(await readFile(path.join(migrations, entry.name, "migration.sql"), "utf8"));
  } finally { sqlite.close(); }
  process.env.DATABASE_URL = `file:${filename.replaceAll("\\", "/")}`;
  process.env.STORAGE_ROOT = path.join(directory, "storage");
  delete process.env.LOCK_BASE_URL; delete process.env.FORCED_API_BASE; delete process.env.FORCED_API_BASE_URL;
  db = (await import("../lib/db/prisma")).prisma;
  batch = await import("../lib/detail-runs/batch");
  translation = await import("../lib/translation/service");
  storage = await import("../lib/storage/asset-manager");
  runtime = await import("../lib/services/provider-runtime");
  png = await sharp({ create: { width: 32, height: 48, channels: 3, background: "#c4ad89" } }).png().toBuffer();
  // Deliberately no analysis/planning model: translation must work with only image editing.
  await db.providerConfig.create({ data: { name: "Mock", baseUrl: credentials.baseUrl, apiKeyEncrypted: "unused", isActive: true, models: { create: { modelId: "gpt-image-2.5-flare", label: "Flare", capabilities: { image_edit: true, real_image_edit: true }, roles: {}, isDefaultImageEdit: true } } } });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://translation.test/v1/images/edits", "No chat, planning, review or alternate image endpoints");
    assert.ok(init?.body instanceof FormData);
    const form = init.body;
    assert.equal(form.get("size"), "auto");
    assert.equal(form.getAll("image").length, 1);
    assert.equal(form.getAll("image[]").length, 0);
    const call = { prompt: String(form.get("prompt")), model: String(form.get("model")), quality: String(form.get("quality")), bytes: Buffer.from(await (form.get("image") as Blob).arrayBuffer()) };
    calls.push(call); inFlight++; peak = Math.max(peak, inFlight);
    try { return await response(call); } finally { inFlight--; }
  };
  resetCalls();
});
after(async () => {
  globalThis.fetch = originalFetch;
  await db?.$disconnect();
  if (directory && path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith("mxpage-translation-test-")) await rm(directory, { recursive: true, force: true });
});

test("two originals × two languages use four direct edits, independent ordered outputs and no DetailRun", async () => {
  resetCalls();
  const sourceId = await source();
  const input = request(sourceId, ["en-US", "ja-JP"]);
  const initial = await batch.startBatch(input, credentials);
  assert.equal(initial.items.reduce((sum, item) => sum + ("translationProgress" in item ? item.translationProgress?.total || 0 : 0), 0), 4, "Queued language versions count toward the total before generation starts");
  const result = await settled(input.id);
  assert.equal(result.status, "SUCCESS");
  assert.equal(calls.length, 4); assert.equal(peak, 2);
  assert.ok(calls.every(call => call.model === "gpt-image-2.5-flare" && call.quality === "low" && call.bytes.equals(png)));
  assert.ok(calls.every(call => /ACME 保留原文/.test(call.prompt) && /parameter tables and size charts/.test(call.prompt)));
  assert.equal(calls.filter(call => call.prompt.includes("(en-US)")).length, 2);
  assert.equal(calls.filter(call => call.prompt.includes("(ja-JP)")).length, 2);
  assert.equal(await db.detailRun.count(), 0);
  const originalAssets = await db.productAsset.findMany({ where: { projectId: sourceId } });
  assert.equal(originalAssets.length, 2);
  for (const item of result.items) {
    assert.equal(item.status, "COMPLETED"); assert.equal(item.images.length, 2);
    const sections = await db.pageSection.findMany({ where: { projectId: item.projectId }, orderBy: { order: "asc" }, include: { versions: true } });
    assert.deepEqual(sections.map(section => section.title), ["1.png", "2.png"]);
    assert.ok(sections.every(section => section.versions.length === 1 && section.currentImageAssetId));
    const copies = await db.productAsset.findMany({ where: { projectId: item.projectId, type: "DETAIL" } });
    for (const copy of copies) {
      assert.ok(originalAssets.every(asset => asset.filePath !== copy.filePath));
      assert.deepEqual(await storage.readStorageFile(copy.filePath), png);
    }
    const { exportLongImage } = await import("../lib/detail-runs/long-image");
    const metadata = await sharp(await exportLongImage(item.projectId)).metadata();
    assert.equal(metadata.height, metadata.width! * 3);
    const { buildImageArchive } = await import("../lib/services/export-service");
    const archive = await buildImageArchive(item.projectId);
    assert.equal(archive.subarray(0, 2).toString(), "PK");
    const { getProjectDetail } = await import("../lib/services/project-service");
    const { TranslationProjectWorkspace } = await import("../components/translation/translation-project-workspace");
    const html = renderToStaticMarkup(React.createElement(TranslationProjectWorkspace, { initialProject: (await getProjectDetail(item.projectId))! }));
    assert.match(html, /原图与译图对照/);
    assert.match(html, /下载翻译长图/);
    assert.match(html, new RegExp(`/translate\\?batch=${input.id}`));
    assert.doesNotMatch(html, /设计检查|商品理解|一键生成/);
  }
  await batch.startBatch(input, credentials);
  assert.equal(calls.length, 4, "Idempotent start does not repeat completed requests");
});

test("an HTTP 500 affects one image; continue skips it, explicit retry sends only the failed image", async () => {
  resetCalls();
  let first = true;
  response = async () => { if (first) { first = false; return Response.json({ error: { message: "temporary failure" } }, { status: 500 }); } return success(); };
  const input = request(await source());
  await batch.startBatch(input, credentials);
  const failed = await settled(input.id);
  assert.equal(failed.status, "FAILED"); assert.equal(calls.length, 2);
  assert.equal(failed.items[0].images.length, 1);
  const saved = failed.items[0].images[0].url;
  await batch.controlBatch(input.id, "resume", credentials);
  await settled(input.id);
  assert.equal(calls.length, 2, "No automatic retries of paid/uncertain requests");
  await batch.controlBatch(input.id, "resume", credentials, true);
  const recovered = await settled(input.id);
  assert.equal(recovered.status, "SUCCESS"); assert.equal(calls.length, 3);
  assert.ok(recovered.items[0].images.some(image => image.url === saved));
});

test("cancel saves in-flight results and resume processes only the unstarted image", async () => {
  resetCalls();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  response = async () => { await gate; return success(); };
  const input = request(await source(3));
  await batch.startBatch(input, credentials);
  await until(() => calls.length === 2);
  await batch.controlBatch(input.id, "cancel", credentials);
  release();
  const canceled = await settled(input.id);
  assert.equal(canceled.status, "CANCELED"); assert.equal(calls.length, 2);
  assert.equal(canceled.items[0].images.length, 2);
  await batch.controlBatch(input.id, "resume", credentials);
  assert.equal((await settled(input.id)).status, "SUCCESS"); assert.equal(calls.length, 3);
});

test("stale RUNNING checkpoint is uncertain and requires explicit retry", async () => {
  resetCalls();
  const sourceId = await source(1), batchId = randomUUID();
  const projectId = translation.translationProjectId(batchId, sourceId, "en-US");
  await translation.prepareTranslationProject(projectId, sourceId, "en-US", "low");
  const options = { batchId, projectId, language: "en-US" as const, quality: "low" as const, instruction: "", active: async () => true };
  response = async () => { throw new DOMException("Timed out", "TimeoutError"); };
  await runtime.runWithProviderCredentials(credentials, () => translation.runTranslationProject(options));
  const id = translation.translationTaskId(batchId, projectId);
  const task = await translation.getTranslationTask(id);
  const progress = task!.progress;
  progress.images[0].status = "RUNNING";
  await db.generationTask.update({ where: { id }, data: { status: "RUNNING", updatedAt: new Date(Date.now() - 120000), outputPayload: JSON.parse(JSON.stringify(progress)) } });
  assert.equal((await translation.getTranslationTask(id))?.status, "FAILED");
  await runtime.runWithProviderCredentials(credentials, () => translation.runTranslationProject(options));
  assert.equal(calls.length, 1);
  assert.equal((await translation.getTranslationTask(id))?.progress.images[0].status, "UNCERTAIN");
  response = async () => success();
  await runtime.runWithProviderCredentials(credentials, () => translation.runTranslationProject({ ...options, retryFailed: true }));
  assert.equal(calls.length, 2);
  assert.equal((await translation.getTranslationTask(id))?.status, "SUCCESS");
});

test("late translation response cannot overwrite a new owner and its saved asset is recovered without re-billing", async () => {
  resetCalls();
  const sourceId = await source(1), batchId = randomUUID();
  const projectId = translation.translationProjectId(batchId, sourceId, "en-US");
  await translation.prepareTranslationProject(projectId, sourceId, "en-US", "low");
  const options = { batchId, projectId, language: "en-US" as const, quality: "low" as const, instruction: "", active: async () => true };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  response = async () => { await gate; return success(); };
  const job = runtime.runWithProviderCredentials(credentials, () => translation.runTranslationProject(options));
  const rejected = assert.rejects(job);
  const id = translation.translationTaskId(batchId, projectId);
  await until(() => calls.length === 1);
  const old = await db.generationTask.findUniqueOrThrow({ where: { id } });
  const newOwner = new Date(old.startedAt!.getTime() + 1000);
  try {
    await db.generationTask.update({ where: { id }, data: { startedAt: newOwner, errorMessage: "new-owner-sentinel" } });
  } finally { release(); }
  await rejected;
  const current = await db.generationTask.findUniqueOrThrow({ where: { id } });
  assert.equal(current.status, "RUNNING"); assert.equal(current.errorMessage, "new-owner-sentinel");
  assert.equal(current.startedAt!.getTime(), newOwner.getTime());
  const section = await db.pageSection.findFirstOrThrow({ where: { projectId } });
  assert.equal(section.currentImageAssetId, null);
  assert.equal(await db.productAsset.count({ where: { projectId, type: "GENERATED" } }), 1);
  await db.generationTask.update({ where: { id }, data: { status: "FAILED" } });
  response = async () => success();
  await runtime.runWithProviderCredentials(credentials, () => translation.runTranslationProject(options));
  assert.equal(calls.length, 1);
  assert.equal((await translation.getTranslationTask(id))?.status, "SUCCESS");
  assert.ok((await db.pageSection.findUniqueOrThrow({ where: { id: section.id } })).currentImageAssetId);
});

test("translation heartbeat losing ownership stops scheduling and keeps in-flight images recoverable", async t => {
  resetCalls();
  const sourceId = await source(4), batchId = randomUUID();
  const projectId = translation.translationProjectId(batchId, sourceId, "en-US");
  await translation.prepareTranslationProject(projectId, sourceId, "en-US", "low");
  const options = { batchId, projectId, language: "en-US" as const, quality: "low" as const, instruction: "", active: async () => true };
  let tick!: () => void, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, "setInterval", ((callback: () => void) => { tick = callback; return 0; }) as any);
  response = async () => { await gate; return success(); };
  const job = runtime.runWithProviderCredentials(credentials, () => translation.runTranslationProject(options));
  const rejected = assert.rejects(job);
  await until(() => calls.length === 2);
  try {
    await db.generationTask.update({ where: { id: translation.translationTaskId(batchId, projectId) }, data: { status: "FAILED" } });
    tick(); await pause();
  } finally { release(); }
  await rejected;
  assert.equal(calls.length, 2, "The remaining two paid edits never start");
  assert.equal(await db.productAsset.count({ where: { projectId, type: "GENERATED" } }), 2);
  assert.equal((await translation.getTranslationTask(translation.translationTaskId(batchId, projectId)))?.status, "FAILED");
});

test("existing editor translation also uses a fixed prompt and exactly one image edit", async () => {
  resetCalls();
  const input = request(await source(1));
  await batch.startBatch(input, credentials);
  const result = await settled(input.id);
  const item = result.items[0];
  const { editSectionImage } = await import("../lib/services/generation-service");
  await runtime.runWithProviderCredentials(credentials, () => editSectionImage(item.projectId, item.images[0].id, { editMode: "translate", targetLanguage: "fr-FR", instruction: "ACME 保留原文" }));
  assert.equal(calls.length, 2); assert.match(calls[1].prompt, /\(fr-FR\)/);
  response = async () => Response.json({ error: { message: "failed edit" } }, { status: 500 });
  await assert.rejects(runtime.runWithProviderCredentials(credentials, () => editSectionImage(item.projectId, item.images[0].id, { editMode: "translate", targetLanguage: "fr-FR" })));
  assert.equal(calls.length, 3, "No model/endpoint fallback or SVG generation after failure");
});

test("new translation requests cannot enter the detail planning executor", async () => {
  const { createDetailRun } = await import("../lib/detail-runs/service");
  const before = await db.detailRun.count();
  await assert.rejects(createDetailRun(await source(1), { idempotencyKey: randomUUID(), mode: "translate" }, credentials), /独立批量/);
  assert.equal(await db.detailRun.count(), before);
});

test("a legacy PLAN failure resumes through direct translation without resuming or creating a DetailRun", async () => {
  resetCalls();
  const input = request(await source(1));
  const projectId = translation.translationProjectId(input.id, input.projectIds[0], "en-US");
  await translation.prepareTranslationProject(projectId, input.projectIds[0], "en-US", "low");
  const old = await db.detailRun.create({ data: { projectId, idempotencyKey: `batch:${input.id}`, status: "FAILED", stage: "PLAN", input: { mode: "translate" }, checkpoint: {} } });
  await db.generationTask.create({ data: { id: input.id, projectId: "mxpage-detail-batch-system", taskType: "BATCH_CREATE", status: "FAILED", inputPayload: { ...batch.batchInputSchema.parse(input), workflow: "detail-batch-v1" }, outputPayload: { items: [{ projectId, sourceProjectId: input.projectIds[0], language: "en-US", status: "FAILED", runId: old.id, message: "PLAN timeout" }] } } });
  const count = await db.detailRun.count();
  await batch.controlBatch(input.id, "resume", credentials);
  assert.equal((await settled(input.id)).status, "SUCCESS");
  assert.equal(calls.length, 1);
  assert.equal(await db.detailRun.count(), count);
  assert.equal((await db.detailRun.findUniqueOrThrow({ where: { id: old.id } })).status, "FAILED");
  const { controlV4DetailRun } = await import("../lib/detail-runs/service-v4");
  await assert.rejects(controlV4DetailRun(projectId, old.id, "resume", {}, credentials), /不再处理翻译/);
});
