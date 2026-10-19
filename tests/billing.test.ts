import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { billingFamily, calculateBilling, defaultBillingRules, readBillingRequest, readBillingUsage, readProviderCostUsd } from "../lib/monitor/billing";

const close = (actual: number | null | undefined, expected: number) => assert.ok(actual != null && Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const luna = { model: "gpt-6-luna", category: "chat", success: true };
const image = { model: "gpt-image-2.5-flare", category: "image_edit", success: true };
test("model matching supports current aliases and dated snapshots without pricing unrelated models", () => {
  for (const id of ["gpt-6-luna", "GPT6LUNA", "gpt-6-luna-2026-09-08"]) assert.equal(billingFamily(id), "luna");
  for (const id of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst-2026-09-08", "gptimage2.5flare"]) assert.equal(billingFamily(id), "image25");
  assert.equal(billingFamily("gpt-image-2-2026-04-21"), "image2");
  for (const id of ["gpt-5.6-luna", "gpt-image-2-mini", "gpt-6-luna-custom", "other"]) assert.equal(billingFamily(id), null);
});
test("Luna prices input, cached input, cache writes and output without double counting", () => {
  const billingUsage = readBillingUsage({ usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200, cache_creation_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 300 } } });
  const result = calculateBilling({ ...luna, billingUsage });
  close(result.costUsd, .0003345); assert.equal(result.source, "tokens");
  assert.equal(result.tokens?.output, 500, "Reasoning tokens already in completion total must not be added again");
});
test("Luna long context and explicit processing tiers apply to the full request", () => {
  const billingUsage = readBillingUsage({ usage: { input_tokens: 300000, output_tokens: 1000 } });
  close(calculateBilling({ ...luna, billingUsage }).costUsd, .06075);
  close(calculateBilling({ ...luna, billingUsage, billingRequest: { serviceTier: "fast" } }).costUsd, .1215);
  close(calculateBilling({ ...luna, billingUsage, billingRequest: { serviceTier: "flex" } }).costUsd, .030375);
});
test("GPT Image prices modality usage and uses no cache discount on direct Images API", () => {
  const billingUsage = readBillingUsage({ usage: { input_tokens: 1000, output_tokens: 196, input_tokens_details: { text_tokens: 200, image_tokens: 800, cached_tokens: 500 } } });
  const result = calculateBilling({ ...image, billingUsage });
  close(result.costUsd, .01328); assert.equal(result.source, "tokens");
  close(calculateBilling({ ...image, billingUsage, billingRequest: { imageCount: 4 } }).costUsd, .01328);
  const detailOnly = readBillingUsage({ usage: { output_tokens: 196, input_tokens_details: { text_tokens: 200, image_tokens: 800 } } });
  close(calculateBilling({ ...image, billingUsage: detailOnly }).costUsd, .01328);
});

test("reported amounts reject blank values and non-USD currencies", () => {
  assert.equal(readProviderCostUsd({ cost: " " }), null);
  assert.equal(readProviderCostUsd({ cost: 10, currency: "CNY" }), null);
  assert.equal(readProviderCostUsd({ cost: 10, currency: "CNY", usage: { cost: 1.4, currency: "USD" } }), 1.4);
  assert.equal(readProviderCostUsd({ cost: 10, currency: "CNY", cost_usd: 1.4 }), 1.4);
  assert.equal(readProviderCostUsd({ usage: { total_cost: "0" } }), 0);
});
test("multipart records quality, size and image count without retaining prompt or base64", () => {
  const form = new FormData();
  form.set("prompt", "商品详情翻译 ACME"); form.set("quality", "low"); form.set("size", "1024x1024");
  form.append("image", new Blob(["secret-original"])); form.set("n", "2");
  const billingRequest = readBillingRequest(form);
  assert.equal(billingRequest.inputImages, 1); assert.equal(billingRequest.imageCount, 2);
  assert.doesNotMatch(JSON.stringify(billingRequest), /ACME|secret-original|商品详情/);
  const result = calculateBilling({ ...image, billingRequest, outputImageCount: 2 });
  close(result.costUsd, billingRequest.textTokens! * 5 / 1e6 + 1024 * 8 / 1e6 + 392 * 30 / 1e6);
  assert.equal(result.source, "approximation");
});
test("missing image usage uses explicit rough assumptions and never treats base64 response bytes as tokens", () => {
  const result = calculateBilling({ ...image, responseBytes: 50_000_000 });
  close(result.costUsd, 1024 * 8 / 1e6 + 196 * 30 / 1e6);
  assert.equal(result.source, "approximation"); assert.match(result.notes.join(" "), /low \/ 1024x1024/);
  const custom = structuredClone(defaultBillingRules); custom.fallback.quality = "medium";
  assert.ok(calculateBilling(image, custom).costUsd! > result.costUsd!);
});
test("provider amount, including zero, wins; failures and unknown models remain unpriced", () => {
  close(calculateBilling({ ...luna, actualCostUsd: .2, promptTokens: 1000, completionTokens: 500 }).costUsd, .2);
  const free = calculateBilling({ ...image, actualCostUsd: 0 }); close(free.costUsd, 0); assert.equal(free.source, "provider");
  assert.equal(calculateBilling({ ...luna, success: false, responseBytes: 1000 }).costUsd, null);
  assert.equal(calculateBilling({ ...image, success: false }).costUsd, null);
  assert.equal(calculateBilling({ ...luna, model: "unknown" }).costUsd, null);
  assert.equal(calculateBilling({ ...luna, category: "models" }).costUsd, null);
});

