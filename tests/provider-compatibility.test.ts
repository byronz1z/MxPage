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
  if (calls.at(-1)?.url.endsWith('/responses')) return Response.json({ id: "mock", model: "gpt-6-luna", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: content }] }], usage: { input_tokens: 20, output_tokens: 6, total_tokens: 26 } });
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
    const body = calls.at(-1)!.body;
    const schema = body.response_format?.json_schema?.schema || body.text?.format?.schema;
    if (schema) assertStrictResponseSchema(schema);
    assert.match(new Headers(init?.headers).get("authorization") || "", /^Bearer mock-/);
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
    assert.equal(payload.data.endpoint, `${expected}/responses`);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, payload.data.endpoint);
    assert.equal(calls[0].body.text.format.type, "json_schema");
    assert.equal(calls[0].body.tools, undefined); assert.equal(calls[0].body.temperature, undefined);
    const entries = await monitor.listApiUsageEntries();
    assert.equal(entries.length, 1); assert.equal(entries[0].operation, "provider_connection_probe");
    assert.equal(entries[0].totalTokens, 26); assert.equal(entries[0].billing?.source, "tokens");
  });
}
test("missing endpoints try each supported text endpoint only once during probing", async () => {
  respond = () => new Response("404 page not found", { status: 404 });
  const result = await probe(), payload = await result.json();
  assert.equal(result.status, 502); assert.equal(payload.error.code, "PROVIDER_ENDPOINT_NOT_FOUND");
  assert.equal(payload.error.details.endpoint, "https://probe.test/v1beta/models/gpt-6-luna:generateContent");
  assert.equal(calls.length, 4);
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
test("auto detection supports both protocols and all output modes without model substitution", async () => {
  for (const protocol of ["responses", "chat_completions"]) for (const mode of ["json_schema", "json_object", "prompt_json"]) {
    respond = () => {
      const call = calls.at(-1)!;
      if (protocol === "chat_completions" && call.url.endsWith("/responses")) return new Response("404 page not found", { status: 404 });
      const format = call.body.text?.format?.type || call.body.response_format?.type;
      if (format && format !== mode) return Response.json({ error: { message: `Unsupported response_format type: ${format}`, param: "response_format", code: "unsupported_value" } }, { status: 400 });
      return completion();
    };
    const result = await probe(), payload = await result.json();
    assert.equal(result.status, 200, JSON.stringify(payload));
    assert.equal(payload.data.transport, `${protocol} / ${mode}`);
    assert.ok(calls.every(call => call.body.model === "gpt-6-luna"));
    assert.equal(calls.length, (protocol === "chat_completions" ? 1 : 0) + ["json_schema", "json_object", "prompt_json"].indexOf(mode) + 1);
  }
});

test("unsupported streaming is checked with JSON Responses, without switching protocol", async () => {
  respond = () => calls.at(-1)!.body.stream
    ? Response.json({ error: { message: "Unsupported parameter: stream", param: "stream" } }, { status: 400 })
    : completion();
  const result = await probe();
  assert.equal(result.status, 200); assert.equal(calls.length, 2);
  assert.equal(calls[1].body.stream, false); assert.ok(calls.every(call => call.url.endsWith("/responses")));
});

test("auth, quota, model, invalid schema and uncertain responses never trigger compatibility fallback", async () => {
  const failures = [
    () => Response.json({ error: { message: "Unauthorized" } }, { status: 401 }),
    () => Response.json({ error: { message: "Forbidden" } }, { status: 403 }),
    () => Response.json({ error: { message: "Rate limited" } }, { status: 429 }),
    () => Response.json({ error: { code: "model_not_found", message: "Model does not exist" } }, { status: 404 }),
    () => Response.json({ error: { message: "Invalid schema for response_format", param: "response_format" } }, { status: 400 }),
    () => completion('{"status":"wrong"}'),
    () => completion(""),
    () => new Response('data: {"type":"response.output_text.delta","delta":"OK"}\n\n', { headers: { "content-type": "text/event-stream" } }),
    () => { throw new DOMException("timeout", "TimeoutError"); },
    () => { throw new TypeError("connection reset"); },
  ];
  for (const failure of failures) {
    respond = failure;
    const result = await probe();
    assert.ok(result.status >= 400); assert.equal(calls.length, 1);
  }
});

test("per-model results persist, freeze in snapshots, and business failures never renegotiate", async () => {
  const { getProviderAdapter, snapshotProvider } = await import("../lib/services/provider-service");
  const { runWithProviderCredentials } = await import("../lib/services/provider-runtime");
  const { saveProviderDefaults } = await import("../lib/services/provider-defaults");
  const provider = await db.providerConfig.findFirstOrThrow();
  const key = { apiKey: "mock-test-only", baseUrl: "https://snapshot.test/prefix" };
  await db.modelProfile.create({ data: { providerConfigId: provider.id, modelId: "model-B", label: "B", capabilities: { text: true, vision: true }, roles: {} } });
  respond = () => {
    if (calls.at(-1)!.body.model === "gpt-6-luna" && calls.at(-1)!.url.endsWith("/responses")) return new Response("not found", { status: 404 });
    return completion();
  };
  calls.length = 0;
  const contextA = await runWithProviderCredentials(key, () => getProviderAdapter());
  const snapshotA = snapshotProvider(contextA.provider);
  assert.equal(calls.length, 2);
  assert.equal(snapshotA.textModelSettings?.["gpt-6-luna"].textProtocol, "chat_completions");
  calls.length = 0;
  await runWithProviderCredentials(key, () => getProviderAdapter());
  assert.equal(calls.length, 0, "persisted profile avoids repeated probes");
  await saveProviderDefaults(provider.id, { planningModelId: "model-B", analysisModelId: "model-B" });
  assert.equal(calls.length, 0, "saving a model never calls upstream");
  const contextB = await runWithProviderCredentials(key, () => getProviderAdapter());
  assert.equal(calls.length, 1, "planning and vision share one probe for the same model");
  assert.equal(calls[0].body.input[0].content[1].type, "input_image");
  assert.equal(contextB.provider.textModelSettings?.["model-B"].textProtocol, "responses");
  calls.length = 0;
  const restored = await runWithProviderCredentials(key, () => getProviderAdapter(undefined, snapshotA));
  assert.equal(calls.length, 0, "resuming a snapshot never reprobes");
  await restored.adapter.generateText({ model: "gpt-6-luna", systemPrompt: "test", userPrompt: "test" });
  assert.equal(calls[0].url, "https://snapshot.test/prefix/v1/chat/completions");
  assert.equal(calls[0].body.model, "gpt-6-luna");
  calls.length = 0;
  respond = () => new Response("404 page not found", { status: 404 });
  await assert.rejects(contextB.adapter.generateText({ model: "model-B", systemPrompt: "test", userPrompt: "test" }));
  assert.equal(calls.length, 1, "a business 404 must not fall back or resend");
  respond = () => completion(); calls.length = 0;
  await runWithProviderCredentials({ ...key, apiKey: "mock-changed" }, () => getProviderAdapter());
  assert.equal(calls.length, 1, "a different account must be checked again");
  calls.length = 0;
  await Promise.all([1, 2].map(() => runWithProviderCredentials({ ...key, apiKey: "mock-concurrent" }, () => getProviderAdapter())));
  assert.equal(calls.length, 1, "concurrent requests share a single compatibility check");
  calls.length = 0;
  await runWithProviderCredentials({ ...key, apiKey: "mock-image-only" }, () => getProviderAdapter(undefined, undefined, { textModelIds: [] }));
  assert.equal(calls.length, 0, "image-only translations do not depend on text checks");
  const legacy = await runWithProviderCredentials(key, () => getProviderAdapter(undefined, undefined, { legacyTextProtocol: true }));
  assert.equal(legacy.provider.textProtocol, "chat_completions"); assert.equal(calls.length, 0);
  await db.modelProfile.deleteMany({ where: { modelId: "model-B" } });
});

test("automatic native text negotiation handles strict and prompt JSON with original IDs", async () => {
  await db.modelProfile.updateMany({ where: { modelId: "gpt-6-luna" }, data: { isDefaultPlanning: true, isAvailable: true } });
  for (const protocol of ["anthropic_messages", "gemini_native"] as const) for (const strict of [true, false]) {
    respond = () => {
      const call = calls.at(-1)!;
      const endpoint = protocol === "anthropic_messages" ? "/messages" : ":generateContent";
      if (!call.url.endsWith(endpoint)) return new Response("Not found", { status: 404 });
      const schema = call.body.output_config?.format?.schema || call.body.generationConfig?.responseJsonSchema;
      if (!strict && schema) return Response.json({ error: { message: "Unsupported output_config responseJsonSchema", param: "output_config" } }, { status: 400 });
      if (strict) assert.ok(schema);
      else assert.match(JSON.stringify(call.body), /JSON Schema/);
      return Response.json(protocol === "anthropic_messages" ? { model: "upstream-mapped", stop_reason: "end_turn", content: [{ type: "text", text: '{"status":"OK"}' }], usage: { input_tokens: 4, output_tokens: 3 } }
        : { modelVersion: "upstream-mapped", candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"status":"OK"}' }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 } });
    };
    const result = await probe(), payload = await result.json();
    assert.equal(result.status, 200, JSON.stringify(payload));
    assert.equal(payload.data.models["gpt-6-luna"].textProtocol, protocol);
    assert.equal(payload.data.models["gpt-6-luna"].structuredOutputMode, strict ? "json_schema" : "prompt_json");
    const entries = await monitor.listApiUsageEntries(1);
    assert.equal(entries[0].model, "gpt-6-luna"); assert.equal(entries[0].upstreamModel, "upstream-mapped");
    assert.equal(entries[0].totalTokens, 7);
  }
});

test("CloseAI native checks cache their documented prefix and business snapshots do not renegotiate", async () => {
  const { prepareTextCompatibility } = await import("../lib/services/provider-compatibility");
  const { getProviderAdapter, snapshotProvider } = await import("../lib/services/provider-service");
  const { runWithProviderCredentials } = await import("../lib/services/provider-runtime");
  for (const protocol of ["anthropic_messages", "gemini_native"] as const) {
    const provider = await db.providerConfig.create({ data: { name: "CloseAI mock", baseUrl: "https://api.openai-proxy.org", apiKeyEncrypted: "", isActive: false, textProtocol: "auto", models: { create: { modelId: "raw-custom", label: "Mock", roles: {}, capabilities: { text: true }, isDefaultPlanning: true } } }, include: { models: true } });
    const expected = protocol === "anthropic_messages" ? "https://api.openai-proxy.org/anthropic/v1/messages" : "https://api.openai-proxy.org/google/v1beta/models/raw-custom:generateContent";
    respond = () => calls.at(-1)?.url !== expected ? new Response("Not found", { status: 404 }) : Response.json(protocol === "anthropic_messages" ? { stop_reason: "end_turn", content: [{ type: "text", text: '{"status":"OK"}' }] } : { candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"status":"OK"}' }] } }] });
    const settings = await prepareTextCompatibility(provider, "mock-closeai");
    assert.equal(settings["raw-custom"].nativePathPrefix, protocol === "anthropic_messages" ? "anthropic" : "google");
    const refreshed = await db.providerConfig.findUniqueOrThrow({ where: { id: provider.id }, include: { models: true } });
    const before = calls.length;
    assert.deepEqual(await prepareTextCompatibility(refreshed, "mock-closeai"), settings);
    assert.equal(calls.length, before, "A saved route must not be probed again");
    const snapshot = snapshotProvider({ ...refreshed, textModelSettings: settings } as any);
    await runWithProviderCredentials({ apiKey: "mock-closeai", baseUrl: provider.baseUrl }, async () => {
      const context = await getProviderAdapter(provider.id, JSON.parse(JSON.stringify(snapshot)));
      await context.adapter.generateStructured({ model: "raw-custom", userPrompt: "business", schema: z.object({ status: z.literal("OK") }) });
    });
    assert.equal(calls.length, before + 1); assert.equal(calls.at(-1)?.url, expected);
  }
});

test("missing defaults and unavailable models do not send requests", async () => {
  respond = () => completion();
  await db.modelProfile.updateMany({ data: { isDefaultPlanning: false } });
  assert.equal((await probe()).status, 400); assert.equal(calls.length, 0);
  await db.modelProfile.updateMany({ data: { isAvailable: false } });
  const invalid = await probe();
  assert.equal((await invalid.json()).error.code, "PLANNING_MODEL_REQUIRED"); assert.equal(calls.length, 0);
});
