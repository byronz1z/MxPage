import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultProfile, profileSchema, readProfile } from "../lib/profile";
import { buildUsageActivity, usageDay } from "../lib/monitor/activity";
import { resolveImageApiStatus } from "../lib/monitor/provider-status";
import type { ApiUsageEntry } from "../lib/monitor/api-usage";

const now = Date.parse("2026-10-16T04:00:00Z");
const config = { model: "gpt-image-2.5-flare", baseUrl: "https://example.test/v1", fingerprint: "test-key-hash" };
function entry(extra: Partial<ApiUsageEntry> = {}): ApiUsageEntry {
  return {
    id: "request", timestamp: new Date(now - 60_000).toISOString(), providerBaseUrl: config.baseUrl,
    credentialFingerprint: config.fingerprint, endpoint: "/v1/images/edits", finalEndpoint: null, method: "POST", model: config.model,
    projectId: null, sectionId: null, operation: "test", category: "image_edit", success: true,
    statusCode: 200, durationMs: 1000, requestBytes: 10, responseBytes: 10, promptTokens: 10,
    completionTokens: 20, totalTokens: 30, actualCostUsd: null, attemptCount: 1, retrySummary: null,
    collapsedAttempts: [], quotaState: "ok", errorMessage: null, ...extra,
  };
}

test("local profiles round-trip trimmed names and valid raster avatars; corrupt data falls back", () => {
  const value = { name: "  茶席设计师  ", username: "studio.tea", avatar: "data:image/webp;base64,YQ==" };
  assert.deepEqual(readProfile(JSON.stringify(value)), { ...value, name: "茶席设计师" });
  for (const raw of [null, "{bad", "null", JSON.stringify({ ...value, username: "invalid user" })]) assert.deepEqual(readProfile(raw), defaultProfile);
  for (const avatar of ["https://example.test/avatar.png", "data:image/svg+xml;base64,YQ==", "javascript:alert(1)"])
    assert.equal(profileSchema.safeParse({ ...value, avatar }).success, false);
  assert.equal(profileSchema.safeParse({ ...value, name: " " }).success, false);
  assert.equal(profileSchema.safeParse({ ...value, name: "a".repeat(41) }).success, false);
});

test("activity covers the latest 12 calendar months only through today", () => {
  const data = buildUsageActivity([
    entry({ timestamp: "2025-10-31T15:59:59Z", actualCostUsd: 1 }),
    entry({ timestamp: "2025-10-31T16:00:00Z", actualCostUsd: .2 }),
    entry({ timestamp: new Date(now).toISOString(), actualCostUsd: .3 }),
    entry({ timestamp: "2026-11-01T04:00:00Z", actualCostUsd: 2 }),
  ], now);
  assert.equal(data.startDate, "2025-11-01");
  assert.equal(data.startWeekday, 6);
  assert.equal(data.days.at(-1)?.date, "2026-10-16");
  assert.equal(data.days.length, 350);
  assert.equal(new Set(data.days.map(day => day.date.slice(0, 7))).size, 12);
  assert.ok(data.days.every(day => day.date <= data.today));
  assert.ok(!data.days.some(day => /^2026-(11|12)/.test(day.date)));
  assert.equal(data.days[0].requests, 1);
  assert.equal(data.totals.requests, 2);
  assert.equal(data.totals.tokens, 60);
  assert.equal(data.totals.costUsd, .5);
});

test("rolling activity includes leap days and consecutive dates without month overflow", () => {
  const leap = buildUsageActivity([], Date.parse("2024-12-31T04:00:00Z"));
  assert.equal(leap.startDate, "2024-01-01");
  assert.equal(leap.days.length, 366);
  assert.equal(leap.startWeekday, 1);
  assert.equal(leap.days[59].date, "2024-02-29");
  for (const timestamp of ["2026-01-01T04:00:00Z", "2026-02-28T04:00:00Z", "2024-02-29T04:00:00Z", "2026-03-31T04:00:00Z"]) {
    const data = buildUsageActivity([], Date.parse(timestamp));
    assert.equal(data.days.at(-1)?.date, timestamp.slice(0, 10));
    assert.equal(new Set(data.days.map(day => day.date.slice(0, 7))).size, 12);
    data.days.slice(1).forEach((day, i) => assert.equal(Date.parse(day.date) - Date.parse(data.days[i].date), 86_400_000));
  }
});

