import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { V4Checkpoint } from "../lib/detail-runs/service-v4";
import { buildSupplementalSubmission, normalizeSupplementalQuestions } from "../lib/detail-runs/supplemental-input";
import { assertStrictResponseSchema } from "./helpers/strict-response-schema";

let directory: string;
let db: typeof import("../lib/db/prisma").prisma;
let service: typeof import("../lib/detail-runs/service-v4");
let storage: typeof import("../lib/storage/asset-manager");
let runtime: typeof import("../lib/services/provider-runtime");
let leases: typeof import("../lib/detail-runs/run-lease");
let png: Buffer;
const credentials = { apiKey: "isolated-v4-test-key", baseUrl: "https://workflow.test/v1" };
const originalFetch = globalThis.fetch;
type Call = { kind: "PLAN" | "PLAN_CONTENT_REPAIR" | "INPUT_SUGGESTIONS" | "ART_DIRECTION" | "GENERATE" | "IMAGE_REVIEW" | "SET_REVIEW"; input: any; index?: number; body: any; url: string; signal?: AbortSignal | null };
let calls: Call[] = [];
let respond: (call: Call) => Promise<Response>;
let inFlight = 0, peak = 0;
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 800; i++) { if (await check()) return; await pause(); }
  throw new Error("V4 test did not settle");
}
async function settled(id: string, approvePrompts = true): Promise<Awaited<ReturnType<typeof db.detailRun.findUniqueOrThrow>>> {
  await until(async () => {
    const run = await db.detailRun.findUniqueOrThrow({ where: { id } });
    return !["RUNNING", "PENDING"].includes(run.status) && !(globalThis as any).detailV4Workers?.has(id);
  });
  const run = await db.detailRun.findUniqueOrThrow({ where: { id } });
  if (approvePrompts && run.status === "WAITING_PROMPTS") {
    await approve(run);
    return settled(id, false);
  }
  return run;
}
async function approve(run: { id: string; projectId: string; checkpoint: unknown }, edits?: string[]) {
  const review = cpOf(run).promptReview!;
  const body = { revision: review.revision, confirmationId: randomUUID(), pages: review.pages.map((page, index) => ({ sectionId: page.sectionId, prompt: edits?.[index] ?? page.prompt })) };
  await runtime.runWithProviderCredentials(credentials, () => service.controlV4DetailRun(run.projectId, run.id, "confirm-prompts", body, credentials));
  return body;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function plan(heroes = 3, details = 4) {
  return { productName: "Tea cup", category: "Home", facts: ["Brown cup"], requirements: [], missingFields: [],
    contentCoverage: ["need", "selling_points", "scenarios", "details", "specifications", "trust", "usage", "closing"].map(module => ({ module, status: "covered", sectionIndexes: [details ? heroes : 0], reason: "Confirmed copy" })),
    sections: Array.from({ length: heroes + details }, (_, index) => ({ kind: index < heroes ? "HERO" : "DETAIL", title: `Section ${index}`, objective: "Show original product faithfully", buyerQuestion: "What is it?", copy: `Original copy ${index}`, evidence: ["user_description"] })),
  };
}
function art(p = plan()) {
  return { concept: "Warm natural light with detailed product identity", palette: ["#FFFFFF", "#CCCCCC"], typography: "Clear readable typography", sections: p.sections.map((section, sectionIndex) => ({ sectionIndex, expression: "photo", prompt: `Image-${sectionIndex} clear product view and accurate original text`, textBlocks: [{ text: section.copy, role: "body", x: 5, y: 5, width: 90, fontSize: 24, lineHeight: 1.2, align: "left" }] })) };
}
function completion(value: unknown) {
  return Response.json({ id: "mock", object: "chat.completion", created: 1, model: "gpt-6-luna", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(value) }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
}
async function success(call: Call): Promise<Response> {
  if (call.kind === "GENERATE") { await pause(); return Response.json({ data: [{ b64_json: png.toString("base64") }] }); }
  if (call.kind === "PLAN") return completion(plan(call.input.requestedHeroCount, call.input.requestedDetailCount));
  if (call.kind === "INPUT_SUGGESTIONS") return completion({ questions: [
    { text: call.input.missingFields[0]?.question || "商品用途？", fields: [call.input.requiredFields[0] || "purpose"], options: ["日常喝茶", "早餐咖啡", "办公室热水"] },
    { text: call.input.missingFields[1]?.question || "买家人群？", fields: [call.input.requiredFields[1] || "audience"], options: ["自己居家使用", "办公室同事赠礼", "茶友交流送礼"] },
    { text: call.input.missingFields[2]?.question || "使用场景？", fields: call.input.requiredFields.length > 2 ? call.input.requiredFields.slice(2) : ["scene"], options: ["早晨餐桌", "书房阅读", "会客茶席"] },
  ].map(question => ({ ...question, options: question.options.map((option, index) => {
    const subject = question.fields.join(" ");
    const values = [
      /尺寸|直径|高度|size/i.test(subject) ? `尺寸约${8 + index}×${8 + index} cm` : "",
      /净重|重量|weight/i.test(subject) ? `净重约${200 + index * 50} g` : "",
      /容量|capacity/i.test(subject) ? `容量约${250 + index * 50} mL` : "",
    ].filter(Boolean);
    return values.length ? values.join("；") : option;
  }) })) });
  if (call.kind === "PLAN_CONTENT_REPAIR") return completion({ placements: call.input.modulesToPlace.map((entry: any, index: number) => ({ module: entry.module, detailIndex: 3 + index })) });
  if (call.kind === "ART_DIRECTION") return completion(art(call.input.plan));
  return completion({ passed: true, issues: [] });
}
const cpOf = (run: { checkpoint: unknown }) => run.checkpoint as V4Checkpoint;
const count = (kind: Call["kind"]) => calls.filter(call => call.kind === kind).length;
async function project() {
  const row = await db.project.create({ data: { name: "Isolated workflow test", description: "Brown cup", platform: "general_ecommerce", style: "generic_clean" } });
  await storage.saveUploadAsset({ projectId: row.id, type: "MAIN", fileName: "source.png", fileBuffer: png, mimeType: "image/png", sortOrder: 0 });
  return row.id;
}
async function start() {
  const projectId = await project();
  const input = { idempotencyKey: randomUUID(), heroCount: 3, detailCount: 4, mode: "create", quality: "low" };
  const run = await runtime.runWithProviderCredentials(credentials, () => service.createV4DetailRun(projectId, input, credentials));
  return { projectId, runId: run!.id, input };
}
async function resume(projectId: string, runId: string, retryUncertain = false) {
  await runtime.runWithProviderCredentials(credentials, () => service.controlV4DetailRun(projectId, runId, "resume", { retryUncertain }, credentials));
  return settled(runId);
}
async function seed(options: { generated?: number[]; checked?: boolean; total?: number; orphan?: number; stage?: string; status?: string } = {}) {
  const projectId = await project(), runId = randomUUID(), total = options.total ?? 7;
  const p = plan(3, total - 3);
  const checkpoint: V4Checkpoint = { workflowVersion: 4, stage: options.stage ?? "GENERATE", plan: p as any, artDirection: art(p) as any, images: [], imageReviews: {}, answers: [], attempts: {}, timings: {}, requests: {} };
  for (let index = 0; index < total; index++) {
    const section = await db.pageSection.create({ data: { projectId, sectionKey: `v4-${index}`, order: index, type: index < 3 ? "HERO" : "CUSTOM", title: p.sections[index].title, goal: p.sections[index].objective, copy: p.sections[index].copy, visualPrompt: art(p).sections[index].prompt, editableData: { workflowVersion: 4 } } });
    const image: V4Checkpoint["images"][number] = { sectionId: section.id, title: section.title, state: "pending", correctionCount: 0 };
    if (options.generated?.includes(index) || options.orphan === index) {
      const asset = await storage.saveGeneratedImage({ projectId, sectionId: section.id, prompt: section.visualPrompt, source: { b64Json: png.toString("base64") }, metadata: { runId, workflowVersion: 4, requestId: `saved-${index}` } });
      if (options.orphan !== index) {
        image.assetId = asset.id; image.state = options.checked ? "checked" : "generated";
        if (options.checked) { image.check = { passed: true, issues: [] }; checkpoint.imageReviews[image.sectionId] = image.check; }
        await db.pageSection.update({ where: { id: section.id }, data: { currentImageAssetId: asset.id, status: "SUCCESS" } });
      } else { image.state = "generating"; checkpoint.requests![`GENERATE:${section.id}`] = { state: "running", requestId: `saved-${index}` }; }
    }
    checkpoint.images.push(image);
  }
  await db.detailRun.create({ data: { id: runId, projectId, idempotencyKey: randomUUID(), status: options.status ?? "PARTIAL", stage: checkpoint.stage, checkpoint: checkpoint as any,
    input: { workflowVersion: 4, mode: "create", heroCount: 3, detailCount: total - 3, quality: "low", language: "zh-CN", planningModelId: "gpt-6-luna", imageModelId: "gpt-image-2.5-flare", editModelId: "gpt-image-2.5-flare" } } });
  return { projectId, runId, checkpoint };
}
async function saveCheckpoint(runId: string, checkpoint: V4Checkpoint) { await db.detailRun.update({ where: { id: runId }, data: { checkpoint: checkpoint as any } }); }

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mxpage-v4-recovery-test-"));
  const filename = path.join(directory, "test.db");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const sqlite = new DatabaseSync(filename);
  try {
    const migrations = path.resolve("prisma/migrations");
    for (const item of (await readdir(migrations, { withFileTypes: true })).filter(item => item.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) sqlite.exec(await readFile(path.join(migrations, item.name, "migration.sql"), "utf8"));
  } finally { sqlite.close(); }
  process.env.DATABASE_URL = `file:${filename.replaceAll("\\", "/")}`;
  process.env.STORAGE_ROOT = path.join(directory, "storage");
  delete process.env.LOCK_BASE_URL; delete process.env.FORCED_API_BASE; delete process.env.FORCED_API_BASE_URL;
  db = (await import("../lib/db/prisma")).prisma;
  service = await import("../lib/detail-runs/service-v4");
  storage = await import("../lib/storage/asset-manager");
  runtime = await import("../lib/services/provider-runtime");
  leases = await import("../lib/detail-runs/run-lease");
  png = await sharp({ create: { width: 32, height: 48, channels: 3, background: "#c4ad89" } }).png().toBuffer();
  await db.providerConfig.create({ data: { name: "Isolated V4", baseUrl: credentials.baseUrl, apiKeyEncrypted: "unused", isActive: true, models: { create: [
    { modelId: "gpt-6-luna", label: "Luna", capabilities: { text: true, vision: true, structured_output: true }, roles: {}, isDefaultPlanning: true, isDefaultAnalysis: true },
    { modelId: "gpt-image-2.5-flare", label: "Flare", capabilities: { image_edit: true, image_gen: true }, roles: {}, isDefaultHeroImage: true, isDefaultDetailImage: true, isDefaultImageEdit: true },
  ] } } });
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith(credentials.baseUrl), "Never contact a live provider");
    let call: Call;
    if (init?.body instanceof FormData) {
      const body = init.body;
      assert.ok(["gpt-image-2.5-flare", "image-B"].includes(String(body.get("model")))); assert.equal(body.get("quality"), "low");
      call = { kind: "GENERATE", index: Number(String(body.get("prompt")).match(/Image-(\d+)/)?.[1]), input: null, body, url: String(url) };
    } else if (String(url).endsWith("/images/generations")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "gpt-image-2.5-flare");
      assert.equal(body.quality, "low");
      call = { kind: "GENERATE", index: Number(body.prompt.match(/Image-(\d+)/)?.[1]), input: null, body, url: String(url) };
    } else {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/responses")) {
        body.messages = [{ role: "system", content: body.instructions }, { role: "user", content: [{ type: "text", text: body.input[0].content[0].text }] }];
        body.response_format = { type: "json_schema", json_schema: body.text.format };
      }
      assert.ok(["gpt-6-luna", "text-B", "vision-B"].includes(body.model)); assert.equal(body.tools, undefined); assert.equal(body.response_format.type, "json_schema");
      assertStrictResponseSchema(body.response_format.json_schema.schema);
      const system = body.messages[0].content;
      const kind = system.includes("商品补充候选模型") ? "INPUT_SUGGESTIONS" : system.includes("内容安排修复模型") ? "PLAN_CONTENT_REPAIR" : /商品规划模型|小红书图文规划模型/.test(system) ? "PLAN" : /视觉分镜模型|XHS VISUAL DIRECTOR/.test(system) ? "ART_DIRECTION" : system.includes("整套页面检查模型") ? "SET_REVIEW" : "IMAGE_REVIEW";
      call = { kind, input: JSON.parse(body.messages[1].content[0].text), body, url: String(url) };
    }
    call.signal = init?.signal;
    calls.push(call);
    if (call.kind === "GENERATE") { inFlight++; peak = Math.max(peak, inFlight); }
    try {
      const response = await respond(call);
      if (String(url).endsWith("/responses") && response.ok) {
        const chat = await response.json();
        return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: chat.choices[0].message.content }] }] });
      }
      return response;
    } finally { if (call.kind === "GENERATE") inFlight--; }
  };
});
beforeEach(() => { calls = []; peak = 0; respond = success; });
after(async () => {
  globalThis.fetch = originalFetch;
  await db?.$disconnect();
  if (directory && path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith("mxpage-v4-recovery-test-")) await rm(directory, { recursive: true, force: true });
});

