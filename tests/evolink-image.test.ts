import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEvoLinkImage } from "../lib/ai/adapters/evolink-image";
import { resolveImageProtocol } from "../lib/ai/image-protocol";
import type { UpstreamImageTask } from "../lib/ai/provider-client";
import { evoLinkImageParameters } from "../lib/ai/image-parameters";
import { resolveImageModel } from "../lib/ai/image-protocol";

const image = "data:image/png;base64,AA==";
const model = "gpt-image-2.5-flare";
const task: UpstreamImageTask = { id: "task-example", protocol: "evolink_tasks", status: "pending" };
const json = (body: unknown, status = 200) => ({ ok: status < 300, status, body: JSON.stringify(body) });
const done = () => json({ id: task.id, status: "completed", results: ["https://result.test/image.png"] });

test("only the documented exact origin automatically selects the async contract", () => {
  for (const url of ["https://api.evolink.ai", "https://api.evolink.ai/", "https://api.evolink.ai/v1/"]) assert.equal(resolveImageProtocol(url), "evolink_tasks");
  for (const url of ["https://api.evolink.ai.evil.test", "https://proxy.test/evolink", "http://api.evolink.ai", "https://api.evolink.ai/proxy/v1", "https://api.evolink.ai:8443"]) assert.equal(resolveImageProtocol(url), "openai_images");
});