test("rolling activity uses UTC+8 at midnight and year boundaries", () => {
  assert.equal(usageDay(Date.parse("2025-12-31T16:00:00Z")), "2026-01-01");
  const data = buildUsageActivity([
    entry({ timestamp: "2025-12-31T15:59:59Z" }), entry({ timestamp: "2025-12-31T16:00:00Z" }),
  ], Date.parse("2025-12-31T16:00:00Z"));
  assert.equal(data.startDate, "2025-02-01");
  assert.equal(data.today, "2026-01-01");
  assert.equal(data.days.at(-2)?.date, "2025-12-31");
  assert.equal(data.days.at(-2)?.requests, 1);
  assert.equal(data.days.at(-1)?.requests, 1);
  assert.equal(data.totals.requests, 2);
});

test("activity excludes malformed/future entries and distinguishes unknown usage from known zero", () => {
  const data = buildUsageActivity([
    entry({ totalTokens: null }), entry({ totalTokens: 0, actualCostUsd: 0 }),
    entry({ totalTokens: -1 }), entry({ totalTokens: NaN }),
    entry({ billing: { costUsd: .2, source: "tokens" } as ApiUsageEntry["billing"], actualCostUsd: .5 }),
    entry({ timestamp: "invalid" }), entry({ timestamp: new Date(now + 1).toISOString() }),
  ], now);
  assert.equal(data.totals.requests, 5);
  assert.equal(data.totals.tokenSamples, 2);
  assert.equal(data.totals.tokens, 30);
  assert.equal(data.totals.priced, 2);
  assert.equal(data.totals.costUsd, .2);
  assert.equal(data.totals.activeDays, 1);
});

test("current activity streak spans years and remains active until yesterday", () => {
  const entries = ["2025-12-30", "2025-12-31", "2026-01-01"].map(date => entry({ timestamp: `${date}T04:00:00Z` }));
  const data = buildUsageActivity(entries, Date.parse("2026-01-02T04:00:00Z"));
  assert.equal(data.currentStreak, 3);
  assert.equal(data.longestStreak, 3);
  assert.equal(buildUsageActivity(entries, Date.parse("2026-01-03T04:00:00Z")).currentStreak, 0);
  const empty = buildUsageActivity([], now);
  assert.equal(empty.currentStreak, 0); assert.equal(empty.peakTokens, 0);
});

test("provider status requires credentials and ignores other identities and invalid timestamps", () => {
  assert.equal(resolveImageApiStatus([], { ...config, fingerprint: undefined }, now).state, "unconfigured");
  assert.equal(resolveImageApiStatus([], { ...config, baseUrl: " " }, now).state, "unconfigured");
  for (const row of [
    entry({ credentialFingerprint: "old-key" }), entry({ providerBaseUrl: "https://different.test" }),
    entry({ timestamp: "invalid" }),
    entry({ timestamp: new Date(now + 1).toISOString() }),
  ]) {
    const status = resolveImageApiStatus([row], config, now);
    assert.equal(status.state, "unverified");
    assert.equal(status.imageVerification.state, "unverified");
    assert.equal(status.imageVerification.checkedAt, null);
  }
});

test("successful discovery and text probes connect the service without claiming image verification", () => {
  for (const row of [
    entry({ category: "models", model: null }),
    entry({ category: "structured", model: "gpt-6-luna", operation: "provider_connection_probe" }),
    entry({ category: "chat", model: "gpt-6-luna" }),
    entry({ model: "another-image-model" }),
  ]) {
    const status = resolveImageApiStatus([row], config, now);
    assert.equal(status.state, "available");
    assert.equal(status.checkedAt, row.timestamp);
    assert.deepEqual(status.imageVerification, { state: "unverified", checkedAt: null, source: null });
  }
  const noImage = resolveImageApiStatus([entry({ category: "models", model: null })], { ...config, model: null }, now);
  assert.equal(noImage.state, "available");
  assert.equal(noImage.imageVerification.state, "unconfigured");
});

test("connection and image verification persist past fifteen minutes and configuration saves", () => {
  for (const age of [900_001, 86_400_001, 30 * 86_400_000]) {
    const success = entry({ timestamp: new Date(now - age).toISOString() });
    const savedConfig = { ...config, configuredAt: now };
    const status = resolveImageApiStatus([success], savedConfig, now);
    assert.equal(status.state, "available");
    assert.deepEqual(status.imageVerification, { state: "available", checkedAt: success.timestamp, source: "current-credential" });
  }
});

test("Gemini image calls verify images without treating text, vision or probes as image output", () => {
  for (const operation of ["v4_image_generation", "translate_image", "repaint_section_image"]) {
    assert.equal(resolveImageApiStatus([entry({ category: "google_generate_content", operation })], config, now).imageVerification.state, "available");
  }
  for (const operation of ["v4_image_review", "provider_connection_probe", "v4_plan"]) {
    assert.equal(resolveImageApiStatus([entry({ category: "google_generate_content", operation })], config, now).imageVerification.state, "unverified");
  }
  assert.equal(resolveImageApiStatus([entry({ category: "google_generate_content", operation: "v4_image_generation", success: false })], config, now).imageVerification.state, "unavailable");
});