test("new detail tasks save every final prompt and cannot generate before explicit approval", async () => {
  const fixture = await start();
  const waiting = await settled(fixture.runId, false);
  assert.equal(waiting.status, "WAITING_PROMPTS");
  assert.deepEqual([count("PLAN"), count("ART_DIRECTION"), count("GENERATE")], [1, 1, 0]);
  const review = cpOf(waiting).promptReview!;
  assert.equal(review.pages.length, 7);
  assert.ok(review.pages.every(page => page.prompt.includes("Exact copy:")));
  assert.equal(cpOf(waiting).taskTiming?.finishedAt !== undefined, true);
  const read = await service.getV4DetailRun(fixture.projectId, fixture.runId);
  assert.deepEqual(cpOf(read!).promptReview, review);
  await assert.rejects(service.controlV4DetailRun(fixture.projectId, fixture.runId, "resume", {}, credentials), /预览并确认/);
  await assert.rejects(service.controlV4DetailRun(fixture.projectId, fixture.runId, "answers", { skip: true }, credentials), /预览并确认/);
  const { assertNoDetailRun } = await import("../lib/detail-runs/lock");
  await assert.rejects(assertNoDetailRun(fixture.projectId, true), /仍在运行/);
  const duplicate = await service.createV4DetailRun(fixture.projectId, fixture.input, credentials);
  assert.equal(duplicate!.id, fixture.runId);
  assert.equal(count("GENERATE"), 0);

  const pages = review.pages.map((page, index) => ({ sectionId: page.sectionId, prompt: index ? page.prompt : "暖白背景，保留杯形。\nExact copy:\n用户确认的中文标题\n" }));
  const save = { revision: review.revision, pages };
  const saved = await service.controlV4DetailRun(fixture.projectId, fixture.runId, "save-prompts", save, {});
  assert.equal(saved!.status, "WAITING_PROMPTS");
  assert.equal(cpOf(saved!).promptReview!.revision, review.revision + 1);
  assert.equal(cpOf(saved!).promptReview!.pages[0].prompt, pages[0].prompt);
  assert.equal((await db.pageSection.findUniqueOrThrow({ where: { id: pages[0].sectionId } })).visualPrompt, pages[0].prompt);
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "save-prompts", save, {}); // A lost save response is safe to replay.
  await assert.rejects(service.controlV4DetailRun(fixture.projectId, fixture.runId, "confirm-prompts", { ...save, confirmationId: randomUUID() }, credentials), /其他页面更新/);
  for (const invalid of [[], pages.slice(1), [...pages].reverse(), pages.map((page, index) => index ? page : { ...page, sectionId: "foreign-page" }), pages.map((page, index) => index ? page : { ...page, prompt: "  " })]) {
    await assert.rejects(service.controlV4DetailRun(fixture.projectId, fixture.runId, "save-prompts", { revision: review.revision + 1, pages: invalid }, {}));
  }
  assert.equal(count("GENERATE"), 0);
  const body = { revision: review.revision + 1, pages, confirmationId: randomUUID() };
  const batch = await db.generationTask.create({ data: { projectId: fixture.projectId, taskType: "BATCH_CREATE", status: "FAILED", errorMessage: "old batch completion", inputPayload: { workflow: "detail-batch-v1" }, outputPayload: { items: [{ projectId: fixture.projectId, runId: fixture.runId, status: "WAITING_PROMPTS", message: "ready" }] } } });
  const { getBatch } = await import("../lib/detail-runs/batch");
  assert.equal((await getBatch(batch.id)).status, "WAITING_PROMPTS");
  assert.equal((await getBatch(batch.id)).error, null);
  await Promise.all([0, 1].map(() => runtime.runWithProviderCredentials(credentials, () => service.controlV4DetailRun(fixture.projectId, fixture.runId, "confirm-prompts", body, credentials))));
  const completed = await settled(fixture.runId, false);
  assert.equal(completed.status, "COMPLETED");
  assert.equal((await getBatch(batch.id)).status, "SUCCESS");
  assert.deepEqual([count("PLAN"), count("ART_DIRECTION"), count("GENERATE")], [1, 1, 7]);
  // Parallel siblings may reach the upstream in either order; every exact prompt must appear once.
  assert.deepEqual(calls.filter(call => call.kind === "GENERATE").map(call => call.body.get("prompt")).sort(), pages.map(page => page.prompt).sort());
  for (const page of pages) {
    const asset = await db.productAsset.findFirstOrThrow({ where: { sectionId: page.sectionId, type: "GENERATED" } });
    assert.equal((asset.metadata as { prompt?: string }).prompt, page.prompt);
  }
  assert.equal(calls.find(call => call.kind === "IMAGE_REVIEW")?.input.approvedPrompt, pages[0].prompt);
  assert.equal(calls.find(call => call.kind === "SET_REVIEW")?.input.approvedPrompts[0].prompt, pages[0].prompt);
  const before = calls.length;
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "confirm-prompts", body, credentials);
  assert.equal(calls.length, before);
  await assert.rejects(service.controlV4DetailRun(fixture.projectId, fixture.runId, "save-prompts", save, credentials), /已经确认/);
});

test("stopping a prompt review preserves its draft; approved prompts survive uncertain image recovery", async () => {
  const fixture = await start();
  let run = await settled(fixture.runId, false);
  const review = cpOf(run).promptReview!;
  const pages = review.pages.map(page => ({ sectionId: page.sectionId, prompt: `${page.prompt}\n用户修改：柔和自然光` }));
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "save-prompts", { revision: review.revision, pages }, {});
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "cancel", {}, {});
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "resume", {}, credentials);
  run = await settled(fixture.runId, false);
  assert.equal(run.status, "WAITING_PROMPTS");
  assert.equal(cpOf(run).promptReview!.pages[0].prompt, pages[0].prompt);
  assert.deepEqual([count("PLAN"), count("ART_DIRECTION"), count("GENERATE")], [1, 1, 0]);
  respond = async call => call.kind === "GENERATE" && call.index === 0 ? new Response("timeout", { status: 504 }) : success(call);
  await approve(run);
  run = await settled(fixture.runId, false);
  assert.equal(run.status, "PARTIAL");
  assert.equal(count("GENERATE"), 7);
  await db.pageSection.update({ where: { id: pages[0].sectionId }, data: { visualPrompt: "stale external value" } });
  respond = success;
  await resume(fixture.projectId, fixture.runId);
  assert.equal(count("GENERATE"), 7);
  await resume(fixture.projectId, fixture.runId, true);
  assert.equal(count("GENERATE"), 8);
  assert.equal(calls.filter(call => call.kind === "GENERATE").at(-1)?.body.get("prompt"), pages[0].prompt);
});

test("prompt approval preserves an existing selected image while generating missing pages", async () => {
  const fixture = await seed({ generated: [0] });
  const original = fixture.checkpoint.images[0].assetId;
  const created = await runtime.runWithProviderCredentials(credentials, () => service.createV4DetailRun(fixture.projectId, { idempotencyKey: randomUUID(), heroCount: 3, detailCount: 4, quality: "low" }, credentials));
  const waiting = await settled(created!.id, false);
  assert.equal(waiting.status, "WAITING_PROMPTS");
  assert.equal(count("GENERATE"), 0);
  await approve(waiting);
  const completed = await settled(created!.id, false);
  assert.equal(completed.status, "COMPLETED");
  assert.equal(cpOf(completed).images[0].assetId, original);
  assert.equal(count("GENERATE"), 6);
});

for (const [heroCount, detailCount] of [[3, 0], [0, 1], [0, 4], [1, 0]]) test(`single-type creation ${heroCount}+${detailCount} preserves zero counts on replay`, async () => {
  const projectId = await project();
  const input = { idempotencyKey: randomUUID(), heroCount, detailCount, mode: "create", quality: "low" };
  const run = await runtime.runWithProviderCredentials(credentials, () => service.createV4DetailRun(projectId, input, credentials));
  const completed = await settled(run!.id);
  assert.equal(completed.status, "COMPLETED");
  assert.equal((completed.input as any).heroCount, heroCount);
  assert.equal((completed.input as any).detailCount, detailCount);
  const sections = await db.pageSection.findMany({ where: { projectId } });
  assert.equal(sections.length, heroCount + detailCount);
  assert.equal(sections.filter(section => section.type === "HERO").length, heroCount);
  assert.ok(sections.every(section => section.currentImageAssetId));
  assert.deepEqual([count("PLAN"), count("ART_DIRECTION"), count("GENERATE"), count("IMAGE_REVIEW"), count("SET_REVIEW")], [1, 1, heroCount + detailCount, heroCount + detailCount, 1]);
  assert.deepEqual(cpOf(completed).contentWarnings, []);
  assert.equal(calls.find(call => call.kind === "PLAN")?.input.requestedHeroCount, heroCount);
  assert.equal(calls.find(call => call.kind === "PLAN")?.input.requestedDetailCount, detailCount);
  const countBefore = calls.length;
  const duplicate = await runtime.runWithProviderCredentials(credentials, () => service.createV4DetailRun(projectId, input, credentials));
  assert.equal(duplicate!.id, run!.id);
  await resume(projectId, run!.id);
  assert.equal(calls.length, countBefore);
});

