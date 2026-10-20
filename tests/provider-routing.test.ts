import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import { NextRequest } from "next/server";
let directory: string, providerId: string;
let db: typeof import("../lib/db/prisma").prisma;
let providers: typeof import("../lib/services/provider-service");
let runtime: typeof import("../lib/services/provider-runtime");
let defaults: typeof import("../app/api/providers/[id]/defaults/route");
let transport: typeof import("../lib/ai/text-transport");
const originalFetch = globalThis.fetch;
const credentials = { apiKey: "test-only", baseUrl: "https://routing.test/prefix/v1" };
const calls: Array<{ url: string; body: any }> = [];
let respond: () => Response = () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }], model: "upstream-alias" });
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mxpage-provider-routing-"));
  const filename = path.join(directory, "test.db");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const sqlite = new DatabaseSync(filename);
  for (const entry of (await readdir("prisma/migrations", { withFileTypes: true })).filter(e => e.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) sqlite.exec(await readFile(`prisma/migrations/${entry.name}/migration.sql`, "utf8"));
  sqlite.close();
  process.env.DATABASE_URL = `file:${filename.replaceAll("\\", "/")}`;
  process.env.STORAGE_ROOT = path.join(directory, "storage");
  delete process.env.LOCK_BASE_URL; delete process.env.FORCED_API_BASE; delete process.env.FORCED_API_BASE_URL;
  db = (await import("../lib/db/prisma")).prisma;
  providers = await import("../lib/services/provider-service"); runtime = await import("../lib/services/provider-runtime");
  defaults = await import("../app/api/providers/[id]/defaults/route"); transport = await import("../lib/ai/text-transport");
  const provider = await db.providerConfig.create({ data: { name: "Mock", baseUrl: credentials.baseUrl, apiKeyEncrypted: "unused", isActive: true, models: { create: ["text-A", "text-B", "image-A", "image-B", "gpt-6-luna", "gpt-image-2.5-flare"].map(modelId => ({ modelId, label: modelId, capabilities: { text: true, vision: true, image_gen: true, image_edit: true }, roles: {}, isDefaultPlanning: modelId === "text-A", isDefaultAnalysis: modelId === "text-A", isDefaultHeroImage: modelId === "image-A", isDefaultDetailImage: modelId === "image-A", isDefaultImageEdit: modelId === "image-A" })) } } });
  providerId = provider.id;
  globalThis.fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only");
    calls.push({ url: String(url), body: init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body)) });
    return respond();
  };
});
after(async () => { globalThis.fetch = originalFetch; await db?.$disconnect(); if (directory && path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith("mxpage-provider-routing-")) await rm(directory, { recursive: true, force: true }); });
async function patch(body: unknown) { return defaults.PATCH(new NextRequest("http://localhost/api/providers/mock/defaults", { method: "PATCH", body: JSON.stringify(body) }), { params: { id: providerId } }); }
test("native model discovery preserves resource IDs, advertises endpoints and never generates images", async t => {
  const { OpenAICompatibleAdapter } = await import("../lib/ai/adapters/openai-compatible");
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(init?.method, "GET"); requests.push(String(url));
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), credentials.apiKey);
    return Response.json({ models: [{ name: "models/gemini-custom", displayName: "Custom", supportedGenerationMethods: ["generateContent"] }] });
  });
  const result = await new OpenAICompatibleAdapter("https://generativelanguage.googleapis.com", credentials.apiKey).listModels();
  assert.equal(result[0].id, "models/gemini-custom"); assert.deepEqual(result[0].modalities, ["text", "vision"]);
  assert.deepEqual(requests, ["https://generativelanguage.googleapis.com/v1beta/models"]);
});

test("catalog discovery retains returned GPT Image IDs and never invents missing image models", async t => {
  const { discoverProviderModels } = await import("../lib/services/provider-service");
  let ids = ["gpt-4.1", "gemini-2.5-flash-image"];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(url), "https://catalog.test/v1/models");
    assert.equal(init?.method, "GET"); calls++;
    return Response.json({ data: ids.map(id => ({ id })) });
  });
  const input = { name: "Catalog mock", baseUrl: "https://catalog.test", apiKey: "mock-only" };
  const before = await discoverProviderModels(input);
  assert.deepEqual(before.models.map(model => model.modelId), ids);
  ids = [...ids, "gpt-image-1", "gpt-image-2.5-flare", "vendor/gpt-image-custom"];
  const after = await discoverProviderModels(input);
  assert.deepEqual(after.models.map(model => model.modelId), ids);
  for (const model of after.models.filter(model => model.modelId.includes("gpt-image"))) {
    assert.equal(model.capabilities.image_gen, true);
    assert.equal(model.capabilities.image_edit, true);
  }
  assert.equal(calls, 2, "Only the two explicit catalog reads are sent");
});