test("a later probe refreshes service connection while preserving the actual image verification time", () => {
  const image = entry({ timestamp: new Date(now - 3 * 3_600_000).toISOString() });
  const probe = entry({ category: "chat", model: "gpt-6-luna", operation: "provider_connection_probe" });
  const unrelated = Array.from({ length: 301 }, () => entry({ category: "chat", model: "gpt-6-luna" }));
  const status = resolveImageApiStatus([image, probe, ...unrelated], config, now);
  assert.equal(status.state, "available");
  assert.equal(status.checkedAt, probe.timestamp);
  assert.equal(status.imageVerification.checkedAt, image.timestamp);
});

test("real failures update status, retain image history and recover after a successful probe", () => {
  const success = entry({ providerBaseUrl: "https://example.test/v1/" });
  assert.equal(resolveImageApiStatus([success], config, now).state, "available");
  const failure = entry({ model: "gpt-6-luna", category: "chat", success: false, statusCode: 401, timestamp: new Date(now).toISOString() });
  const status = resolveImageApiStatus([success, failure], config, now);
  assert.equal(status.state, "unavailable");
  assert.deepEqual(status.imageVerification, { state: "available", checkedAt: success.timestamp, source: "current-credential" });
  const failedImage = entry({ success: false, statusCode: 504 });
  assert.equal(resolveImageApiStatus([failedImage], config, now).state, "unavailable");
  const probe = { ...failure, success: true, statusCode: 200, operation: "provider_connection_probe" };
  const recovered = resolveImageApiStatus([failedImage, probe], config, now);
  assert.equal(recovered.state, "available");
  assert.deepEqual(recovered.imageVerification, { state: "unavailable", checkedAt: failedImage.timestamp, source: "current-credential" });
  assert.equal(resolveImageApiStatus([success, { ...failure, credentialFingerprint: "another-key" }], config, now).state, "available");
  for (const statusCode of [0, 401, 403, 429, 500, 503]) {
    assert.equal(resolveImageApiStatus([{ ...failure, statusCode }], config, now).state, "unavailable");
  }
});

test("model-specific input errors do not erase service connectivity", () => {
  const success = entry({ category: "models", model: null });
  const inputError = entry({ success: false, statusCode: 400, timestamp: new Date(now).toISOString() });
  const status = resolveImageApiStatus([success, inputError], config, now);
  assert.equal(status.state, "available");
  assert.equal(status.imageVerification.state, "unavailable");
  assert.equal(status.imageVerification.checkedAt, inputError.timestamp);
  const failedProbe = { ...inputError, category: "chat" as const, model: "gpt-6-luna", operation: "provider_connection_probe", statusCode: 404 };
  assert.equal(resolveImageApiStatus([success, failedProbe], config, now).state, "unavailable");
});

test("changing image model resets only its verification; changing credentials resets both", () => {
  const success = entry();
  const modelChanged = resolveImageApiStatus([success], { ...config, model: "gpt-image-2" }, now);
  assert.equal(modelChanged.state, "available");
  assert.equal(modelChanged.imageVerification.state, "unverified");
  assert.equal(modelChanged.imageVerification.checkedAt, null);
  const keyChanged = resolveImageApiStatus([success], { ...config, fingerprint: "new-key" }, now);
  assert.equal(keyChanged.state, "unverified");
  assert.equal(keyChanged.imageVerification.checkedAt, null);
});

test("legacy image logs show dated model history without verifying current credentials", () => {
  const legacy = entry({ credentialFingerprint: undefined, timestamp: new Date(now - 86_400_000).toISOString() });
  const historical = resolveImageApiStatus([legacy], config, now);
  assert.equal(historical.state, "unverified");
  assert.deepEqual(historical.imageVerification, { state: "available", checkedAt: legacy.timestamp, source: "legacy-record" });
  const probe = entry({ category: "chat", model: "gpt-6-luna", operation: "provider_connection_probe" });
  const connected = resolveImageApiStatus([legacy, probe], config, now);
  assert.equal(connected.state, "available");
  assert.equal(connected.imageVerification.source, "legacy-record");
  const current = entry();
  const verified = resolveImageApiStatus([legacy, probe, current], config, now);
  assert.equal(verified.imageVerification.source, "current-credential");
  assert.equal(verified.imageVerification.checkedAt, current.timestamp);
  const unrelated = resolveImageApiStatus([{ ...legacy, providerBaseUrl: "https://different.test" }], config, now);
  assert.equal(unrelated.imageVerification.checkedAt, null);
});