test("XHS freezes the requested single portrait card, saves post copy and resumes without resubmission", async () => {
  const project = await db.project.create({ data: { name: "XHS acceptance", description: "桌面整理，只生成1张图", platform: "xiaohongshu", style: "generic_clean" } });
  const post = { title: "桌面留白", caption: "收好线材，归位文具，留出工作区。", hashtags: ["桌面整理", "生活", "收纳"], language: "zh-CN" };
  respond = async call => call.kind === "PLAN" ? completion({ ...plan(0, 1), contentCoverage: [], post }) : success(call);
  const input = { mode: "xhs", idempotencyKey: randomUUID(), quality: "low" };
  const run = await runtime.runWithProviderCredentials(credentials, () => service.createV4DetailRun(project.id, input, credentials));
  const completed = await settled(run!.id);
  assert.equal(completed.status, "COMPLETED");
  assert.deepEqual([(completed.input as any).heroCount, (completed.input as any).detailCount], [0, 1]);
  const savedProject = await db.project.findUniqueOrThrow({ where: { id: project.id } });
  assert.deepEqual((savedProject.modelSnapshot as any).socialPost, post);
  assert.deepEqual(cpOf(completed).contentWarnings, []);
  assert.equal(count("GENERATE"), 1);
  const request = calls.find(c => c.kind === "GENERATE")!;
  const [width, height] = request.body.size.split("x").map(Number);
  assert.equal(width / height, 3 / 4);
  const pack = (completed.input as any).xhsPromptPack;
  assert.equal(pack.version, 1);
  assert.equal(pack.brief, project.description);
  const planning = calls.find(call => call.kind === "PLAN")!;
  const direction = calls.find(call => call.kind === "ART_DIRECTION")!;
  assert.match(JSON.stringify(planning.body), /XHS EDITORIAL PLANNING v1/);
  assert.match(JSON.stringify(direction.body), /XHS VISUAL DIRECTOR v1/);
  assert.doesNotMatch(JSON.stringify(direction.body), /你是视觉分镜模型|完整买家信息/);
  assert.equal(direction.input.brief, project.description);
  assert.match(request.body.prompt, /XHS SERIES MASTER v1/);
  assert.match(request.body.prompt, /Series palette: #FFFFFF; #CCCCCC/);
  assert.match(request.body.prompt, /Original copy 0/);
  assert.equal(count("PLAN"), 1);
  assert.equal(count("ART_DIRECTION"), 1);
  const before = calls.length;
  await db.project.update({ where: { id: project.id }, data: { description: "改成8张" } });
  await runtime.runWithProviderCredentials(credentials, () => service.createV4DetailRun(project.id, input, credentials));
  await resume(project.id, run!.id);
  assert.equal(calls.length, before);
  assert.deepEqual((await db.detailRun.findUniqueOrThrow({ where: { id: run!.id } })).input, completed.input);
});

test("XHS defaults and count bounds are resolved locally before model calls", async () => {
  const { xhsImageCount } = await import("../lib/detail-runs/xhs");
  assert.equal(xhsImageCount({}, "做一篇收纳图文"), 5);
  assert.equal(xhsImageCount({}, "只做一张图"), 1);
  assert.equal(xhsImageCount({}, "生成8张图文（共8页，第一张为封面，最后一张为总结）"), 8);
  assert.equal(xhsImageCount({}, "生成八页，第一至第八页按顺序展开，倒数第二页讲风险"), 8);
  assert.equal(xhsImageCount({}, "第一张是封面，第 2 页讲概念，最末一张做总结"), 5);
  assert.equal(xhsImageCount({ heroCount: 1, detailCount: 0 }, "主题"), 1);
  for (const brief of ["9张", "10张", "0张", "做1张或者3张", "8张或者6页", "0页", "九页"]) assert.throws(() => xhsImageCount({}, brief));
  const p = await db.project.create({ data: { name: "Invalid social count", description: "只做10张", platform: "xiaohongshu", style: "generic_clean" } });
  await assert.rejects(runtime.runWithProviderCredentials(credentials, () => service.createV4DetailRun(p.id, { mode: "xhs", idempotencyKey: randomUUID() }, credentials)), /1–8/);
  assert.equal(calls.length, 0);
  assert.equal(await db.detailRun.count({ where: { projectId: p.id } }), 0);
});

test("empty single, batch, planner and Agent requests are rejected before dispatch", async () => {
  const projectId = await project();
  const input = { idempotencyKey: randomUUID(), heroCount: 0, detailCount: 0 };
  await assert.rejects(service.createV4DetailRun(projectId, input, credentials), /不能同时为 0/);
  const { startBatch, batchInputSchema } = await import("../lib/detail-runs/batch");
  await assert.rejects(startBatch({ id: randomUUID(), projectIds: [projectId], options: { heroCount: 0, detailCount: 0 } }, credentials), /不能同时为 0/);
  assert.equal(batchInputSchema.safeParse({ id: randomUUID(), projectIds: [projectId], options: { heroCount: 0, detailCount: 1 } }).success, true);
  const { workspaceTools } = await import("../lib/agent/tools");
  const tool = workspaceTools().find(tool => tool.name === "create_detail_page")!;
  const toolInput = { projectId, mode: "create", instruction: "", heroCount: 0, detailCount: 0 };
  assert.equal((tool.schema as any).safeParse(toolInput).success, false);
  assert.equal((tool.schema as any).safeParse({ ...toolInput, detailCount: 1 }).success, true);
  await assert.rejects(tool.invoke(toolInput));
  const { POST } = await import("../app/api/projects/[id]/plan-sections/route");
  const { NextRequest } = await import("next/server");
  const response = await POST(new NextRequest("http://localhost/api/projects/test/plan-sections", { method: "POST", body: JSON.stringify({ previewConfig: { heroImageCount: 0, detailSectionCount: 0, imageAspectRatio: "3:4", contentLanguage: "zh-CN" } }) }), { params: { id: projectId } });
  assert.equal(response.status, 400);
  assert.equal(await db.detailRun.count({ where: { projectId } }), 0);
  assert.equal(await db.generationTask.count({ where: { projectId } }), 0);
  assert.equal(calls.length, 0);
});

test("saved count patches preserve zeros and cannot jointly clear all output", async () => {
  const projectId = await project();
  const { patchProjectModelSnapshot } = await import("../lib/services/project-model-snapshot-service");
  const { updateProject } = await import("../lib/services/project-service");
  await patchProjectModelSnapshot(projectId, { previewConfig: { heroImageCount: 0, detailSectionCount: 2 } });
  await assert.rejects(updateProject(projectId, { modelSnapshot: { previewConfig: { detailSectionCount: 0 } } }), /不能同时为 0/);
  assert.deepEqual((await db.project.findUniqueOrThrow({ where: { id: projectId } })).modelSnapshot, { previewConfig: { heroImageCount: 0, detailSectionCount: 2 } });
  await patchProjectModelSnapshot(projectId, { previewConfig: { heroImageCount: 3, detailSectionCount: 4 } });
  const changes = await Promise.allSettled([
    patchProjectModelSnapshot(projectId, { previewConfig: { heroImageCount: 0 } }),
    patchProjectModelSnapshot(projectId, { previewConfig: { detailSectionCount: 0 } }),
  ]);
  assert.equal(changes.filter(result => result.status === "fulfilled").length, 1);
  const saved = (await db.project.findUniqueOrThrow({ where: { id: projectId } })).modelSnapshot as any;
  assert.ok(saved.previewConfig.heroImageCount + saved.previewConfig.detailSectionCount > 0);
  assert.equal(calls.length, 0);
});

test("new V4 run sends one plan, storyboard, generation/review per image and set review; completed resume is a no-op", async t => {
  const deadlines = new WeakMap<AbortSignal, number>();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => { const signal = timeout(ms); deadlines.set(signal, ms); return signal; });
  respond = async call => {
    if (call.kind === "PLAN") assert.equal(deadlines.get(call.signal!), 180000, "Planning waits for the complete response beyond the former 60-second cutoff");
    // Either request can reach fetch first; hold both until the pair has started.
    if (call.kind === "GENERATE" && [1, 2].includes(call.index!)) {
      await until(() => [1, 2].every(index => calls.some(other => other.kind === "GENERATE" && other.index === index)));
    }
    return success(call);
  };
  const { projectId, runId, input } = await start();
  const run = await settled(runId);
  assert.equal(run.status, "COMPLETED"); assert.equal(cpOf(run).workflowVersion, 4);
  assert.deepEqual([count("PLAN"), count("ART_DIRECTION"), count("GENERATE"), count("IMAGE_REVIEW"), count("SET_REVIEW")], [1, 1, 7, 7, 1]);
  assert.equal(peak, 2); assert.equal(calls.find(call => call.kind === "GENERATE")?.index, 0);
  assert.ok(cpOf(run).images.every(image => image.assetId && image.state === "checked"));
  assert.ok(cpOf(run).taskTiming?.finishedAt, "Completed timing is persisted with the checkpoint");
  const requestTimings = cpOf(run).requestTimings!;
  assert.equal(Object.keys(requestTimings).length, 17, "Text, seven image generations/reviews and set review each have independent timing");
  for (const timing of Object.values(requestTimings)) {
    assert.ok(timing.finishedAt);
    assert.ok(Date.parse(timing.finishedAt) >= Date.parse(timing.startedAt));
    assert.ok(timing.firstStartedAt);
  }
  const total = calls.length;
  const resumed = await resume(projectId, runId, true);
  assert.deepEqual(cpOf(resumed).requestTimings, requestTimings, "Continuing completed work preserves original image timings");
  await runtime.runWithProviderCredentials(credentials, () => service.createV4DetailRun(projectId, input, credentials));
  assert.equal(calls.length, total);
});

test("explicit schema rejection is not an auth failure, does not loop, and can continue after a fix", async () => {
  const rejection = "Invalid schema for response_format 'mxpage_workflow_result': 'required' must include every key in properties. Missing 'contentCoverage'.";
  respond = async call => call.kind === "PLAN" ? Response.json({ error: { message: rejection } }, { status: 400 }) : success(call);
  const fixture = await start(); const failed = await settled(fixture.runId);
  assert.equal(failed.status, "FAILED");
  assert.equal(cpOf(failed).requests!.PLAN.state, "rejected");
  assert.equal(cpOf(failed).lastError?.code, "PROVIDER_SCHEMA_REJECTED");
  assert.doesNotMatch(failed.error || "", /鉴权失败/);
  assert.equal(count("PLAN"), 1); assert.equal(count("GENERATE"), 0);
  const firstTiming = cpOf(failed).requestTimings!.PLAN;
  assert.ok(firstTiming.finishedAt, "Failed requests save their own elapsed time");
  respond = success;
  const completed = await resume(fixture.projectId, fixture.runId);
  assert.equal(completed.status, "COMPLETED");
  assert.equal(count("PLAN"), 2); assert.equal(count("GENERATE"), 7);
  const resumedTiming = cpOf(completed).requestTimings!.PLAN;
  assert.equal(resumedTiming.firstStartedAt, firstTiming.firstStartedAt);
  assert.equal(resumedTiming.elapsedMs, Date.parse(firstTiming.finishedAt!) - Date.parse(firstTiming.startedAt));
  const countBefore = calls.length; await resume(fixture.projectId, fixture.runId); assert.equal(calls.length, countBefore);
});