let directory: string;
let monitor: typeof import("../lib/monitor/api-usage");
let settings: typeof import("../lib/monitor/billing-settings");
const originalFetch = globalThis.fetch;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mxpage-billing-test-"));
  process.env.STORAGE_ROOT = directory;
  monitor = await import("../lib/monitor/api-usage"); settings = await import("../lib/monitor/billing-settings");
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (directory && path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith("mxpage-billing-test-")) await rm(directory, { recursive: true, force: true });
});
const log = (extra: Partial<Parameters<typeof monitor.logApiUsage>[0]> = {}) => monitor.logApiUsage({ providerBaseUrl: "https://billing.test/v1", endpoint: "https://billing.test/v1/chat/completions", method: "POST", model: "gpt-6-luna", operation: "billing_test", category: "chat", success: true, statusCode: 200, durationMs: 10, requestBytes: 300, responseBytes: 90, responseBody: "", ...extra });

test("saved exchange rates survive reload; legacy settings retain custom model prices", async () => {
  const { usdToCny, ...legacy } = structuredClone(defaultBillingRules);
  legacy.image.output = 22;
  await mkdir(path.join(directory, "monitor"), { recursive: true });
  await writeFile(path.join(directory, "monitor", "billing-rules.json"), JSON.stringify(legacy), "utf8");
  const upgraded = await settings.getBillingRules();
  assert.equal(upgraded.usdToCny, defaultBillingRules.usdToCny);
  assert.equal(upgraded.image.output, 22);
  await settings.saveBillingRules({ ...upgraded, usdToCny: 7.2 });
  assert.equal((await settings.getBillingRules()).usdToCny, 7.2);
  await settings.saveBillingRules(defaultBillingRules);
});

test("saved rules validate; new log snapshots stay fixed while legacy entries are estimated at current rates", async () => {
  await monitor.clearApiUsageEntries();
  await assert.rejects(settings.saveBillingRules({ ...defaultBillingRules, luna: { ...defaultBillingRules.luna, input: -1 } }));
  await settings.saveBillingRules(defaultBillingRules);
  const entry = await log({ responseBody: JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 500 } }) });
  close(entry.billing?.costUsd, .00035);
  const changed = structuredClone(defaultBillingRules); changed.luna.input = 2;
  await settings.saveBillingRules(changed);
  close((await monitor.listApiUsageEntries())[0].billing?.costUsd, .00035);
  const newer = await log({ responseBody: JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 500 } }) });
  close(newer.billing?.costUsd, .00225);
  await settings.saveBillingRules(defaultBillingRules);
});
test("legacy backfill, actual + estimated totals and pagination include more than 500 records", async () => {
  await mkdir(path.join(directory, "monitor"), { recursive: true });
  const original = { id: "legacy", timestamp: new Date().toISOString(), ...luna, promptTokens: 1000, completionTokens: 500, totalTokens: 1500, actualCostUsd: null, endpoint: "/chat/completions", requestBytes: 300, responseBytes: 300, durationMs: 1, statusCode: 200, quotaState: "ok", projectId: "project-a" };
  const rows = Array.from({ length: 510 }, (_, i) => ({ ...original, id: `legacy-${i}`, ...(i === 0 ? { actualCostUsd: .1, quotaState: "spending_limited" } : {}), ...(i === 1 ? { success: false, promptTokens: null, completionTokens: null, totalTokens: null } : {}) }));
  const file = path.join(directory, "monitor", "api-usage.jsonl"), raw = rows.map(row => JSON.stringify(row)).join("\n") + '\n{"partial":';
  await writeFile(file, raw, "utf8");
  const summary = await monitor.getApiUsageSummary({ limit: 10, page: 2 });
  assert.equal(summary.totalRequests, 510); assert.equal(summary.recentEntries.length, 10);
  assert.equal(summary.spendingLimitedRequests, 0, "Legacy successful responses must not trigger quota alerts");
  assert.equal(summary.charts.totals.requests, 510, "Charts must cover the entire window, not the current page");
  close(summary.charts.totals.costUsd, summary.recordedCostUsd);
  assert.equal(summary.charts.timeline.reduce((sum, point) => sum + point.requests, 0), 510);
  const failedOnly = await monitor.getApiUsageSummary({ success: "failed", limit: 1 });
  assert.equal(failedOnly.charts.totals.requests, 1);
  assert.equal(failedOnly.charts.totals.failed, 1);
  assert.equal(failedOnly.charts.totals.priced, 0);
  assert.equal(summary.costSamples, 1); assert.equal(summary.estimatedCostSamples, 508); assert.equal(summary.unknownCostSamples, 1);
  close(summary.recordedCostUsd, .1 + 508 * .00035);
  assert.match(summary.recentEntries[0].billing!.notes.join(" "), /历史补估/);
  assert.equal(await readFile(file, "utf8"), raw, "Reading must not overwrite original logs");
});
test("successful responses mentioning billing do not trigger quota alerts", async () => {
  const logged = await log({ responseBody: JSON.stringify({ choices: [{ message: { content: "Explain billing and quotas" } }] }) });
  assert.equal(logged.quotaState, "ok");
});

