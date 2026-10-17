import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { z } from "zod";
import { assertStrictResponseSchema } from "./helpers/strict-response-schema";

let directory: string;
let db: typeof import("../lib/db/prisma").prisma;
let route: typeof import("../app/api/providers/agent-compatibility/route");
let monitor: typeof import("../lib/monitor/api-usage");
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; body: any }> = [];
let respond = () => completion();
function completion(content = '{"status":"OK"}') {
  return Response.json({ id: "mock", object: "chat.completion", created: 1, model: "gpt-6-luna", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } });
}
function probe(baseUrl = "https://probe.test", withKey = true) {
  calls.length = 0;
  return route.POST(new NextRequest("http://localhost/api/providers/agent-compatibility", {
    method: "POST", headers: { "x-mxpage-base-url": baseUrl, ...(withKey ? { "x-mxpage-api-key": "mock-test-only" } : {}) },
  }));
}
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mxpage-probe-test-"));
  const filename = path.join(directory, "test.db");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const sqlite = new DatabaseSync(filename);
  const migrations = path.resolve("prisma/migrations");
  try {
    for (const entry of (await readdir(migrations, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      sqlite.exec(await readFile(path.join(migrations, entry.name, "migration.sql"), "utf8"));
    }
  } finally { sqlite.close(); }
  process.env.DATABASE_URL = `file:${filename.replaceAll("\\", "/")}`;
  process.env.STORAGE_ROOT = path.join(directory, "storage");
  delete process.env.LOCK_BASE_URL; delete process.env.FORCED_API_BASE; delete process.env.FORCED_API_BASE_URL;
  db = (await import("../lib/db/prisma")).prisma;
  route = await import("../app/api/providers/agent-compatibility/route");
  monitor = await import("../lib/monitor/api-usage");
  assert.equal((await import("../lib/utils/env")).env.STORAGE_ROOT, path.join(directory, "storage"), "Never clear or write the application's usage log");
  await db.providerConfig.create({ data: { name: "Probe", baseUrl: "https://saved.test", apiKeyEncrypted: "unused", isActive: true, models: { create: { modelId: "gpt-6-luna", label: "Luna", capabilities: { text: true, structured_output: true }, roles: {}, isDefaultPlanning: true, isAvailable: true } } } });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    assertStrictResponseSchema(calls.at(-1)!.body.response_format.json_schema.schema);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer mock-test-only");
    return respond();
  };
});
after(async () => {
  globalThis.fetch = originalFetch;
  await db?.$disconnect();
  if (directory && path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith("mxpage-probe-test-")) await rm(directory, { recursive: true, force: true });
});

for (const [base, expected] of [
  ["https://probe.test", "https://probe.test/v1"],
  ["https://probe.test/", "https://probe.test/v1"],
  ["https://probe.test/v1/", "https://probe.test/v1"],
  ["https://probe.test/openai", "https://probe.test/openai/v1"],
  ["https://probe.test/v2", "https://probe.test/v2"],
]) {
  test(`probe normalizes ${base} and logs one structured response`, async () => {
    await monitor.clearApiUsageEntries(); respond = () => completion();
    const result = await probe(base), payload = await result.json();
    assert.equal(result.status, 200); assert.equal(payload.data.compatible, true);
    assert.equal(payload.data.endpoint, `${expected}/chat/completions`);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, payload.data.endpoint);
    assert.equal(calls[0].body.response_format.type, "json_schema");
    assert.equal(calls[0].body.tools, undefined); assert.equal(calls[0].body.temperature, undefined);
    const entries = await monitor.listApiUsageEntries();
    assert.equal(entries.length, 1); assert.equal(entries[0].operation, "provider_connection_probe");
    assert.equal(entries[0].totalTokens, 26); assert.equal(entries[0].billing?.source, "tokens");
  });
}
test("upstream 404 is identified as a model-service error and is not retried", async () => {
  respond = () => new Response("404 page not found", { status: 404 });
  const result = await probe(), payload = await result.json();
  assert.equal(result.status, 502); assert.equal(payload.error.code, "PROVIDER_ENDPOINT_NOT_FOUND");
  assert.equal(payload.error.details.endpoint, "https://probe.test/v1/chat/completions");
  assert.equal(calls.length, 1);
});
test("invalid JSON and HTTP 503 each stop after one probe without repair or retries", async () => {
  respond = () => completion("OK");
  const invalid = await probe();
  assert.equal((await invalid.json()).error.code, "PROVIDER_STRUCTURED_OUTPUT_INVALID");
  assert.equal(calls.length, 1);
  respond = () => Response.json({ error: { message: "Service unavailable" } }, { status: 503 });
  const failed = await probe(); assert.ok(failed.status >= 400); assert.equal(calls.length, 1);
});

test("SDK rejects unsupported optional schema locally before any provider request", async () => {
  const { invokeStructured } = await import("../lib/detail-runs/structured-model");
  calls.length = 0;
  await assert.rejects(invokeStructured({
    apiKey: "mock-test-only", baseUrl: "https://probe.test", model: "gpt-6-luna",
    system: "Return JSON", input: "Check", schema: z.object({ optionalValue: z.string().optional() }),
    timeoutMs: 1000, maxAttempts: 1,
  }), /optional.*nullable/);
  assert.equal(calls.length, 0);
});
test("fallback uses detected text/structured capabilities, and unavailable models do not send requests", async () => {
  respond = () => completion();
  await db.modelProfile.updateMany({ data: { isDefaultPlanning: false } });
  assert.equal((await probe()).status, 200); assert.equal(calls[0].body.model, "gpt-6-luna");
  await db.modelProfile.updateMany({ data: { isAvailable: false } });
  const invalid = await probe();
  assert.equal((await invalid.json()).error.code, "PLANNING_MODEL_REQUIRED"); assert.equal(calls.length, 0);
});