function misplacedPlan() {
  const original = plan();
  for (const [index, module] of ["need", "selling_points", "scenarios"].entries()) original.contentCoverage.find(entry => entry.module === module)!.sectionIndexes = [index];
  original.contentCoverage.find(entry => entry.module === "specifications")!.status = "needs_input";
  return original;
}

test("hero-only content is carried into DETAIL locally without extra paid repair or dropped copy", async () => {
  const original = misplacedPlan();
  respond = async call => call.kind === "PLAN" ? completion(original) : success(call);
  const fixture = await start();
  const completed = await settled(fixture.runId);
  assert.equal(completed.status, "COMPLETED");
  assert.deepEqual([count("PLAN"), count("PLAN_CONTENT_REPAIR"), count("ART_DIRECTION"), count("GENERATE")], [1, 0, 1, 7]);
  const savedPlan = cpOf(completed).plan!;
  for (let index = 0; index < 3; index++) {
    assert.equal(savedPlan.sections[index].copy, original.sections[index].copy);
    assert.ok(savedPlan.sections.some(section => section.kind === "DETAIL" && section.copy.includes(original.sections[index].copy)));
  }
  assert.equal(savedPlan.contentCoverage?.find(entry => entry.module === "specifications")?.status, "partial");
  assert.ok(cpOf(completed).contentWarnings?.length);
  assert.equal(cpOf(completed).lastError, undefined);
  const total = calls.length; await resume(fixture.projectId, fixture.runId); assert.equal(calls.length, total);
});

test("legacy coverage failures resume locally without resending an uncertain paid repair", async () => {
  const fixture = await seed({ stage: "PLAN", status: "FAILED" });
  fixture.checkpoint.plan = misplacedPlan() as any;
  fixture.checkpoint.artDirection = undefined;
  fixture.checkpoint.lastError = { stage: "PLAN", code: "WORKFLOW_FAILED", message: "内容覆盖.need：需要落实到详情页", retryable: false };
  fixture.checkpoint.requests = { PLAN: { state: "completed", requestId: "saved-plan" }, PLAN_CONTENT_REPAIR: { state: "uncertain", requestId: "paid-repair" } };
  await saveCheckpoint(fixture.runId, fixture.checkpoint);
  const displayed = await service.getV4DetailRun(fixture.projectId, fixture.runId);
  assert.doesNotMatch(JSON.stringify((displayed?.checkpoint as any).lastError), /内容覆盖\./);
  const completed = await resume(fixture.projectId, fixture.runId);
  assert.equal(completed.status, "COMPLETED");
  assert.deepEqual([count("PLAN"), count("PLAN_CONTENT_REPAIR"), count("ART_DIRECTION"), count("GENERATE")], [0, 0, 1, 7]);
  assert.equal(cpOf(completed).requests!.PLAN_CONTENT_REPAIR.requestId, "paid-repair");
  assert.equal(cpOf(completed).requests!.PLAN_CONTENT_REPAIR.state, "uncertain");
  const total = calls.length; await resume(fixture.projectId, fixture.runId, true); assert.equal(calls.length, total);
});

test("coverage inconsistencies on paid images are advisory and never rewrite or regenerate them", async () => {
  const fixture = await seed({ generated: [0, 1, 2, 3, 4, 5, 6], stage: "PLAN", status: "FAILED" });
  fixture.checkpoint.plan = misplacedPlan() as any;
  const originalCopy = fixture.checkpoint.plan!.sections.map(section => section.copy);
  const assetIds = fixture.checkpoint.images.map(image => image.assetId);
  fixture.checkpoint.contentRepairRequested = true;
  fixture.checkpoint.contentPlacements = { placements: [{ module: "need", detailIndex: 999 }] };
  fixture.checkpoint.requests = { PLAN_CONTENT_REPAIR: { state: "completed", requestId: "old-invalid-placement" } };
  await saveCheckpoint(fixture.runId, fixture.checkpoint);
  const completed = await resume(fixture.projectId, fixture.runId);
  assert.equal(completed.status, "COMPLETED");
  assert.deepEqual([count("PLAN"), count("PLAN_CONTENT_REPAIR"), count("ART_DIRECTION"), count("GENERATE")], [0, 0, 0, 0]);
  assert.deepEqual(cpOf(completed).images.map(image => image.assetId), assetIds);
  assert.deepEqual(cpOf(completed).plan!.sections.map(section => section.copy), originalCopy);
  assert.ok(cpOf(completed).contentWarnings?.some(warning => warning.includes("头图")));
});

test("cosmetic metadata and coverage errors do not cause another model call; parameter loss is repaired locally", async () => {
  const copy = "床头好风景\n尺寸：12×12×10 cm；容量：350 mL。";
  respond = async call => {
    if (call.kind === "PLAN") {
      const p = plan(); p.sections[4].copy = copy; p.sections[4].objective = "内部审查完成后呈现卧室场景";
      return completion({ ...p, contentCoverage: [{ module: "unknown-module", sectionIndexes: "bad-metadata" }] });
    }
    if (call.kind === "ART_DIRECTION") {
      const a = art(call.input.plan);
      a.sections[4].textBlocks[0].text = "卧室一角\n容量：350 g。";
      return completion({ ...a, concept: "卧室", palette: ["#FFFFFF"], typography: "宋体", sections: a.sections.map(s => ({ ...s, textBlocks: s.textBlocks.map(b => ({ ...b, fontSize: null, x: "8%" })) })) });
    }
    return success(call);
  };
  const fixture = await start(); const completed = await settled(fixture.runId);
  assert.equal(completed.status, "COMPLETED");
  assert.deepEqual([count("PLAN"), count("PLAN_CONTENT_REPAIR"), count("ART_DIRECTION"), count("GENERATE")], [1, 0, 1, 7]);
  const blocks = cpOf(completed).artDirection!.sections[4].textBlocks;
  assert.equal(blocks.map(block => block.text).join("\n"), copy);
  assert.ok(blocks.every(block => Number.isFinite(block.fontSize)));
  assert.ok(cpOf(completed).contentWarnings?.some(warning => warning.includes("自动补齐")));
});

test("partially supplied facts normalize locally with no extra request and keep the input gate", async () => {
  const value = plan(); value.contentCoverage.find(entry => entry.module === "specifications")!.status = "needs_input";
  value.missingFields = [{ field: "size", question: "What size?", blocking: true }] as any;
  respond = async call => call.kind === "PLAN" ? completion(value) : success(call);
  const fixture = await start();
  const waiting = await settled(fixture.runId);
  assert.equal(waiting.status, "WAITING_INPUT");
  assert.equal(cpOf(waiting).plan?.contentCoverage?.find(entry => entry.module === "specifications")?.status, "partial");
  assert.equal(count("PLAN_CONTENT_REPAIR"), 0); assert.equal(count("ART_DIRECTION"), 0);
  assert.equal(cpOf(waiting).questions?.[0].text, "What size?");
  const firstRequest = calls.find(call => call.kind === "PLAN")!;
  assert.deepEqual(firstRequest.input.sectionSlots.map((slot: any) => slot.kind), ["HERO", "HERO", "HERO", "DETAIL", "DETAIL", "DETAIL", "DETAIL"]);
});

test("unknown dimensions marked nonblocking still pause before storyboard or paid images", async () => {
  const value = plan();
  value.missingFields = [
    { field: "目标人群、主要用途与实际场景", question: "这款圆柱形蜡烛主要面向什么使用场景？", blocking: false },
    { field: "尺寸与重量参数", question: "可以确认哪些商品尺寸或重量参数？", blocking: false },
    { field: "蜡材、燃烧与使用说明、包装及购买保障信息", question: "可以补充哪些商品信息？", blocking: false },
  ] as any;
  value.sections[6].copy = "尺寸｜待补充\n重量｜待补充";
  respond = async call => call.kind === "PLAN" ? completion(value) : success(call);
  const fixture = await start();
  const waiting = await settled(fixture.runId);
  assert.equal(waiting.status, "WAITING_INPUT");
  assert.equal(cpOf(waiting).answers.length, 0);
  assert.deepEqual(cpOf(waiting).missingFields?.map(field => field.field), value.missingFields.map((field: any) => field.field));
  assert.ok(cpOf(waiting).questions?.some(question => question.fields?.includes("尺寸与重量参数")));
  assert.equal(count("PLAN"), 1); assert.equal(count("INPUT_SUGGESTIONS"), 1);
  assert.equal(count("ART_DIRECTION"), 0); assert.equal(count("GENERATE"), 0);
  const requestsBefore = calls.length;
  await assert.rejects(resume(fixture.projectId, fixture.runId), /请先提交补充信息/);
  assert.equal((await service.getV4DetailRun(fixture.projectId, fixture.runId))?.status, "WAITING_INPUT");
  assert.equal(calls.length, requestsBefore, "Continue cannot bypass unanswered questions or repeat paid requests");
});

test("resuming a saved plan with unconfirmed nonblocking dimensions pauses without replanning", async () => {
  const fixture = await seed({ stage: "PLAN", status: "INTERRUPTED" });
  fixture.checkpoint.artDirection = undefined;
  fixture.checkpoint.plan!.missingFields = [{ field: "size", question: "What size?", blocking: false, options: [] }];
  fixture.checkpoint.requests!.PLAN = { state: "completed", requestId: "saved-plan-request" };
  await saveCheckpoint(fixture.runId, fixture.checkpoint);
  const run = await resume(fixture.projectId, fixture.runId);
  assert.equal(run.status, "WAITING_INPUT");
  assert.equal(cpOf(run).requests!.PLAN.requestId, "saved-plan-request");
  assert.equal(count("PLAN"), 0); assert.equal(count("INPUT_SUGGESTIONS"), 1);
  assert.equal(count("ART_DIRECTION"), 0); assert.equal(count("GENERATE"), 0);
});

test("nonblocking missing dimensions do not rewind existing paid images on resume", async () => {
  const fixture = await seed({ generated: [0, 1, 2, 3, 4, 5, 6], checked: true });
  fixture.checkpoint.plan!.missingFields = [{ field: "size", question: "What size?", blocking: false, options: [] }];
  const assetIds = fixture.checkpoint.images.map(image => image.assetId);
  await saveCheckpoint(fixture.runId, fixture.checkpoint);
  const run = await resume(fixture.projectId, fixture.runId);
  assert.equal(run.status, "COMPLETED");
  assert.deepEqual(cpOf(run).images.map(image => image.assetId), assetIds);
  assert.equal(count("PLAN"), 0); assert.equal(count("INPUT_SUGGESTIONS"), 0);
  assert.equal(count("ART_DIRECTION"), 0); assert.equal(count("GENERATE"), 0);
  assert.equal(count("SET_REVIEW"), 1);
});

async function startQuestionCards() {
  const value = plan();
  value.missingFields = [
    { field: "material", question: "确认杯子的材质", blocking: true, options: ["陶瓷", "玻璃", "不锈钢"] },
    { field: "purpose", question: "优先盛装的饮品", blocking: true, options: ["日常喝茶", "早餐咖啡", "办公室热水"] },
    { field: "scene", question: "优先呈现的场景", blocking: false, options: ["日常茶席", "办公室休息", "礼赠展示"] },
  ] as any;
  // Deliberately repeat missingFields on the second plan: confirmed questions must not loop.
  respond = async call => call.kind === "PLAN" ? completion(value) : success(call);
  const fixture = await start();
  const run = await settled(fixture.runId);
  assert.equal(run.status, "WAITING_INPUT");
  assert.equal(count("PLAN"), 1); assert.equal(count("ART_DIRECTION"), 0); assert.equal(count("GENERATE"), 0);
  assert.equal(count("INPUT_SUGGESTIONS"), 0, "Valid specific choices need no extra model call");
  const questions = normalizeSupplementalQuestions(cpOf(run).questions);
  assert.equal(questions.length, 3);
  const selections = Object.fromEntries(questions.map(question => [question.id, { mode: "option" as const, optionIndex: 0, customText: "STALE_CUSTOM_MUST_NOT_APPEAR" }]));
  return { ...fixture, questions, selections };
}

