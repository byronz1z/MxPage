import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createTranslationQueue, queueIsActive, queueProgress, translationShouldShow, QUEUE_STORAGE_KEY, type TranslationBatch, type TranslationSubmission } from "../lib/translation/client-queue";

const ok = (data: unknown) => Response.json({ success: true, data });
const until = async (check: () => boolean) => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail("Queue did not settle"); };
function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function snapshot(id: string, completed = 0, failed = 0): TranslationBatch {
  return { id, status: completed === 4 ? "SUCCESS" : failed ? "FAILED" : "RUNNING", items: ["en-US", "ja-JP"].map((language, i) => ({ projectId: `translated-${i}`, name: "测试商品", language: language as "en-US" | "ja-JP", ready: true, status: completed === 4 ? "COMPLETED" : failed ? "FAILED" : "RUNNING", message: "翻译中", translationProgress: { completed: Math.min(2, Math.max(0, completed - i * 2)), failed: i === 1 ? failed : 0, total: 2 }, images: [] })) };
}
function fixture() {
  const id = randomUUID(), storage = memory();
  const calls: Array<{ url: string; method: string; body: any }> = [];
  let batch = snapshot(id);
  let handle: ((call: typeof calls[number]) => Promise<Response | undefined>) | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    const call = { url: String(url), method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined }; calls.push(call);
    const override = await handle?.(call); if (override) return override;
    if (call.url === "/api/projects") return ok({ id: "source" });
    if (call.url.includes("/detail-batches")) return ok(batch);
    return ok({});
  };
  const readFile = async (file: File) => ({ fileName: file.name, mimeType: "image/png", base64Data: "original-bytes" });
  const deps = { storage, fetcher, readFile, uuid: () => id };
  const queue = createTranslationQueue(deps);
  const input: TranslationSubmission = { groups: [{ name: "测试商品", files: [new File(["image"], "1.png"), new File(["image"], "2.png")] }], languages: ["en-US", "ja-JP"], quality: "low", instruction: "ACME 不翻译" };
  return { id, queue, input, calls, storage, deps, setBatch: (next: TranslationBatch) => { batch = next; }, handle: (next: NonNullable<typeof handle>) => { handle = next; }, entry: () => queue.store.getState().entries[0] };
}

test("translation queue hides success, retains failures and waits for canceled in-flight images", async () => {
  const f = fixture(); f.queue.enqueue(f.input);
  assert.equal(translationShouldShow(f.entry()), true);
  await until(() => !!f.entry().batch);
  f.setBatch(snapshot(f.id, 3, 1)); await f.queue.tick();
  assert.equal(translationShouldShow(f.entry()), true);
  f.setBatch(snapshot(f.id, 3)); await f.queue.control(f.id, "resume", true);
  f.setBatch(snapshot(f.id, 4)); await f.queue.tick();
  assert.equal(translationShouldShow(f.entry()), false);
  assert.equal(f.entry().batch?.items.length, 2, "Completed results are preserved");
  const calls = f.calls.length; await f.queue.tick(); assert.equal(f.calls.length, calls);
  const stopped = { ...snapshot(f.id, 1), status: "CANCELED" };
  assert.equal(translationShouldShow({ ...f.entry(), batch: stopped }), true, "Let already-sent requests finish");
  stopped.items = stopped.items.map(item => ({ ...item, status: "CANCELED" }));
  assert.equal(translationShouldShow({ ...f.entry(), batch: stopped }), false);
  assert.equal(translationShouldShow({ ...f.entry(), phase: "error", batch: undefined }), true);
});

test("leaving the submitting page does not stop uploads; global subscribers see image progress", async () => {
  const f = fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.handle(async call => { if (call.url.endsWith("/assets/upload")) await gate; return undefined; });
  const unsubscribePage = f.queue.store.subscribe(() => undefined);
  f.queue.enqueue(f.input); unsubscribePage();
  assert.equal(f.entry().phase, "uploading"); assert.equal(f.entry().total, 4);
  f.queue.remove(f.id); assert.equal(f.queue.store.getState().entries.length, 1, "Active uploads cannot be dismissed");
  release(); await until(() => !!f.entry().batch);
  assert.equal(f.calls.filter(call => call.url === "/api/detail-batches").length, 1);
  assert.deepEqual(f.calls.find(call => call.url === "/api/detail-batches")!.body.translations, ["en-US", "ja-JP"]);
  assert.equal(f.entry().canRetryUpload, false);
  f.setBatch(snapshot(f.id, 2)); await f.queue.tick();
  assert.deepEqual(queueProgress(f.entry()), { completed: 2, failed: 0, total: 4, percent: 50 });
  assert.doesNotMatch(f.storage.getItem(QUEUE_STORAGE_KEY)!, /original-bytes|ACME|apiKey|base64|files/);
});