test("references and mask upload first; one POST preserves the model and saves its ID before any GET", async () => {
  const calls: Array<{ url: string; body: any; method: string }> = [];
  let saved: UpstreamImageTask | undefined;
  let checked = false;
  const result = await generateEvoLinkImage({ model, prompt: "edit", quality: "auto", aspectRatio: "3:4", outputFormat: "png", outputCompression: 100,
    referenceImages: [image, "https://source.test/reference.png"], mask: image,
    beforeSubmit: async () => { checked = true; }, onUpstreamTask: async value => { saved = value; },
  }, async (url, init) => {
    assert.equal(init.redirect, "error");
    calls.push({ url, method: init.method!, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("files-api")) return json({ success: true, data: { file_url: `https://files.evolink.ai/${calls.length}.png` } });
    if (init.method === "POST") { assert.equal(checked, true); return json({ id: task.id, status: "pending" }); }
    assert.deepEqual(saved, task); return done();
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[2].body, { model, prompt: "edit", n: 1, size: "3:4", output_format: "png", image_urls: ["https://files.evolink.ai/1.png", "https://source.test/reference.png"], mask_url: "https://files.evolink.ai/2.png" });
  assert.equal(calls[2].url, "https://api.evolink.ai/v1/images/generations");
  assert.equal(calls[3].url, "https://api.evolink.ai/v1/tasks/task-example");
  assert.equal(saved?.status, "completed"); assert.equal(result.url, "https://result.test/image.png");
});

test("poll disconnect retains ID; resume only GETs, even with input references", async () => {
  let saved: UpstreamImageTask | undefined, posts = 0;
  await assert.rejects(generateEvoLinkImage({ model, prompt: "generate", onUpstreamTask: async value => { saved = value; } }, async (_url, init) => {
    if (init.method === "POST") { posts++; return json({ id: task.id }); }
    throw new TypeError("fetch failed");
  }), { code: "IMAGE_TASK_PENDING" });
  assert.deepEqual(saved, task);
  const result = await generateEvoLinkImage({ model, prompt: "generate", referenceImages: [image], upstreamTask: saved }, async (_url, init) => {
    assert.equal(init.method, "GET"); return done();
  });
  assert.ok(result.url); assert.equal(posts, 1);
});

test("failed, empty, mismatched and unavailable tasks never cause another POST", async () => {
  for (const response of [json({ id: task.id, status: "failed" }), json({ id: task.id, status: "completed", results: [] }), json({ id: "wrong", status: "completed", results: ["https://result.test/a.png"] }), json({ id: task.id, status: "unknown" }), json({ error: "missing" }, 404)]) {
    let count = 0;
    await assert.rejects(generateEvoLinkImage({ model, prompt: "generate", upstreamTask: task }, async (_url, init) => {
      count++; assert.equal(init.method, "GET"); return response;
    }));
    assert.equal(count, 1);
  }
});

test("submission failures have one attempt and persistence failure stops before polling", async () => {
  for (const status of [401, 404, 405, 429, 500]) {
    let count = 0;
    await assert.rejects(generateEvoLinkImage({ model, prompt: "generate" }, async (_url, init) => {
      assert.equal(init.method, "POST"); count++; return json({ error: "unavailable" }, status);
    }));
    assert.equal(count, 1);
  }
  let count = 0;
  await assert.rejects(generateEvoLinkImage({ model, prompt: "generate", onUpstreamTask: async () => { throw new Error("checkpoint unavailable"); } }, async () => { count++; return json({ id: task.id }); }), /checkpoint unavailable/);
  assert.equal(count, 1);
});

test("stop after reference upload prevents the paid POST; canceled polling never resubmits", async () => {
  let count = 0;
  await assert.rejects(generateEvoLinkImage({ model, prompt: "generate", referenceImages: [image], beforeSubmit: async () => { throw new Error("stopped"); } }, async url => {
    assert.ok(url.includes("files-api")); count++; return json({ success: true, data: { file_url: "https://files.evolink.ai/input.png" } });
  }), /stopped/);
  assert.equal(count, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generateEvoLinkImage({ model, prompt: "generate", upstreamTask: task, signal: controller.signal }, async () => { throw new Error("must not dispatch"); }), { name: "AbortError" });
});

test("a pending task reaches its deadline without another paid dispatch", async () => {
  let count = 0;
  await assert.rejects(generateEvoLinkImage({ model, prompt: "generate", upstreamTask: task, timeoutMs: 20 }, async (_url, init) => {
    assert.equal(init.method, "GET"); count++; return json({ id: task.id, status: "processing" });
  }), { code: "IMAGE_TASK_PENDING" });
  assert.ok(count >= 1 && count <= 2);
});

test("documented image families select async routes and convert their own parameters", async () => {
  for (const [model, quality] of [["gpt-image-2", "high"], ["doubao-seedream-5.0-pro", "2K"], ["doubao-seedream-4.5", "4K"], ["gemini-3.1-flash-image-preview", "4K"], ["nano-banana-pro-beta", "4K"], ["qwen-image-3.0", "2K"], ["krea-2-turbo", "2K"]]) {
    const settings = resolveImageModel("https://api.evolink.ai", model);
    assert.equal(settings.protocol, "evolink_tasks");
    let posts = 0;
    const result = await generateEvoLinkImage({ model, prompt: "product", quality: "high", aspectRatio: "3:4" }, async (_url, init) => {
      if (init.method === "GET") return done();
      posts++; const body = JSON.parse(String(init.body));
      assert.equal(body.model, model); assert.equal(body.quality, quality); assert.equal(body.size, "3:4");
      return json({ id: task.id });
    }, settings.contract);
    assert.equal(posts, 1); assert.ok(result.url);
  }
  assert.equal(resolveImageModel("https://proxy.test", "doubao-seedream-5.0-pro").protocol, "openai_images");
  assert.equal(resolveImageModel("https://api.evolink.ai", "gemini-3-pro-image-preview", { legacyImageRouting: true }).protocol, "gemini_proxy");
  assert.equal(resolveImageModel("https://api.evolink.ai", "gpt-image-2", { imageModelSettings: { "gpt-image-2": { protocol: "openai_images" } } }).protocol, "openai_images");
});

test("unsupported input, special operations and masks stop before any upload or paid request", async () => {
  for (const input of [
    { model: "krea-2-turbo", referenceImages: [image] },
    { model: "qwen-image-edit" },
    { model: "doubao-seedream-5.0-pro", referenceImages: Array(11).fill(image) },
    { model: "nano-banana-pro-beta", referenceImages: [image], mask: image },
    { model: "mj-v7-edit" }, { model: "mj-v7" }, { model: "doubao-seedream-5.0-pro-layerize", referenceImages: [image] },
  ]) await assert.rejects(generateEvoLinkImage({ prompt: "product", ...input }, async () => { assert.fail("Must reject before dispatch"); }));
  const edit = evoLinkImageParameters({ model: "qwen-image-edit-plus", prompt: "edit", referenceImages: [image], aspectRatio: "3:4", outputFormat: "png" });
  assert.equal(edit.size, "768x1024"); assert.equal(edit.output_format, undefined);
});