test("question cards submit only selected answers, preserve custom copy, and continue once without another input loop", async () => {
  const fixture = await startQuestionCards();
  const payload = buildSupplementalSubmission(fixture.questions, { ...fixture.selections, [fixture.questions[1].id]: { mode: "custom", optionIndex: 1, customText: "  实测 280 mL；不标注未经确认的尺寸。  " } })!;
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "answers", payload, credentials);
  const completed = await settled(fixture.runId);
  assert.equal(completed.status, "COMPLETED");
  assert.equal(count("PLAN"), 2); assert.equal(count("ART_DIRECTION"), 1); assert.equal(count("GENERATE"), 7);
  const secondPlan = calls.filter(call => call.kind === "PLAN")[1];
  assert.deepEqual(secondPlan.input.confirmedSupplementalAnswers.map((item: any) => item.answer), ["陶瓷", "实测 280 mL；不标注未经确认的尺寸。", "日常茶席"]);
  assert.deepEqual(secondPlan.input.confirmedSupplementalAnswers.map((item: any) => item.basis), ["model_estimate", "user_provided", "model_estimate"]);
  assert.ok(!JSON.stringify(secondPlan.input).includes("STALE_CUSTOM"));
  assert.ok(!JSON.stringify(secondPlan.input).includes("玻璃"));
  assert.equal(cpOf(completed).questions, undefined);
  assert.ok(calls.find(call => call.kind === "ART_DIRECTION")!.input.plan.missingFields.every((field: any) => field.options.length === 0));
  const requestCount = calls.length;
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "answers", payload, credentials);
  assert.equal(calls.length, requestCount, "A repeated submit cannot regenerate images");
});

test("confirmed estimates keep internal provenance while generation receives clean consumer copy", async () => {
  const fixture = await seed();
  const copy = "容量：约350 mL（模拟数据，非实测）\n尺寸：约8×8×10 cm\n仅供设计参考";
  fixture.checkpoint.confirmedSupplementalAnswers = [{ question: "容量和尺寸", fields: ["capacity", "size"], source: "option", basis: "model_estimate", answer: "容量约350 mL；尺寸约8×8×10 cm" }];
  fixture.checkpoint.plan!.sections.forEach(section => { section.copy = copy; });
  fixture.checkpoint.artDirection!.sections.forEach(section => { section.textBlocks[0].text = copy; });
  fixture.checkpoint.taskTiming = { elapsedMs: 0, startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:05Z", finishedAt: "2026-01-01T00:00:05Z" };
  await db.detailRun.update({ where: { id: fixture.runId }, data: { checkpoint: fixture.checkpoint as any } });
  const result = await resume(fixture.projectId, fixture.runId);
  assert.equal(result.status, "COMPLETED");
  const checkpoint = cpOf(result);
  assert.equal(checkpoint.confirmedSupplementalAnswers![0].basis, "model_estimate");
  assert.equal(checkpoint.taskTiming!.elapsedMs, 5000, "Offline months are not counted on resume");
  assert.ok(checkpoint.taskTiming!.finishedAt);
  assert.equal(count("GENERATE"), 7);
  for (const call of calls.filter(call => call.kind === "GENERATE")) {
    const visible = String(call.body.get("prompt")).split("Exact copy:\n")[1];
    assert.match(visible, /约350 mL/); assert.match(visible, /约8×8×10 cm/);
    assert.doesNotMatch(visible, /模拟数据|非实测|仅供设计参考/);
  }
});

test("vague specification names trigger one concrete estimate request before confirmation", async () => {
  const value = plan();
  value.missingFields = [
    { field: "水箱容量、整机尺寸与净重", question: "规格数据？", blocking: true, options: ["水箱容量、整机尺寸与净重", "水箱容量与尺寸", "尺寸和重量"] },
    { field: "material", question: "材质？", blocking: false, options: ["塑料仿木纹", "实木", "金属"] },
    { field: "scene", question: "场景？", blocking: false, options: ["卧室床头", "客厅边桌", "书房桌面"] },
  ] as any;
  respond = async call => call.kind === "PLAN" ? completion(value) : success(call);
  const fixture = await start();
  const run = await settled(fixture.runId);
  assert.equal(run.status, "WAITING_INPUT");
  assert.equal(count("INPUT_SUGGESTIONS"), 1); assert.equal(count("GENERATE"), 0);
  assert.ok(cpOf(run).questions![0].options!.every(option => /cm/.test(option) && /g/.test(option) && /mL/.test(option)));
  assert.ok(!JSON.stringify(cpOf(run).plan!.facts).includes("约"), "Estimates do not enter facts before user confirmation");
});

test("saved storyboard paraphrases resume unchanged without another planning request or regeneration", async () => {
  const fixture = await seed({ stage: "ART_DIRECTION", status: "FAILED" });
  const copy = "卧室床头的居家摆放\n说明文字，完整保留。\n尺寸约12×12×10 cm；净重约350 g";
  fixture.checkpoint.plan!.sections[4].copy = copy;
  const wrong = "卧室床头居家场景";
  fixture.checkpoint.artDirection!.sections[4] = {
    ...fixture.checkpoint.artDirection!.sections[4], prompt: `Image-4 clear bedroom design, title: ${wrong}`,
    textBlocks: copy.split("\n").map((text, index) => ({ text: index ? text : wrong, role: index ? "body" : "title", x: 7, y: 6 + index * 30, width: 86, fontSize: 20, lineHeight: 1.4, align: "left" })),
  };
  fixture.checkpoint.requests = { PLAN: { state: "completed", requestId: "paid-plan" }, ART_DIRECTION: { state: "completed", requestId: "paid-art" } };
  fixture.checkpoint.lastError = { stage: "ART_DIRECTION", code: "WORKFLOW_FAILED", message: "sections[4].textBlocks omitted title", retryable: false };
  await saveCheckpoint(fixture.runId, fixture.checkpoint);
  const run = await resume(fixture.projectId, fixture.runId);
  assert.equal(run.status, "COMPLETED");
  assert.equal(count("PLAN"), 0); assert.equal(count("ART_DIRECTION"), 0); assert.equal(count("GENERATE"), 7);
  assert.equal(cpOf(run).requests!.ART_DIRECTION.requestId, "paid-art");
  const blocks = cpOf(run).artDirection!.sections[4].textBlocks;
  assert.equal(blocks.map(block => block.text).join("\n"), copy.replace("卧室床头的居家摆放", wrong));
  assert.ok(cpOf(run).contentWarnings?.some(warning => warning.includes("润色")));
  const prompt = String(calls.find(call => call.kind === "GENERATE" && call.index === 4)!.body.get("prompt"));
  assert.ok(prompt.includes(wrong)); assert.ok(prompt.includes("尺寸约12×12×10 cm；净重约350 g"));
  assert.equal(cpOf(run).lastError, undefined);
  const requestsBefore = calls.length;
  await resume(fixture.projectId, fixture.runId);
  assert.equal(calls.length, requestsBefore);
});

test("legacy parameter-name selections require concrete confirmation before any images", async () => {
  const fixture = await seed({ stage: "ART_DIRECTION", status: "FAILED" });
  fixture.checkpoint.plan!.missingFields = [{ field: "水箱容量、整机尺寸与净重", question: "规格数据？", blocking: true, options: [] }];
  fixture.checkpoint.confirmedSupplementalAnswers = [{ question: "规格页可以确认哪些数据？", fields: ["水箱容量、整机尺寸与净重"], source: "option", basis: "model_estimate", answer: "水箱容量、整机尺寸与净重" }];
  fixture.checkpoint.requests = { PLAN: { state: "completed", requestId: "saved-plan" }, ART_DIRECTION: { state: "completed", requestId: "saved-art" } };
  await saveCheckpoint(fixture.runId, fixture.checkpoint);
  const run = await resume(fixture.projectId, fixture.runId);
  assert.equal(run.status, "WAITING_INPUT");
  assert.equal(count("PLAN"), 0); assert.equal(count("ART_DIRECTION"), 0); assert.equal(count("GENERATE"), 0);
  assert.equal(count("INPUT_SUGGESTIONS"), 1);
  assert.equal(cpOf(run).requests!.ART_DIRECTION.requestId, "saved-art");
  assert.ok(cpOf(run).questions![0].options!.every(option => /cm/.test(option) && /g/.test(option) && /mL/.test(option)));
});

test("invalid or stale submissions stay waiting; users can supply uncertainty through custom text", async () => {
  const fixture = await startQuestionCards();
  const valid = buildSupplementalSubmission(fixture.questions, fixture.selections)!;
  for (const payload of [
    { ...valid, questionSetId: "old-dialog" },
    { ...valid, responses: valid.responses.slice(1) },
    { ...valid, responses: [{ questionId: fixture.questions[0].id, mode: "custom", customText: " " }, ...valid.responses.slice(1)] },
  ]) {
    await assert.rejects(service.controlV4DetailRun(fixture.projectId, fixture.runId, "answers", payload, credentials), /请|更新/);
    assert.equal((await db.detailRun.findUniqueOrThrow({ where: { id: fixture.runId } })).status, "WAITING_INPUT");
  }
  assert.equal(count("PLAN"), 1); assert.equal(count("GENERATE"), 0);
  const unknown = buildSupplementalSubmission(fixture.questions, { ...fixture.selections, [fixture.questions[0].id]: { mode: "custom", customText: "不确定，仅使用已有信息" } })!;
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "answers", unknown, credentials);
  assert.equal((await settled(fixture.runId)).status, "COMPLETED");
  assert.equal(count("PLAN"), 2);
  assert.equal(calls.filter(call => call.kind === "PLAN")[1].input.confirmedSupplementalAnswers[0].answer, "不确定，仅使用已有信息");
});

test("generic PLAN options are replaced by one product-aware request, without rewriting the saved plan", async () => {
  const value = plan();
  value.missingFields = [{ field: "purpose", question: "杯子用于什么？", blocking: true, options: ["按现有信息继续", "暂不展示", "仅使用已知信息"] }] as any;
  respond = async call => call.kind === "PLAN" ? completion(value) : success(call);
  const fixture = await start();
  const run = await settled(fixture.runId);
  assert.equal(run.status, "WAITING_INPUT");
  assert.equal(count("PLAN"), 1); assert.equal(count("INPUT_SUGGESTIONS"), 1); assert.equal(count("GENERATE"), 0);
  assert.deepEqual(cpOf(run).plan?.sections, value.sections);
  assert.equal(cpOf(run).questions?.length, 3);
  assert.deepEqual(cpOf(run).questions?.[0].options, ["日常喝茶", "早餐咖啡", "办公室热水"]);
  const request = calls.find(call => call.kind === "INPUT_SUGGESTIONS")!;
  assert.equal(request.input.description, "Brown cup");
  assert.deepEqual(request.input.facts, value.facts);
  assert.equal(request.body.messages[1].content[1].type, "image_url");
  assert.equal(request.body.tools, undefined);
});