test("Gemini image output is counted without retaining image data or classifying vision as generation", async () => {
  const endpoint = "https://billing.test/google/v1beta/models/test:generateContent";
  const body = { generationConfig: { responseModalities: ["TEXT", "IMAGE"] } };
  assert.equal(monitor.inferCategory(endpoint, body), "image_generation");
  assert.equal(monitor.inferCategory(endpoint, { generationConfig: { responseModalities: ["TEXT"] } }), "google_generate_content");
  const row = await log({ endpoint, category: monitor.inferCategory(endpoint, body), responseBody: JSON.stringify({ candidates: [{ content: { parts: [
    { text: "image caption" }, { inlineData: { mimeType: "image/png", data: "private-image-bytes" } },
    { inline_data: { mime_type: "image/jpeg", data: "private-second-image" } },
    { inlineData: { mimeType: "audio/wav", data: "private-audio" } },
  ] } }] }) });
  assert.equal(row.outputImageCount, 2);
  assert.doesNotMatch(JSON.stringify(row), /private-image-bytes|private-second-image|private-audio/);
});

test("usage logs scope availability to a credential fingerprint without storing the key", async () => {
  const { runWithProviderCredentials, providerCredentialFingerprint } = await import("../lib/services/provider-runtime");
  const apiKey = "test-key-for-availability-only";
  const row = await runWithProviderCredentials({ apiKey }, () => log());
  assert.equal(row.credentialFingerprint, providerCredentialFingerprint(apiKey));
  assert.match(row.credentialFingerprint!, /^[a-f0-9]{64}$/);
  assert.notEqual(providerCredentialFingerprint(apiKey + "-changed"), row.credentialFingerprint);
  assert.equal(providerCredentialFingerprint("  "), undefined);
  assert.equal((await log()).credentialFingerprint, undefined, "Request context must not leak into other calls");
  assert.doesNotMatch(await readFile(path.join(directory, "monitor", "api-usage.jsonl"), "utf8"), /test-key-for-availability-only/);
});
test("structured responses record returned usage even on invalid JSON, exactly once per paid response", async () => {
  await monitor.clearApiUsageEntries();
  const { invokeStructured } = await import("../lib/detail-runs/structured-model");
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ id: "mock", object: "chat.completion", created: 1, model: "gpt-6-luna", choices: [{ index: 0, message: { role: "assistant", content: calls === 1 ? "invalid JSON" : '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } });
  };
  const request = { apiKey: "mock-test-only", baseUrl: "https://billing.test/v1", model: "gpt-6-luna", schema: z.object({ ok: z.boolean() }), system: "test system prompt", input: "sensitive test input", timeoutMs: 5000 };
  await assert.rejects(invokeStructured(request), SyntaxError);
  assert.equal(calls, 1, "invalid JSON must not cause an implicit paid repair");
  const result = await invokeStructured(request); // Explicit caller retry.
  assert.equal(result.ok, true); assert.equal(calls, 2);
  const entries = await monitor.listApiUsageEntries();
  assert.equal(entries.length, 2); assert.equal(entries.filter(entry => entry.success).length, 1);
  assert.ok(entries.every(entry => entry.totalTokens === 1500 && entry.billing?.source === "tokens"));
  close((await monitor.getApiUsageSummary()).recordedCostUsd, .0007);
  assert.doesNotMatch(await readFile(path.join(directory, "monitor", "api-usage.jsonl"), "utf8"), /sensitive test input|mock-test-only|test system prompt/);
  globalThis.fetch = originalFetch;
});
