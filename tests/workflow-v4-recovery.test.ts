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
type Call = { kind: "PLAN" | "PLAN_CONTENT_REPAIR" | "INPUT_SUGGESTIONS" | "ART_DIRECTION" | "GENERATE" | "IMAGE_REVIEW" | "SET_REVIEW"; input: any; index?: number; body: any; url: string };
let calls: Call[] = [];
let respond: (call: Call) => Promise<Response>;
let inFlight = 0, peak = 0;
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 800; i++) { if (await check()) return; await pause(); }
  throw new Error("V4 test did not settle");
}
async function settled(id: string) {
  await until(async () => {
    const run = await db.detailRun.findUniqueOrThrow({ where: { id } });
    return !["RUNNING", "PENDING"].includes(run.status) && !(globalThis as any).detailV4Workers?.has(id);
  });
  return db.detailRun.findUniqueOrThrow({ where: { id } });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function plan(heroes = 3, details = 4) {
  return { productName: "Tea cup", category: "Home", facts: ["Brown cup"], requirements: [], missingFields: [],
    contentCoverage: ["need", "selling_points", "scenarios", "details", "specifications", "trust", "usage", "closing"].map(module => ({ module, status: "covered", sectionIndexes: [heroes], reason: "Confirmed copy" })),
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
    { modelId: "gpt-6-luna", label: "Luna", capabilities: { text: true, structured_output: true }, roles: {}, isDefaultPlanning: true },
    { modelId: "gpt-image-2.5-flare", label: "Flare", capabilities: { image_edit: true }, roles: {}, isDefaultDetailImage: true, isDefaultImageEdit: true },
  ] } } });
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith(credentials.baseUrl), "Never contact a live provider");
    let call: Call;
    if (init?.body instanceof FormData) {
      const body = init.body;
      assert.equal(body.get("model"), "gpt-image-2.5-flare"); assert.equal(body.get("quality"), "low");
      call = { kind: "GENERATE", index: Number(String(body.get("prompt")).match(/Image-(\d+)/)?.[1]), input: null, body, url: String(url) };
    } else {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "gpt-6-luna"); assert.equal(body.tools, undefined); assert.equal(body.response_format.type, "json_schema");
      assertStrictResponseSchema(body.response_format.json_schema.schema);
      const system = body.messages[0].content;
      const kind = system.includes("商品补充候选模型") ? "INPUT_SUGGESTIONS" : system.includes("内容安排修复模型") ? "PLAN_CONTENT_REPAIR" : system.includes("商品规划模型") ? "PLAN" : system.includes("视觉分镜模型") ? "ART_DIRECTION" : system.includes("整套页面检查模型") ? "SET_REVIEW" : "IMAGE_REVIEW";
      call = { kind, input: JSON.parse(body.messages[1].content[0].text), body, url: String(url) };
    }
    calls.push(call);
    if (call.kind === "GENERATE") { inFlight++; peak = Math.max(peak, inFlight); }
    try { return await respond(call); } finally { if (call.kind === "GENERATE") inFlight--; }
  };
});
beforeEach(() => { calls = []; peak = 0; respond = success; });
after(async () => {
  globalThis.fetch = originalFetch;
  await db?.$disconnect();
  if (directory && path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith("mxpage-v4-recovery-test-")) await rm(directory, { recursive: true, force: true });
});

test("new V4 run sends one plan, storyboard, generation/review per image and set review; completed resume is a no-op", async () => {
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