test("old waiting tasks upgrade suggestions explicitly and concurrent clicks reuse one request", async () => {
  const fixture = await startQuestionCards();
  const saved = cpOf(await db.detailRun.findUniqueOrThrow({ where: { id: fixture.runId } }));
  saved.questions = saved.questions!.map(({ options, ...question }) => question);
  await saveCheckpoint(fixture.runId, saved);
  const planRequest = saved.requests!.PLAN.requestId;
  await service.getV4DetailRun(fixture.projectId, fixture.runId);
  assert.equal(count("INPUT_SUGGESTIONS"), 0, "A read never starts a paid model request");
  await Promise.all([
    service.controlV4DetailRun(fixture.projectId, fixture.runId, "suggestions", {}, credentials),
    service.controlV4DetailRun(fixture.projectId, fixture.runId, "suggestions", {}, credentials),
  ]);
  const run = await settled(fixture.runId);
  assert.equal(run.status, "WAITING_INPUT");
  assert.equal(count("INPUT_SUGGESTIONS"), 1); assert.equal(count("PLAN"), 1); assert.equal(count("GENERATE"), 0);
  assert.equal(cpOf(run).requests!.PLAN.requestId, planRequest);
  assert.ok(cpOf(run).questions!.every(question => question.options?.length === 3));
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "suggestions", {}, credentials);
  assert.equal(count("INPUT_SUGGESTIONS"), 1);
});

test("saved shared-unit candidates clear stale diagnostics without paid refresh and submit only once", async () => {
  const fixture = await startQuestionCards();
  const saved = cpOf(await db.detailRun.findUniqueOrThrow({ where: { id: fixture.runId } }));
  saved.plan!.missingFields[0] = { field: "尺码与成衣尺寸", question: "成衣胸围、衣长，单位为cm，均为约值。", blocking: true, options: ["S：104/70；M：110/72", "S：108/72；M：114/74", "S：112/74；M：118/76"] };
  saved.questions![0] = { text: saved.plan!.missingFields[0].question, fields: ["尺码与成衣尺寸"], options: saved.plan!.missingFields[0].options, blocking: true, requiresImage: false };
  saved.supplementalQuestionIssue = "旧校验误报：候选缺少尺寸单位";
  saved.requests!.INPUT_SUGGESTIONS = { state: "completed", requestId: "already-paid-suggestions" };
  await saveCheckpoint(fixture.runId, saved);
  const before = await db.detailRun.findUniqueOrThrow({ where: { id: fixture.runId } });
  const read = await service.getV4DetailRun(fixture.projectId, fixture.runId);
  assert.equal(cpOf(read!).supplementalQuestionIssue, undefined);
  assert.deepEqual((await db.detailRun.findUniqueOrThrow({ where: { id: fixture.runId } })).checkpoint, before.checkpoint, "GET does not rewrite history");
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "suggestions", {}, credentials);
  assert.equal(count("INPUT_SUGGESTIONS"), 0); assert.equal(count("PLAN"), 1);
  const questions = normalizeSupplementalQuestions(cpOf(read!).questions);
  const payload = buildSupplementalSubmission(questions, fixture.selections)!;
  assert.ok(payload);
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "answers", payload, credentials);
  const completed = await settled(fixture.runId);
  assert.equal(completed.status, "COMPLETED");
  assert.equal(cpOf(completed).confirmedSupplementalAnswers![0].answer, "S：104/70；M：110/72（单位：cm）");
  assert.equal(cpOf(completed).confirmedSupplementalAnswers![0].basis, "model_estimate");
  assert.equal(count("INPUT_SUGGESTIONS"), 0);
  const requests = calls.length;
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "answers", payload, credentials);
  assert.equal(calls.length, requests);
});

test("suggestion timeout preserves the paid plan and requires explicit uncertain retry", async () => {
  const value = plan(); value.missingFields = [{ field: "purpose", question: "具体用途？", blocking: true }] as any;
  respond = async call => call.kind === "PLAN" ? completion(value) : call.kind === "INPUT_SUGGESTIONS" ? Response.json({ error: { message: "Gateway timeout" } }, { status: 504 }) : success(call);
  const fixture = await start();
  assert.equal((await settled(fixture.runId)).status, "FAILED");
  assert.equal(count("INPUT_SUGGESTIONS"), 1);
  await resume(fixture.projectId, fixture.runId);
  assert.equal(count("INPUT_SUGGESTIONS"), 1); assert.equal(count("PLAN"), 1);
  respond = success;
  const run = await resume(fixture.projectId, fixture.runId, true);
  assert.equal(run.status, "WAITING_INPUT");
  assert.equal(count("INPUT_SUGGESTIONS"), 2); assert.equal(count("PLAN"), 1); assert.equal(count("GENERATE"), 0);
  assert.equal(cpOf(run).lastError, undefined);
});

test("unusable suggested answers pause for an explicit refresh instead of looping or accepting filler", async () => {
  const value = plan(); value.missingFields = [{ field: "purpose", question: "具体用途？", blocking: true }] as any;
  respond = async call => call.kind === "PLAN" ? completion(value) : call.kind === "INPUT_SUGGESTIONS" ? completion({ questions: [0, 1, 2].map(index => ({ text: `用途${index}`, fields: ["purpose"], options: ["按现有信息继续", "暂不展示", "仅使用已知信息"] })) }) : success(call);
  const fixture = await start();
  const run = await settled(fixture.runId);
  assert.equal(run.status, "WAITING_INPUT");
  assert.ok(cpOf(run).supplementalQuestionIssue);
  assert.equal(count("INPUT_SUGGESTIONS"), 1); assert.equal(count("GENERATE"), 0);
  assert.ok(cpOf(run).questions!.every(question => question.options?.length === 0));
  respond = success;
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "suggestions", {}, credentials);
  const refreshed = await settled(fixture.runId);
  assert.equal(refreshed.status, "WAITING_INPUT");
  assert.equal(cpOf(refreshed).supplementalQuestionIssue, undefined);
  assert.equal(count("INPUT_SUGGESTIONS"), 2); assert.equal(count("PLAN"), 1);
});

test("resume reuses saved images, section IDs and successful checks; uncertain images are skipped until one explicit retry", async () => {
  const { projectId, runId, checkpoint } = await seed({ generated: [0, 1, 2], checked: true });
  checkpoint.images[3].state = "generating";
  checkpoint.requests![`GENERATE:${checkpoint.images[3].sectionId}`] = { state: "running", requestId: "interrupted-paid-request" };
  await saveCheckpoint(runId, checkpoint);
  const beforeIds = checkpoint.images.map(image => image.sectionId);
  const run = await resume(projectId, runId);
  assert.equal(run.status, "PARTIAL");
  assert.deepEqual(calls.filter(call => call.kind === "GENERATE").map(call => call.index).sort(), [4, 5, 6]);
  assert.equal(count("PLAN"), 0); assert.equal(count("ART_DIRECTION"), 0); assert.equal(count("IMAGE_REVIEW"), 3);
  assert.deepEqual(cpOf(run).images.map(image => image.sectionId), beforeIds);
  assert.deepEqual(cpOf(run).images.slice(0, 3).map(image => image.assetId), checkpoint.images.slice(0, 3).map(image => image.assetId));
  const before = calls.length;
  await resume(projectId, runId); assert.equal(calls.length, before);
  const completed = await resume(projectId, runId, true);
  assert.equal(completed.status, "COMPLETED");
  assert.equal(count("GENERATE"), 4); assert.equal(count("IMAGE_REVIEW"), 4); assert.equal(count("SET_REVIEW"), 1);
  assert.equal(await db.pageSection.count({ where: { projectId } }), 7);
});

test("a timed-out image is not automatically retried; siblings finish and explicit retry is bounded", async () => {
  const fixture = await seed({ generated: [0, 1, 2], checked: true });
  respond = async call => call.kind === "GENERATE" && call.index === 3 ? Response.json({ error: { message: "Timed out after provider accepted work" } }, { status: 504 }) : success(call);
  const partial = await resume(fixture.projectId, fixture.runId);
  assert.equal(partial.status, "PARTIAL"); assert.equal(cpOf(partial).images.filter(image => image.assetId).length, 6);
  assert.equal(calls.filter(call => call.kind === "GENERATE" && call.index === 3).length, 1);
  await resume(fixture.projectId, fixture.runId);
  assert.equal(count("GENERATE"), 4);
  await resume(fixture.projectId, fixture.runId, true);
  assert.equal(count("GENERATE"), 5);
  await resume(fixture.projectId, fixture.runId, true);
  assert.equal(count("GENERATE"), 5, "One explicit image retry cannot turn into repeated paid requests");
});

test("missing image endpoint stops the batch after its first request and preserves the plan", async () => {
  const fixture = await seed();
  respond = async call => call.kind === "GENERATE" ? Response.json({ error: "Invalid URL" }, { status: 404 }) : success(call);
  const failed = await resume(fixture.projectId, fixture.runId);
  assert.equal(failed.status, "FAILED"); assert.equal(count("GENERATE"), 1);
  assert.equal(count("PLAN"), 0); assert.equal(count("ART_DIRECTION"), 0);
  assert.equal(count("IMAGE_REVIEW"), 0);
  assert.ok(cpOf(failed).plan); assert.ok(cpOf(failed).artDirection);
  assert.match(failed.error!, /images\/edits/);
  assert.doesNotMatch(failed.error!, /Responses/);
});

test("async image checkpoint survives poll failure; resume queries the original task without retry consent", async t => {
  const fixture = await seed({ generated: [1, 2, 3, 4, 5, 6], checked: true });
  const { OpenAICompatibleAdapter } = await import("../lib/ai/adapters/openai-compatible");
  let dispatches = 0, failPoll = true;
  t.mock.method(OpenAICompatibleAdapter.prototype, "generateImageOnce", async (input: import("../lib/ai/provider-client").ImageGenerationRequest) => {
    if (!input.upstreamTask) {
      await input.beforeSubmit?.(); dispatches++;
      await input.onUpstreamTask!({ protocol: "evolink_tasks", id: "saved-upstream-task", status: "pending" });
    } else assert.equal(input.upstreamTask.id, "saved-upstream-task");
    if (failPoll) throw new Error("poll disconnected");
    await input.onUpstreamTask!({ protocol: "evolink_tasks", id: "saved-upstream-task", status: "completed" });
    return { b64Json: png.toString("base64") };
  });
  const partial = await resume(fixture.projectId, fixture.runId);
  const key = `GENERATE:${fixture.checkpoint.images[0].sectionId}`;
  assert.equal(cpOf(partial).requests![key].upstreamTask?.id, "saved-upstream-task");
  const requestId = cpOf(partial).requests![key].requestId;
  await resume(fixture.projectId, fixture.runId, true);
  assert.equal(dispatches, 1, "even retry consent must query a known pending task first");
  failPoll = false;
  const completed = await resume(fixture.projectId, fixture.runId);
  assert.equal(completed.status, "COMPLETED"); assert.equal(dispatches, 1);
  assert.equal(cpOf(completed).attempts[key], 1);
  assert.equal(cpOf(completed).requests![key].requestId, requestId);
  assert.equal(cpOf(completed).images[0].correctionCount, 0);
  assert.equal(count("PLAN"), 0); assert.equal(count("ART_DIRECTION"), 0);
});