test("Gemini image catalog entries expose conversational editing without inventing models or mask support", async () => {
  const { normalizeDetectedModels } = await import("../lib/ai/capability-detector");
  const ids = ["gemini-nano-banana-2.1", "gemini-3-pro-image", "gemini-2.5-flash-image-preview", "vendor/gemini-3.1-flash-image", "gemini-3-flash", "imagen-4.0-generate-001"];
  const models = normalizeDetectedModels(ids.map(id => ({ id })));
  assert.deepEqual(models.map(model => model.modelId), ids);
  for (const model of models.slice(0, 4)) {
    assert.equal(model.capabilities.image_gen, true);
    assert.equal(model.capabilities.image_edit, true);
    assert.equal(model.roles.image_edit, true);
    assert.equal((model.capabilities as any).mask, undefined);
  }
  for (const model of models.slice(4)) assert.equal(model.capabilities.image_edit, false);
});

test("discovery distinguishes missing local credentials from upstream auth rejection without retrying", async t => {
  const { POST } = await import("../app/api/providers/discover-models/route");
  let status = 200, expectedKey = "form-key", dispatches = 0;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(url), "https://api.openai-proxy.org/v1/models");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${expectedKey}`);
    dispatches++;
    return status === 200 ? Response.json({ data: [{ id: "gpt-image-2" }] })
      : Response.json({ error: { code: "invalid_credentials", message: "private upstream diagnostics" } }, { status });
  });
  const storedModels = await db.modelProfile.findMany({ where: { providerConfigId: providerId } });
  const request = (apiKey?: string, headers?: Record<string, string>) => POST(new NextRequest("http://localhost/api/providers/discover-models", {
    method: "POST", headers, body: JSON.stringify({ name: "CloseAI mock", baseUrl: "https://api.openai-proxy.org", apiKey }),
  }));
  const staleHeaders = { "x-mxpage-api-key": "old-key", "x-mxpage-base-url": "https://previous-provider.test/v1" };
  const success = await request("  form-key  ", staleHeaders);
  assert.equal(success.status, 200, "explicit form key takes priority over bridge headers");
  assert.equal((await success.json()).data.models[0].modelId, "gpt-image-2");
  for (const authStatus of [401, 403]) {
    status = authStatus;
    const before = dispatches;
    const result = await request("form-key", staleHeaders), payload = await result.json();
    assert.equal(result.status, authStatus);
    assert.equal(payload.error.code, "PROVIDER_DISCOVERY_AUTH_ERROR");
    assert.deepEqual(payload.error.details, { source: "upstream", upstreamStatus: authStatus });
    assert.equal(JSON.stringify(payload).includes("private upstream"), false);
    assert.equal(JSON.stringify(payload).includes("form-key"), false);
    assert.equal(dispatches, before + 1, "auth failures never switch endpoint or retry");
  }
  const before = dispatches;
  for (const headers of [undefined, staleHeaders]) {
    const result = await request(undefined, headers), payload = await result.json();
    assert.equal(result.status, 400);
    assert.equal(payload.error.code, "PROVIDER_CREDENTIALS_MISSING");
    assert.deepEqual(payload.error.details, { source: "local" });
  }
  assert.equal(dispatches, before, "missing or wrong-service header keys never reach an upstream");
  status = 200; expectedKey = "header-key";
  assert.equal((await request(undefined, { "x-mxpage-api-key": expectedKey, "x-mxpage-base-url": "https://api.openai-proxy.org/v1/" })).status, 200);
  assert.deepEqual(await db.modelProfile.findMany({ where: { providerConfigId: providerId } }), storedModels);
});

test("image profiles preserve working routes, survive catalog refresh and freeze legacy snapshots", async t => {
  const evo = { apiKey: "test-only", baseUrl: "https://api.evolink.ai" };
  const created = await db.providerConfig.create({ data: { name: "Image profile", baseUrl: evo.baseUrl, apiKeyEncrypted: "", isActive: false, models: { create: { modelId: "gpt-image-2", label: "Original", capabilities: { image_gen: true, image_edit: true }, roles: {}, isDefaultHeroImage: true } } } });
  const context = () => runtime.runWithProviderCredentials(evo, () => providers.getProviderAdapter(created.id));
  const fresh = await context(); const snapshot = providers.snapshotProvider(fresh.provider);
  assert.equal(snapshot.imageModelSettings?.["gpt-image-2"].protocol, "evolink_tasks");
  assert.ok(snapshot.imageModelSettings?.["gpt-image-2"].contract);
  const legacy = { ...snapshot }; delete legacy.imageModelSettings;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++; assert.equal(String(url), "https://api.evolink.ai/v1/images/generations");
    assert.equal(JSON.parse(String(init?.body)).model, "gpt-image-2");
    return Response.json({ data: [{ b64_json: "AAAA" }] });
  });
  const restored = await runtime.runWithProviderCredentials(evo, () => providers.getProviderAdapter(created.id, legacy));
  await runtime.runWithProviderCredentials(evo, () => restored.adapter.generateImage({ model: "gpt-image-2", prompt: "Legacy" }));
  assert.equal(calls, 1);
  assert.equal((await context()).provider.imageModelSettings?.["gpt-image-2"].protocol, "openai_images", "a successful original path takes priority over new catalog routing");
  const row = await db.modelProfile.findFirstOrThrow({ where: { providerConfigId: created.id } });
  await providers.saveProviderConfig({ id: created.id, name: "Refreshed", baseUrl: evo.baseUrl, apiKey: evo.apiKey, isActive: false, discoveredModels: [{ ...row, capabilities: { image_gen: true, image_edit: true }, roles: {} }], defaultAssignments: { heroImageModelId: "gpt-image-2" } });
  assert.equal((await context()).provider.imageModelSettings?.["gpt-image-2"].protocol, "openai_images");
  const frozen = await runtime.runWithProviderCredentials(evo, () => providers.getProviderAdapter(created.id, snapshot));
  assert.equal(frozen.provider.imageModelSettings?.["gpt-image-2"].protocol, "evolink_tasks", "already queued operations retain their route and contract");
  assert.equal(calls, 1, "refresh and restoration must never generate probe images");
});

test("official Gemini image transport uses native key headers and one request", async t => {
  const { OpenAICompatibleAdapter } = await import("../lib/ai/adapters/openai-compatible");
  let count = 0, ready = false;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    count++; assert.equal(ready, true);
    assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent");
    const headers = new Headers(init?.headers); assert.equal(headers.get("authorization"), null); assert.equal(headers.get("x-goog-api-key"), credentials.apiKey);
    const body = JSON.parse(String(init?.body)); assert.deepEqual(body.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
    assert.equal(body.contents[0].parts[1].inlineData.data, "AAAA");
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] } }] });
  });
  const adapter = new OpenAICompatibleAdapter("https://generativelanguage.googleapis.com/v1beta", credentials.apiKey);
  const result = await adapter.editImage({ model: "models/gemini-3-pro-image-preview", prompt: "Edit", image: "data:image/png;base64,AAAA", beforeSubmit: async () => { ready = true; } });
  assert.ok(result.b64Json || result.url); assert.equal(count, 1);
});

test("saved defaults drive the wire, snapshots keep A, new calls use B without preferring pinned models", async () => {
  const { selectModel } = await import("../lib/ai/model-selection");
  const old = await runtime.runWithProviderCredentials(credentials, () => providers.getProviderAdapter());
  const snapshot = providers.snapshotProvider(old.provider);
  const before = calls.length;
  const response = await patch({ planningModelId: "text-B", analysisModelId: "text-B", heroImageModelId: "image-B", detailImageModelId: "image-B", imageEditModelId: "image-B" });
  assert.equal(response.status, 200); assert.equal(calls.length, before, "saving must not call a model");
  assert.equal((await response.json()).data.apiKeyEncrypted, undefined);
  const current = await runtime.runWithProviderCredentials(credentials, () => providers.getProviderAdapter());
  const frozen = await runtime.runWithProviderCredentials(credentials, () => providers.getProviderAdapter(providerId, snapshot));
  for (const [ctx, model] of [[current, "text-B"], [frozen, "text-A"]] as const) {
    await ctx.adapter.generateStructured({ model: selectModel(ctx.provider.models, "planning"), userPrompt: "Return JSON", schema: z.object({ ok: z.boolean() }) });
    assert.equal(calls.at(-1)!.body.model, model);
    assert.equal(selectModel(ctx.provider.models, "analysis"), model);
    for (const role of ["hero", "detail", "edit"] as const) assert.equal(selectModel(ctx.provider.models, role), model.replace("text", "image"));
  }
  assert.equal(selectModel(current.provider.models, "planning", "text-A"), "text-A");
  assert.throws(() => selectModel(current.provider.models, "planning", "missing"));
  const bad = await patch({ planningModelId: "missing", textProtocol: "responses" });
  assert.ok(bad.status >= 400);
  assert.equal((await db.providerConfig.findUniqueOrThrow({ where: { id: providerId } })).textProtocol, "chat_completions", "failed transaction rolls back protocol too");
  const monitor = await import("../lib/monitor/api-usage");
  const entries = await monitor.listApiUsageEntries();
  assert.ok(entries.some(e => e.model === "text-B" && e.upstreamModel === "upstream-alias" && e.protocol === "chat_completions"));
});
test("EvoLink image routing uses exact IDs, authenticated upload and read-only polling; snapshot freezes the protocol", async t => {
  const wire: Array<{ url: string; method: string; body: any }> = [];
  let persisted = false;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only");
    wire.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url) === "https://files-api.evolink.ai/api/v1/files/upload/base64") return Response.json({ success: true, data: { file_url: "https://files.evolink.ai/input.png" } });
    if (String(url) === "https://api.evolink.ai/v1/images/generations") return Response.json({ id: "async-task", status: "pending", model: "gpt-image-2.5-flare" });
    assert.equal(String(url), "https://api.evolink.ai/v1/tasks/async-task");
    assert.equal(init?.method, "GET"); assert.equal(persisted, true);
    return Response.json({ id: "async-task", status: "completed", result_data: [{ url: "https://result.test/image.png" }] });
  });
  let modelDispatches = 0;
  const evoCredentials = { ...credentials, baseUrl: "https://api.evolink.ai", agentBeforeDispatch: async () => { modelDispatches++; } };
  const context = await runtime.runWithProviderCredentials(evoCredentials, () => providers.getProviderAdapter(providerId));
  assert.equal(providers.snapshotProvider(context.provider).imageProtocol, "evolink_tasks");
  const result = await runtime.runWithProviderCredentials(evoCredentials, () => context.adapter.editImage({ model: "gpt-image-2.5-flare", prompt: "edit", image: "data:image/png;base64,AA==", onUpstreamTask: async () => { persisted = true; } }));
  assert.equal(result.url, "https://result.test/image.png");
  assert.equal(modelDispatches, 1, "file upload and polling are not additional model invocations");
  assert.equal(wire.filter(call => call.url.endsWith("images/generations")).length, 1);
  assert.equal(wire[1].body.model, "gpt-image-2.5-flare");
  assert.equal(wire.some(call => call.url.endsWith("images/edits")), false);
  const entries = await (await import("../lib/monitor/api-usage")).listApiUsageEntries();
  assert.ok(entries.some(entry => entry.protocol === "evolink_tasks" && entry.upstreamTaskId === "async-task" && entry.model === "gpt-image-2.5-flare"));
});

test("both protocols and all output modes preserve model, images, validation and one dispatch", async () => {
  for (const textProtocol of ["chat_completions", "responses"] as const) for (const structuredOutputMode of ["json_schema", "json_object", "prompt_json"] as const) {
    for (const stream of textProtocol === "responses" ? [false, true] : [false]) {
      const result = { status: "completed", model: "text-B", output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] }], usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } };
      respond = () => textProtocol === "responses" ? stream ? new Response(`event: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response: result })}\r\n\r\n`, { headers: { "Content-Type": "text/event-stream" } }) : Response.json(result) : Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
      const count = calls.length;
      const output = await transport.callText({ ...credentials, ...{ baseUrl: credentials.baseUrl }, model: "text-B", textProtocol, structuredOutputMode, schema: z.object({ ok: z.boolean() }), images: ["data:image/png;base64,AA=="], input: "JSON", system: "Check", timeoutMs: 1000 });
      assert.deepEqual(output.parsed, { ok: true }); assert.equal(calls.length, count + 1);
      const request = calls.at(-1)!;
      assert.ok(request.url.endsWith(textProtocol === "responses" ? "/responses" : "/chat/completions"));
      assert.equal(request.body.model, "text-B");
      const content = textProtocol === "responses" ? request.body.input[0].content : request.body.messages[1].content;
      assert.equal(content.length, 2);
      const format = textProtocol === "responses" ? request.body.text?.format : request.body.response_format;
      assert.equal(format?.type, structuredOutputMode === "prompt_json" ? undefined : structuredOutputMode);
    }
  }
});
test("HTTP failures, invalid JSON, incomplete streams and empty output never retry", async () => {
  for (const response of [new Response("denied", { status: 401 }), new Response("missing", { status: 404 }), new Response("schema rejected", { status: 400 }), new Response("busy", { status: 503 }), new Response("data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"), Response.json({ status: "incomplete", output: [] }), Response.json({ status: "completed", output: [] }), Response.json({ status: "completed", output_text: "not json" })]) {
    respond = () => response; const count = calls.length;
    await assert.rejects(transport.callText({ ...credentials, baseUrl: credentials.baseUrl, model: "text-B", textProtocol: "responses", schema: z.object({ ok: z.boolean() }), input: "JSON", system: "Check", timeoutMs: 1000 }));
    assert.equal(calls.length, count + 1);
  }
});
test("local deadline during an HTTP 200 Responses stream reports the wait limit without retry", async t => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, 180000); return deadline.signal; });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
      init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
      queueMicrotask(() => deadline.abort(new DOMException("timed out", "TimeoutError")));
    } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  await assert.rejects(transport.callText({ ...credentials, model: "text-B", textProtocol: "responses", input: "JSON", system: "Check", timeoutMs: 180000 }), error => {
    assert.equal((error as { code: string }).code, "MODEL_RESPONSE_TIMEOUT");
    assert.match((error as Error).message, /180 秒.*尚未收到完整结果.*明确重试/);
    return true;
  });
  assert.equal(requests, 1);
  const entries = await (await import("../lib/monitor/api-usage")).listApiUsageEntries();
  assert.ok(entries.some(entry => entry.statusCode === 200 && !entry.success && /180 秒/.test(entry.errorMessage || "")));
});

test("native and Chat SSE require final markers and preserve usage and vision input", async () => {
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  for (const protocol of ["anthropic_messages", "gemini_native", "chat_completions"] as const) {
    const chunks = protocol === "anthropic_messages" ? [
      { type: "message_start", message: { model: "mapped-ID", usage: { input_tokens: 3 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"ok":true}' } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }, { type: "message_stop" },
    ] : protocol === "gemini_native" ? [
      { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] },
      { modelVersion: "mapped-ID", candidates: [{ finishReason: "STOP", content: { parts: [] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } },
    ] : [{ choices: [{ delta: { content: '{"ok":true}' } }] }, { model: "mapped-ID", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }];
    const stream = chunks.map(event).join("") + (protocol === "chat_completions" ? "data: [DONE]\n\n" : "");
    respond = () => new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const start = calls.length;
    const result = await transport.callText({ ...credentials, textProtocol: protocol, structuredOutputMode: "prompt_json", model: "original-ID", input: "inspect", system: "inspect", images: ["data:image/png;base64,AA=="], schema: z.object({ ok: z.boolean() }), timeoutMs: 1000 });
    assert.deepEqual(result.parsed, { ok: true }); assert.equal(calls.length, start + 1);
    assert.match(JSON.stringify(calls.at(-1)?.body), /AA==/);
    assert.throws(() => transport.parseTextResponse(chunks.slice(0, -1).map(event).join(""), protocol), /interrupted/);
  }
});

test("caller cancellation is not relabeled as a local model timeout", async t => {
  const caller = new AbortController();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests++;
    return new Response(new ReadableStream({ start(controller) {
      init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
      queueMicrotask(() => caller.abort(new DOMException("Stopped by caller", "AbortError")));
    } }));
  });
  await assert.rejects(transport.callText({ ...credentials, model: "text-B", textProtocol: "responses", input: "JSON", system: "Check", timeoutMs: 180000, signal: caller.signal }), { name: "AbortError", message: "Stopped by caller" });
  assert.equal(requests, 1);
});

test("Images generates and edits exact selected IDs with correct fields and one failed dispatch", async () => {
  const ctx = await runtime.runWithProviderCredentials(credentials, () => providers.getProviderAdapter());
  const image = "data:image/png;base64,iVBORw0KGgo=";
  respond = () => Response.json({ data: [{ b64_json: "AA==" }] });
  await ctx.adapter.generateImageOnce({ model: "image-B", prompt: "test" });
  assert.ok(calls.at(-1)!.url.endsWith("/images/generations")); assert.equal(calls.at(-1)!.body.model, "image-B");
  for (const images of [[image], [image, image]]) {
    await ctx.adapter.generateImageOnce({ model: "image-B", prompt: "test", referenceImages: images });
    const last = calls.at(-1)!; assert.ok(last.url.endsWith("/images/edits"));
    assert.equal(last.body.get("model"), "image-B"); assert.equal(last.body.getAll(images.length > 1 ? "image[]" : "image").length, images.length);
  }
  respond = () => Response.json({ data: [{ url: "https://images.test/result.png" }] });
  assert.equal((await ctx.adapter.generateImage({ model: "image-B", prompt: "test" })).url, "https://images.test/result.png");
  respond = () => new Response("gateway timeout", { status: 504 }); const count = calls.length;
  await assert.rejects(ctx.adapter.editImage({ model: "image-B", prompt: "test", image })); assert.equal(calls.length, count + 1);
});

test("EvoLink async adaptation leaves other models and all other origins on their original Images routes", async () => {
  const { OpenAICompatibleAdapter } = await import("../lib/ai/adapters/openai-compatible");
  const image = "data:image/png;base64,AA==";
  respond = () => Response.json({ data: [{ b64_json: "AA==" }] });
  for (const [baseUrl, model] of [["https://api.evolink.ai", "image-B"], ["https://routing.test/prefix/v1", "gpt-image-2.5-flare"], ["https://api.evolink.ai.proxy.test/v1", "gpt-image-2.5-sunburst"], ["https://api.openai-proxy.org", "gpt-image-2"], ["https://api.openai-proxy.org/v1", "gpt-image-2.5-flare"]]) {
    const adapter = new OpenAICompatibleAdapter(baseUrl, "test-only");
    let count = calls.length;
    await adapter.generateImage({ model, prompt: "generate" });
    assert.equal(calls.length, count + 1); assert.ok(calls.at(-1)!.url.endsWith("/images/generations"));
    assert.equal(calls.at(-1)!.body.model, model);
    if (baseUrl.includes("api.openai-proxy.org")) assert.equal(calls.at(-1)!.url, "https://api.openai-proxy.org/v1/images/generations");
    count = calls.length;
    await adapter.editImage({ model, prompt: "edit", image });
    assert.equal(calls.length, count + 1); assert.ok(calls.at(-1)!.url.endsWith("/images/edits"));
    assert.equal(calls.at(-1)!.body.get("model"), model);
    if (baseUrl.includes("api.openai-proxy.org")) assert.equal(calls.at(-1)!.url, "https://api.openai-proxy.org/v1/images/edits");
  }
});

test("Gemini keeps ordinary proxy routes and previously saved EvoLink proxy routes", async () => {
  const { OpenAICompatibleAdapter } = await import("../lib/ai/adapters/openai-compatible");
  const model = "gemini-2.5-flash-image", image = "data:image/png;base64,AA==";
  respond = () => Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "AA==" } }] } }] });
  for (const baseUrl of [credentials.baseUrl, "https://api.evolink.ai/v1"]) {
    const adapter = new OpenAICompatibleAdapter(baseUrl, "test-only", baseUrl.includes("api.evolink.ai") ? { imageModelSettings: { [model]: { protocol: "gemini_proxy" } } } : {});
    for (const edit of [false, true]) {
      const count = calls.length;
      const result = edit ? await adapter.editImage({ model, prompt: "edit", image }) : await adapter.generateImage({ model, prompt: "generate" });
      assert.equal(calls.length, count + 1); assert.equal(result.b64Json, "AA==");
      assert.ok(calls.at(-1)!.url.endsWith(`/models/${model}:generateContent`));
      assert.equal(calls.at(-1)!.body.contents[0].parts.length, edit ? 2 : 1);
    }
  }
});
