import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import sharp from "sharp";
import { assertStrictResponseSchema } from "./helpers/strict-response-schema";

let directory: string, png: Buffer;
let db: typeof import("../lib/db/prisma").prisma;
let brief: typeof import("../lib/detail-runs/brief");
let runtime: typeof import("../lib/services/provider-runtime");
let storage: typeof import("../lib/storage/asset-manager");
const credentials = { apiKey: "isolated-test-key", baseUrl: "https://brief.test/v1" };
const originalFetch = globalThis.fetch;
const observed = { name: "Brown cup", description: "Brown cup with a handle", category: "home", uncertainties: [] };
let calls: any[] = [];
let respond: (body: any) => Promise<Response>;
function success(body: any) { return Response.json({ choices: [{ message: { content: JSON.stringify({ ...observed, ...(body.messages[0].content.includes("复核") ? { corrections: [] } : {}) }) } }] }); }
async function project() {
  const row = await db.project.create({ data: { name: "Test cup", platform: "general_ecommerce", style: "generic_clean", description: "Cup" } });
  await storage.saveUploadAsset({ projectId: row.id, type: "MAIN", fileName: "cup.png", fileBuffer: png, mimeType: "image/png", sortOrder: 0 });
  return row.id;
}
const prepare = (id: string, options: Parameters<typeof brief.prepareBrief>[1] = {}) => runtime.runWithProviderCredentials(credentials, () => brief.prepareBrief(id, options));
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mxpage-brief-test-"));
  const filename = path.join(directory, "test.db");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const sqlite = new DatabaseSync(filename);
  try {
    for (const entry of (await readdir("prisma/migrations", { withFileTypes: true })).filter(e => e.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) sqlite.exec(await readFile(path.join("prisma/migrations", entry.name, "migration.sql"), "utf8"));
  } finally { sqlite.close(); }
  process.env.DATABASE_URL = `file:${filename.replaceAll("\\", "/")}`;
  process.env.STORAGE_ROOT = path.join(directory, "storage");
  delete process.env.LOCK_BASE_URL; delete process.env.FORCED_API_BASE; delete process.env.FORCED_API_BASE_URL;
  db = (await import("../lib/db/prisma")).prisma;
  brief = await import("../lib/detail-runs/brief");
  runtime = await import("../lib/services/provider-runtime");
  storage = await import("../lib/storage/asset-manager");
  png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#aa7755" } }).png().toBuffer();
  await db.providerConfig.create({ data: { name: "Isolated brief", baseUrl: credentials.baseUrl, apiKeyEncrypted: "unused", isActive: true, models: { create: { modelId: "gpt-6-luna", label: "Luna", capabilities: { text: true }, roles: {}, isDefaultPlanning: true } } } });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `${credentials.baseUrl}/chat/completions`);
    const body = JSON.parse(String(init?.body)); calls.push(body);
    assert.equal(body.model, "gpt-6-luna"); assert.equal(body.tools, undefined);
    assertStrictResponseSchema(body.response_format.json_schema.schema);
    return respond(body);
  };
});
beforeEach(() => { calls = []; respond = async body => success(body); });
after(async () => {
  globalThis.fetch = originalFetch; await db?.$disconnect();
  if (directory && path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith("mxpage-brief-test-")) await rm(directory, { recursive: true, force: true });
});

test("recognition is idempotent, resume reuses it, changed source invalidates its cache", async () => {
  const id = await project();
  await Promise.all([prepare(id, { initialOnly: true }), prepare(id, { initialOnly: true })]);
  assert.equal(calls.length, 1);
  await prepare(id, { initialOnly: true, resume: true }); assert.equal(calls.length, 1);
  const reviewed = await prepare(id); assert.equal(reviewed.recognition?.reviewed, true); assert.equal(calls.length, 2);
  await prepare(id, { resume: true }); assert.equal(calls.length, 2);
  await db.project.update({ where: { id }, data: { description: "New confirmed description" } });
  await prepare(id, { initialOnly: true }); assert.equal(calls.length, 3);
});

test("uncertain recognition has one attempt, ordinary resume never resends and explicit retry does once", async () => {
  const id = await project(); respond = async () => new Response("<html>Gateway Timeout</html>", { status: 504 });
  await assert.rejects(prepare(id, { initialOnly: true }), { code: "BRIEF_UNCERTAIN" });
  assert.equal(calls.length, 1);
  await assert.rejects(prepare(id, { initialOnly: true, resume: true }), { code: "BRIEF_UNCERTAIN" });
  assert.equal(calls.length, 1);
  respond = async body => success(body);
  await prepare(id, { initialOnly: true, retryUncertain: true }); assert.equal(calls.length, 2);
  assert.notEqual(calls[0].user, calls[1].user);
});

test("review timeout preserves recognition and retries only the review after explicit consent", async () => {
  const id = await project();
  respond = async body => body.messages[0].content.includes("复核") ? new Response("timeout", { status: 504 }) : success(body);
  await assert.rejects(prepare(id), { code: "BRIEF_UNCERTAIN" }); assert.equal(calls.length, 2);
  const snapshot = (await db.project.findUniqueOrThrow({ where: { id } })).modelSnapshot as any;
  assert.deepEqual(snapshot.creationBriefDraft.observations, observed);
  await assert.rejects(prepare(id, { resume: true }), { code: "BRIEF_UNCERTAIN" }); assert.equal(calls.length, 2);
  respond = async body => success(body);
  await prepare(id, { resume: true, retryUncertain: true });
  assert.equal(calls.length, 3); assert.match(calls[2].messages[0].content, /复核/);
});

test("invalid JSON never automatically starts a second billable recognition", async () => {
  const id = await project(); respond = async () => Response.json({ choices: [{ message: { content: "{bad json" } }] });
  await assert.rejects(prepare(id, { initialOnly: true }), { code: "BRIEF_UNCERTAIN" }); assert.equal(calls.length, 1);
});

test("a persisted live request blocks another worker even with retry consent", async () => {
  const id = await project();
  await db.project.update({ where: { id }, data: { modelSnapshot: { creationBriefRequest: { requestId: "other-worker", sourceHash: "unknown", stage: "识别", state: "running", startedAt: Date.now() } } } });
  await assert.rejects(prepare(id, { initialOnly: true, retryUncertain: true }), { code: "BRIEF_RUNNING" }); assert.equal(calls.length, 0);
});

test("missing asset fails before any model request", async () => {
  const id = await project();
  await db.productAsset.updateMany({ where: { projectId: id }, data: { filePath: "missing-test-file.png" } });
  await assert.rejects(prepare(id, { initialOnly: true })); assert.equal(calls.length, 0);
});