test("asset persisted before checkpoint is recovered without another generation", async () => {
  const fixture = await seed({ generated: [1, 2, 3, 4, 5, 6], checked: true, orphan: 0 });
  const run = await resume(fixture.projectId, fixture.runId);
  assert.equal(run.status, "COMPLETED"); assert.equal(count("GENERATE"), 0);
  const image = cpOf(run).images[0];
  assert.ok(image.assetId);
  assert.equal((await db.pageSection.findUniqueOrThrow({ where: { id: image.sectionId } })).currentImageAssetId, image.assetId);
});

for (const phase of ["PLAN", "ART_DIRECTION"] as const) {
  test(`${phase} timeout has one attempt; normal resume does not resend it and explicit retry preserves earlier stages`, async () => {
    respond = async call => call.kind === phase ? Response.json({ error: { message: "Gateway timeout" } }, { status: 504 }) : success(call);
    const fixture = await start();
    const failed = await settled(fixture.runId);
    assert.equal(failed.status, "FAILED"); assert.equal(count(phase), 1);
    assert.equal(cpOf(failed).requests?.[phase].state, "uncertain");
    await resume(fixture.projectId, fixture.runId); assert.equal(count(phase), 1);
    respond = success;
    const result = await resume(fixture.projectId, fixture.runId, true);
    assert.equal(result.status, "COMPLETED"); assert.equal(count(phase), 2);
    if (phase === "ART_DIRECTION") assert.equal(count("PLAN"), 1);
  });
}

test("cancel drains the dispatched hero, blocks immediate resume and does not launch siblings or reviews", async () => {
  const fixture = await seed();
  const gate = deferred();
  respond = async call => { if (call.kind === "GENERATE") await gate.promise; return success(call); };
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "resume", {}, credentials);
  await until(() => count("GENERATE") === 1);
  try {
    const stopped = await service.controlV4DetailRun(fixture.projectId, fixture.runId, "cancel", {}, credentials);
    assert.equal(stopped?.status, "CANCELED"); assert.equal(stopped?.draining, true);
    await assert.rejects(service.controlV4DetailRun(fixture.projectId, fixture.runId, "resume", {}, credentials), /收尾/);
  } finally { gate.resolve(); }
  const canceled = await settled(fixture.runId);
  assert.equal(canceled.status, "CANCELED"); assert.equal(count("GENERATE"), 1); assert.equal(count("IMAGE_REVIEW"), 0);
  assert.ok(cpOf(canceled).images[0].assetId); assert.equal(canceled.leaseToken, null);
  respond = success;
  const result = await resume(fixture.projectId, fixture.runId);
  assert.equal(result.status, "COMPLETED"); assert.equal(count("GENERATE"), 7);
});

test("cancel during two parallel requests saves both and launches no subsequent requests", async () => {
  const fixture = await seed({ generated: [0], checked: true });
  const gate = deferred();
  respond = async call => { if (call.kind === "GENERATE") await gate.promise; return success(call); };
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "resume", {}, credentials);
  await until(() => count("GENERATE") === 2);
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "cancel", {}, credentials);
  gate.resolve();
  const run = await settled(fixture.runId);
  assert.equal(run.status, "CANCELED"); assert.equal(count("GENERATE"), 2); assert.equal(count("IMAGE_REVIEW"), 0);
  assert.equal(cpOf(run).images.filter(image => image.assetId).length, 3);
});

test("cancel during planning preserves its eventual result without starting art direction", async () => {
  const gate = deferred();
  respond = async call => { if (call.kind === "PLAN") await gate.promise; return success(call); };
  const fixture = await start();
  await until(() => count("PLAN") === 1);
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "cancel", {}, credentials);
  gate.resolve();
  const canceled = await settled(fixture.runId);
  assert.equal(canceled.status, "CANCELED"); assert.ok(cpOf(canceled).plan); assert.equal(count("ART_DIRECTION"), 0);
  respond = success;
  const resumed = await resume(fixture.projectId, fixture.runId);
  assert.equal(resumed.status, "COMPLETED"); assert.equal(count("PLAN"), 1);
});

test("review failure marks PARTIAL and never generates a replacement automatically", async () => {
  const fixture = await seed({ generated: [0, 1, 2, 3, 4, 5, 6] });
  respond = async call => call.kind === "IMAGE_REVIEW" ? completion({ passed: false, issues: [{ kind: "copy", severity: "error", message: "Unreadable text" }] }) : success(call);
  const run = await resume(fixture.projectId, fixture.runId);
  assert.equal(run.status, "PARTIAL"); assert.equal(count("GENERATE"), 0); assert.equal(count("IMAGE_REVIEW"), 7);
  const before = calls.length;
  await resume(fixture.projectId, fixture.runId, true);
  assert.equal(calls.length, before, "A review finding is not permission for regeneration or another review");
});

for (const phase of ["IMAGE_REVIEW", "SET_REVIEW"] as const) {
  test(`${phase} timeout remains incomplete, is not silently retried, and explicit retry only repeats that check`, async () => {
    const fixture = await seed({ generated: [0, 1, 2, 3, 4, 5, 6], checked: phase === "SET_REVIEW" });
    let failed = false;
    respond = async call => { if (call.kind === phase && !failed) { failed = true; return Response.json({ error: { message: "Timed out" } }, { status: 504 }); } return success(call); };
    const run = await resume(fixture.projectId, fixture.runId);
    assert.equal(run.status, "PARTIAL"); assert.equal(count("GENERATE"), 0); assert.match(run.stage, /检查未完成/);
    const before = calls.length;
    await resume(fixture.projectId, fixture.runId); assert.equal(calls.length, before);
    respond = success;
    const result = await resume(fixture.projectId, fixture.runId, true);
    assert.equal(result.status, "COMPLETED"); assert.equal(calls.length, before + 1);
    assert.equal(count("GENERATE"), 0);
  });
}

test("sets larger than twelve are fully checked in overlapping groups and completed groups are reused", async () => {
  const fixture = await seed({ total: 15, generated: Array.from({ length: 15 }, (_, i) => i), checked: true });
  respond = async call => call.kind === "SET_REVIEW" && call.input.imageOrder[0].sectionIndex === 11 ? Response.json({ error: { message: "timeout" } }, { status: 504 }) : success(call);
  const partial = await resume(fixture.projectId, fixture.runId);
  assert.equal(partial.status, "PARTIAL"); assert.equal(cpOf(partial).setReview, undefined);
  const groups = calls.filter(call => call.kind === "SET_REVIEW").map(call => call.input.imageOrder.map((image: any) => image.sectionIndex));
  assert.deepEqual(groups, [Array.from({ length: 12 }, (_, i) => i), [11, 12, 13, 14]]);
  await resume(fixture.projectId, fixture.runId); assert.equal(count("SET_REVIEW"), 2);
  respond = success;
  const completed = await resume(fixture.projectId, fixture.runId, true);
  assert.equal(completed.status, "COMPLETED"); assert.equal(count("SET_REVIEW"), 3); assert.equal(count("GENERATE"), 0);
});

test("successful review recovery clears stale timeout errors even when image quality remains PARTIAL", async () => {
  const fixture = await seed({ generated: [0, 1, 2, 3, 4, 5, 6] });
  respond = async call => call.kind === "IMAGE_REVIEW"
    ? completion({ passed: false, issues: [{ kind: "copy", severity: "error", message: "Check product details" }] })
    : call.kind === "SET_REVIEW" ? Response.json({ error: { message: "Timed out" } }, { status: 504 }) : success(call);
  const pending = await resume(fixture.projectId, fixture.runId);
  assert.match(pending.error || "", /超时/);
  const before = calls.length;
  respond = success;
  const recovered = await resume(fixture.projectId, fixture.runId, true);
  assert.equal(recovered.status, "PARTIAL");
  assert.equal(recovered.error, null); assert.equal(cpOf(recovered).lastError, undefined);
  assert.equal(calls.length, before + 1); assert.equal(count("GENERATE"), 0);
  assert.equal(cpOf(recovered).setReview?.passed, true);
  assert.equal(cpOf(recovered).images[0].check?.passed, false);

  // Existing saved runs can contain the old error; reading them must not call the provider.
  const checkpoint = { ...cpOf(recovered), lastError: cpOf(pending).lastError };
  await db.detailRun.update({ where: { id: fixture.runId }, data: { checkpoint: JSON.parse(JSON.stringify(checkpoint)), error: pending.error } });
  const displayed = await service.getV4DetailRun(fixture.projectId, fixture.runId);
  assert.equal(displayed?.error, null); assert.equal(cpOf(displayed!).lastError, undefined);
  assert.equal(displayed?.status, "PARTIAL"); assert.equal(calls.length, before + 1);
});

test("simultaneous resume requests share one worker and never duplicate image dispatch", async () => {
  const fixture = await seed();
  await Promise.all([service.controlV4DetailRun(fixture.projectId, fixture.runId, "resume", {}, credentials), service.controlV4DetailRun(fixture.projectId, fixture.runId, "resume", {}, credentials)]);
  const run = await settled(fixture.runId);
  assert.equal(run.status, "COMPLETED"); assert.equal(count("GENERATE"), 7);
  assert.equal(new Set(calls.filter(call => call.kind === "GENERATE").map(call => call.index)).size, 7);
});

test("different idempotency keys cannot create simultaneous workflows for one project", async () => {
  const projectId = await project(), gate = deferred();
  respond = async call => { if (call.kind === "PLAN") await gate.promise; return success(call); };
  let results: PromiseSettledResult<Awaited<ReturnType<typeof service.createV4DetailRun>>>[] = [];
  try {
    results = await Promise.allSettled([0, 1].map(() => runtime.runWithProviderCredentials(credentials, () => service.createV4DetailRun(projectId, { idempotencyKey: randomUUID(), heroCount: 3, detailCount: 4, quality: "low" }, credentials))));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(await db.detailRun.count({ where: { projectId } }), 1);
  } finally { gate.resolve(); }
  const winner = results.find(r => r.status === "fulfilled");
  if (winner?.status === "fulfilled") assert.equal((await settled(winner.value!.id)).status, "COMPLETED");
  assert.equal(count("PLAN"), 1); assert.equal(count("GENERATE"), 7);
});

test("heartbeat keeps a long-running request alive beyond its original lease", async t => {
  const fixture = await seed();
  const gate = deferred();
  respond = async call => { if (call.kind === "GENERATE" && call.index === 0) await gate.promise; return success(call); };
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  try {
    await service.controlV4DetailRun(fixture.projectId, fixture.runId, "resume", {}, credentials);
    await until(() => count("GENERATE") === 1);
    const initial = await db.detailRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    for (let i = 0; i < 6; i++) {
      t.mock.timers.tick(leases.RUN_HEARTBEAT_MS);
      await until(async () => (await db.detailRun.findUniqueOrThrow({ where: { id: fixture.runId } })).leaseUntil!.getTime() >= Date.now() + leases.RUN_LEASE_MS - 100);
      assert.equal((await service.getV4DetailRun(fixture.projectId, fixture.runId))?.status, "RUNNING");
    }
    assert.ok(Date.now() > initial.leaseUntil!.getTime());
  } finally { gate.resolve(); t.mock.timers.reset(); }
  assert.equal((await settled(fixture.runId)).status, "COMPLETED");
});