test("refresh restores all queue IDs using GET only, without reuploading or starting a new paid job", async () => {
  const f = fixture(); f.queue.enqueue(f.input); await until(() => !!f.entry().batch);
  const secondId = randomUUID();
  const metadata = JSON.parse(f.storage.getItem(QUEUE_STORAGE_KEY)!);
  f.storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify([...metadata, { id: secondId, title: "第二批", total: 8, createdAt: 1 }]));
  const before = f.calls.length;
  const restored = createTranslationQueue(f.deps); restored.hydrate(); restored.hydrate();
  await until(() => restored.store.getState().entries.every(entry => !!entry.batch));
  assert.equal(restored.store.getState().entries.length, 2);
  assert.ok(f.calls.slice(before).every(call => call.method === "GET"));
  assert.equal(restored.store.getState().entries.find(entry => entry.id === secondId)?.total, 8);
});

test("partial failure is not 100 percent or automatically retried; explicit retry sends one action", async () => {
  const f = fixture(); f.queue.enqueue(f.input); await until(() => !!f.entry().batch);
  f.setBatch(snapshot(f.id, 3, 1)); await f.queue.tick();
  assert.equal(queueIsActive(f.entry()), false); assert.equal(queueProgress(f.entry()).percent, 75);
  const before = f.calls.length; await f.queue.tick(); assert.equal(f.calls.length, before);
  f.setBatch(snapshot(f.id, 3)); await f.queue.control(f.id, "resume", true);
  assert.deepEqual(f.calls.at(-1)?.body, { action: "resume", retryFailed: true });
  assert.equal(queueIsActive(f.entry()), true);
  f.setBatch(snapshot(f.id, 4)); await f.queue.tick();
  const complete = f.calls.length; await f.queue.tick(); assert.equal(f.calls.length, complete);
  f.queue.remove(f.id); assert.equal(f.queue.store.getState().entries.length, 0);
});

test("failed submission retries the same batch ID and reuses acknowledged uploads", async () => {
  const f = fixture(); let fail = true;
  f.handle(async call => call.url === "/api/detail-batches" && fail ? Response.json({ success: false, error: { message: "Lost response" } }, { status: 502 }) : undefined);
  f.queue.enqueue(f.input); await until(() => f.entry().phase === "error");
  const uploaded = f.calls.filter(call => call.url.endsWith("/assets/upload")).length;
  fail = false; await f.queue.retryUpload(f.id);
  assert.equal(f.calls.filter(call => call.url.endsWith("/assets/upload")).length, uploaded);
  const submissions = f.calls.filter(call => call.url === "/api/detail-batches");
  assert.equal(submissions.length, 2); assert.deepEqual(submissions[0].body, submissions[1].body);
});

test("a missing restored task stops polling and explains interrupted uploads", async () => {
  const f = fixture(); f.storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify([{ id: f.id, title: "上传中断", total: 4 }]));
  f.handle(async () => Response.json({ success: false, error: { message: "Not found" } }, { status: 404 }));
  f.queue.hydrate(); await until(() => f.entry().phase === "error");
  assert.match(f.entry().error!, /重新选择原图/);
  const before = f.calls.length; await f.queue.tick(); assert.equal(f.calls.length, before);
});

test("a stale polling response cannot overwrite a stop action", async () => {
  const f = fixture(); f.queue.enqueue(f.input); await until(() => !!f.entry().batch);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.handle(async call => {
    if (call.method === "GET") { await gate; return ok(snapshot(f.id)); }
    if (call.body?.action === "cancel") return ok({ ...snapshot(f.id, 1), status: "CANCELED" });
    return undefined;
  });
  const poll = f.queue.tick(); await f.queue.control(f.id, "cancel"); release(); await poll;
  assert.equal(f.entry().batch?.status, "CANCELED");
});

test("opening a batch before the root effect hydrates preserves previously tracked batches", async () => {
  const f = fixture(), olderId = randomUUID();
  f.storage.setItem(QUEUE_STORAGE_KEY, JSON.stringify([{ id: olderId, title: "上一批", total: 8, createdAt: 1 }]));
  f.queue.watch(f.id);
  await until(() => f.queue.store.getState().entries.every(entry => !!entry.batch));
  assert.equal(f.queue.store.getState().entries.length, 2);
  assert.equal(f.queue.store.getState().entries.find(entry => entry.id === olderId)?.total, 8);
  assert.equal(JSON.parse(f.storage.getItem(QUEUE_STORAGE_KEY)!).length, 2);
  assert.ok(f.calls.every(call => call.method === "GET"));
});