test("an old worker cannot overwrite checkpoint, status or selected image after losing its lease", async () => {
  const fixture = await seed();
  const gate = deferred();
  respond = async call => { if (call.kind === "GENERATE") await gate.promise; return success(call); };
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "resume", {}, credentials);
  await until(() => count("GENERATE") === 1);
  const checkpoint = (await db.detailRun.findUniqueOrThrow({ where: { id: fixture.runId } })).checkpoint;
  await db.detailRun.update({ where: { id: fixture.runId }, data: { status: "INTERRUPTED", stage: "new-owner-sentinel", leaseToken: "different-owner", leaseUntil: new Date(Date.now() + 60_000) } });
  gate.resolve();
  const run = await settled(fixture.runId);
  assert.equal(run.status, "INTERRUPTED"); assert.equal(run.stage, "new-owner-sentinel"); assert.equal(run.leaseToken, "different-owner");
  assert.deepEqual(run.checkpoint, checkpoint); assert.equal(count("GENERATE"), 1);
  assert.equal((await db.pageSection.findUniqueOrThrow({ where: { id: fixture.checkpoint.images[0].sectionId } })).currentImageAssetId, null);
});

test("expired execution becomes interrupted and old workflow records cannot enter V4", async () => {
  const fixture = await seed({ status: "RUNNING" });
  await db.detailRun.update({ where: { id: fixture.runId }, data: { leaseUntil: new Date(Date.now() - 1), leaseToken: "dead-worker" } });
  assert.equal((await service.getV4DetailRun(fixture.projectId, fixture.runId))?.status, "INTERRUPTED");
  await db.detailRun.update({ where: { id: fixture.runId }, data: { checkpoint: { workflowVersion: 3 } } });
  await assert.rejects(service.controlV4DetailRun(fixture.projectId, fixture.runId, "resume", {}, credentials), /历史任务/);
  assert.equal(calls.length, 0);
});

test("changing the selected image invalidates completed quality status without another provider request", async () => {
  const { projectId, runId } = await start();
  const run = await settled(runId);
  const image = cpOf(run).images[0];
  const replacement = await storage.saveGeneratedImage({ projectId, sectionId: image.sectionId, prompt: "Manual replacement", source: { b64Json: png.toString("base64") } });
  await db.pageSection.update({ where: { id: image.sectionId }, data: { currentImageAssetId: replacement.id } });
  const total = calls.length;
  assert.equal((await service.getV4DetailRun(projectId, runId))?.status, "PARTIAL");
  assert.equal(calls.length, total);
});

test("historical V4 completion without a set review is corrected without sending any requests", async () => {
  const fixture = await seed({ generated: [0, 1, 2, 3, 4, 5, 6], checked: true, status: "COMPLETED", stage: "SET_REVIEW" });
  fixture.checkpoint.lastError = { stage: "SET_REVIEW", code: "TIMEOUT", message: "Old request timed out", retryable: true };
  delete fixture.checkpoint.requests;
  await saveCheckpoint(fixture.runId, fixture.checkpoint);
  const visible = await service.getV4DetailRun(fixture.projectId, fixture.runId);
  assert.equal(visible?.status, "PARTIAL"); assert.match(visible!.stage, /检查未完成/);
  await resume(fixture.projectId, fixture.runId);
  assert.equal(calls.length, 0, "Legacy timeout is not permission to repeat a paid request");
  const result = await resume(fixture.projectId, fixture.runId, true);
  assert.equal(result.status, "COMPLETED"); assert.equal(count("SET_REVIEW"), 1); assert.equal(count("GENERATE"), 0);
});

test("network disconnects and malformed model responses are not automatically repeated", async () => {
  respond = async call => { if (call.kind === "PLAN") throw new TypeError("fetch failed after dispatch"); return success(call); };
  const disconnected = await start();
  assert.equal((await settled(disconnected.runId)).status, "FAILED"); assert.equal(count("PLAN"), 1);
  await resume(disconnected.projectId, disconnected.runId); assert.equal(count("PLAN"), 1);
  respond = async call => call.kind === "PLAN" ? Response.json({ choices: [{ message: { content: "{broken-json" } }] }) : success(call);
  const malformed = await start();
  assert.equal((await settled(malformed.runId)).status, "FAILED"); assert.equal(count("PLAN"), 2);
  await resume(malformed.projectId, malformed.runId); assert.equal(count("PLAN"), 2);
  assert.equal(count("GENERATE"), 0);
});

test("stopping during image review preserves the response and leaves the next check unstarted", async () => {
  const fixture = await seed({ generated: [0, 1, 2, 3, 4, 5, 6] });
  const gate = deferred();
  respond = async call => { if (call.kind === "IMAGE_REVIEW") await gate.promise; return success(call); };
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "resume", {}, credentials);
  await until(() => count("IMAGE_REVIEW") === 1);
  await service.controlV4DetailRun(fixture.projectId, fixture.runId, "cancel", {}, credentials);
  gate.resolve();
  const canceled = await settled(fixture.runId);
  assert.equal(canceled.status, "CANCELED"); assert.equal(count("IMAGE_REVIEW"), 1); assert.equal(count("SET_REVIEW"), 0);
  assert.equal(cpOf(canceled).images.filter(image => image.check).length, 1);
  respond = success;
  assert.equal((await resume(fixture.projectId, fixture.runId)).status, "COMPLETED");
  assert.equal(count("IMAGE_REVIEW"), 7); assert.equal(count("GENERATE"), 0);
});

test("a completed group checkpoint aggregates on resume without another model call", async () => {
  const fixture = await seed({ generated: [0, 1, 2, 3, 4, 5, 6], checked: true });
  const assetIds = fixture.checkpoint.images.map(image => image.assetId!);
  fixture.checkpoint.setReviewGroups = { "SET_REVIEW:0": { assetIds, result: { passed: true, issues: [] } } };
  fixture.checkpoint.requests!["SET_REVIEW:0"] = { state: "completed", requestId: "saved-review" };
  await saveCheckpoint(fixture.runId, fixture.checkpoint);
  const result = await resume(fixture.projectId, fixture.runId);
  assert.equal(result.status, "COMPLETED"); assert.equal(calls.length, 0);
  assert.deepEqual(cpOf(result).setReviewAssetIds, assetIds);
});

test("downloading an image result has an abort signal and never falls back to re-generation", async t => {
  const fixture = await seed();
  let downloads = 0;
  t.mock.method(globalThis, "fetch", (async (_url: unknown, init: RequestInit) => {
    downloads++; assert.ok(init.signal instanceof AbortSignal);
    throw new DOMException("Download timed out", "TimeoutError");
  }) as any);
  await assert.rejects(storage.saveGeneratedImage({ projectId: fixture.projectId, sectionId: fixture.checkpoint.images[0].sectionId, prompt: "Test", source: { url: "https://workflow.test/result.png" } }), /timed out/);
  assert.equal(downloads, 1); assert.equal(count("GENERATE"), 0);
  assert.equal(await db.productAsset.count({ where: { projectId: fixture.projectId, type: "GENERATED" } }), 0);
});

test("single-attempt image generation never falls back to another endpoint on an ambiguous server error", async () => {
  const { OpenAICompatibleAdapter } = await import("../lib/ai/adapters/openai-compatible");
  const mockFetch = globalThis.fetch;
  const endpoints: string[] = [];
  globalThis.fetch = async (url, init) => { endpoints.push(String(url)); return mockFetch(url, init); };
  respond = async () => Response.json({ error: { message: "upstream route not found after timeout" } }, { status: 504 });
  try {
    const adapter = new OpenAICompatibleAdapter("https://workflow.test", credentials.apiKey);
    await assert.rejects(adapter.generateImageOnce({ model: "gpt-image-2.5-flare", prompt: "Image-0 original cup", quality: "low", referenceImages: [`data:image/png;base64,${png.toString("base64")}`] }), /Image request failed/);
    assert.deepEqual(endpoints, ["https://workflow.test/v1/images/edits"]);
  } finally { globalThis.fetch = mockFetch; }
});

test("stale group results cannot mark changed images as reviewed after the new check times out", async () => {
  const fixture = await seed({ generated: [0, 1, 2, 3, 4, 5, 6], checked: true });
  fixture.checkpoint.setReviewGroups = { "SET_REVIEW:0": { assetIds: ["superseded-image"], result: { passed: true, issues: [] } } };
  fixture.checkpoint.requests!["SET_REVIEW:0"] = { state: "completed", requestId: "old-review" };
  await saveCheckpoint(fixture.runId, fixture.checkpoint);
  respond = async () => Response.json({ error: { message: "timeout" } }, { status: 504 });
  const run = await resume(fixture.projectId, fixture.runId);
  assert.equal(run.status, "PARTIAL"); assert.equal(cpOf(run).setReview, undefined);
  assert.equal(count("GENERATE"), 0); assert.equal(count("SET_REVIEW"), 1);
  await resume(fixture.projectId, fixture.runId);
  assert.equal(count("SET_REVIEW"), 1);
});

test("existing workflow retains A and chat after settings change; new workflow uses B and Responses for every role", async () => {
  const { saveProviderDefaults } = await import("../lib/services/provider-defaults");
  const provider = await db.providerConfig.findFirstOrThrow({ where: { isActive: true } });
  await db.modelProfile.createMany({ data: ["text-B", "vision-B", "image-B"].map(modelId => ({ providerConfigId: provider.id, modelId, label: modelId, capabilities: { text: true, vision: true, image_gen: true, image_edit: true }, roles: {} })) });
  respond = async call => call.kind === "PLAN" ? new Response("timeout", { status: 504 }) : success(call);
  const first = await start(); await settled(first.runId);
  await saveProviderDefaults(provider.id, { planningModelId: "text-B", analysisModelId: "vision-B", heroImageModelId: "image-B", detailImageModelId: "image-B", imageEditModelId: "image-B", textProtocol: "responses" });
  calls = []; respond = success;
  try {
    const resumed = await resume(first.projectId, first.runId, true);
    assert.equal(resumed.status, "COMPLETED");
    assert.ok(calls.filter(c => c.kind !== "GENERATE").every(c => c.body.model === "gpt-6-luna" && c.url.endsWith("/chat/completions")));
    assert.ok(calls.filter(c => c.kind === "GENERATE").every(c => c.body.get("model") === "gpt-image-2.5-flare"));
    calls = [];
    const next = await start(); const complete = await settled(next.runId);
    assert.equal(complete.status, "COMPLETED");
    for (const call of calls) {
      if (call.kind === "GENERATE") assert.equal(call.body.get("model"), "image-B");
      else {
        assert.ok(call.url.endsWith("/responses"));
        assert.equal(call.body.model, ["IMAGE_REVIEW", "SET_REVIEW"].includes(call.kind) ? "vision-B" : "text-B");
      }
    }
    const countBefore = calls.length;
    await runtime.runWithProviderCredentials(credentials, () => service.createV4DetailRun(next.projectId, next.input, credentials));
    assert.equal(calls.length, countBefore);
  } finally {
    await saveProviderDefaults(provider.id, { planningModelId: "gpt-6-luna", analysisModelId: "gpt-6-luna", heroImageModelId: "gpt-image-2.5-flare", detailImageModelId: "gpt-image-2.5-flare", imageEditModelId: "gpt-image-2.5-flare", textProtocol: "chat_completions" });
  }
});
