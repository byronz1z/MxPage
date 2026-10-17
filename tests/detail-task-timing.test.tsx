import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailTaskTiming } from "../components/editor/detail-task-timing";
import { detailTimingRows, runTimingHistory, type DetailTimingRun } from "../lib/detail-runs/timing";
import { startTiming, touchTiming } from "../lib/tasks/timing";

const epoch = Date.parse("2026-10-17T00:00:00Z");
const stamp = (ms: number) => new Date(epoch + ms).toISOString();
const sections = [{ id: "hero", title: "产品全貌", type: "HERO" }, { id: "detail", title: "材质与细节", type: "CUSTOM" }];
function fixture(): DetailTimingRun {
  return { id: "run", status: "RUNNING", createdAt: stamp(0), updatedAt: stamp(1000), checkpoint: {
    images: sections.map(section => ({ sectionId: section.id, title: section.title, state: "generating" })),
    requests: { PLAN: { state: "completed" }, "GENERATE:hero": { state: "running" }, "GENERATE:detail": { state: "running" } },
    requestTimings: {
      PLAN: touchTiming(startTiming(undefined, epoch), true, epoch + 2000),
      "GENERATE:hero": touchTiming(startTiming(undefined, epoch + 3000), false, epoch + 7000),
      "GENERATE:detail": touchTiming(startTiming(undefined, epoch + 5000), false, epoch + 7000),
    },
  } };
}

test("parallel images have their own live clocks; completed text stays frozen", () => {
  const rows = detailTimingRows(fixture(), sections, epoch + 9000);
  assert.equal(rows.find(row => row.key === "PLAN")?.duration?.elapsedMs, 2000);
  assert.equal(rows.find(row => row.key === "GENERATE:hero")?.duration?.elapsedMs, 6000);
  assert.equal(rows.find(row => row.key === "GENERATE:detail")?.duration?.elapsedMs, 4000);
  assert.equal(rows.find(row => row.key === "GENERATE:detail")?.state, "running");
  assert.equal(rows.find(row => row.key === "GENERATE:hero")?.label, "头图 1 · 产品全貌");
  assert.equal(rows.find(row => row.key === "GENERATE:detail")?.label, "详情 1 · 材质与细节");
});

test("interrupted requests freeze at the checkpoint instead of counting offline time", () => {
  const run = fixture(); run.status = "INTERRUPTED";
  const row = detailTimingRows(run, sections, epoch + 86400000).find(row => row.key === "GENERATE:hero")!;
  assert.equal(row.duration?.elapsedMs, 4000);
  assert.equal(row.duration?.timerStartedAt, undefined);
  assert.equal(row.duration?.timingEstimated, true);
  assert.equal(row.state, "uncertain");
  run.status = "CANCELED"; run.draining = true;
  assert.equal(detailTimingRows(run, sections, epoch + 9000).find(row => row.key === "GENERATE:hero")?.duration?.elapsedMs, 6000);
});

test("legacy logs match both project and run and expose only safe timing data", () => {
  const entry = { projectId: "project", runId: "run", sectionId: "hero", operation: "v4_image_generation", durationMs: 12345, timestamp: stamp(3000), credentialFingerprint: "private" };
  const history = runTimingHistory([entry, { ...entry, runId: "other" }, { ...entry, projectId: "other" }, { ...entry, runId: null }, { ...entry, sectionId: null }], "project", "run");
  assert.deepEqual(history, [{ key: "GENERATE:hero", durationMs: 12345, finishedAt: stamp(3000) }]);
  const run = fixture(); run.checkpoint.requestTimings = {}; run.timingHistory = history; run.status = "COMPLETED";
  run.checkpoint.images.forEach(image => { image.assetId = `asset-${image.sectionId}`; });
  const rows = detailTimingRows(run, sections);
  assert.equal(rows.find(row => row.key === "GENERATE:hero")?.duration?.elapsedMs, 12345);
  assert.equal(rows.find(row => row.key === "GENERATE:detail")?.duration, undefined, "Missing per-image duration must never be inferred by splitting totals");
});

test("logs supplement only pre-instrumentation requests, never double-count saved timings or retries", () => {
  const run = fixture();
  run.checkpoint.requestTimings!.PLAN = { ...touchTiming(startTiming(undefined, epoch + 5000), true, epoch + 8000), firstStartedAt: stamp(5000) };
  run.timingHistory = [{ key: "PLAN", durationMs: 1000, finishedAt: stamp(2000) }, { key: "PLAN", durationMs: 2500, finishedAt: stamp(7900) }];
  assert.equal(detailTimingRows(run, sections).find(row => row.key === "PLAN")?.duration?.elapsedMs, 4000);
  const previous = run.checkpoint.requestTimings!.PLAN;
  run.checkpoint.requestTimings!.PLAN = { ...touchTiming(startTiming(previous, epoch + 100000), true, epoch + 102000), firstStartedAt: previous.firstStartedAt };
  assert.equal(detailTimingRows(run, sections).find(row => row.key === "PLAN")?.duration?.elapsedMs, 6000);
});

test("the timing card lists text and every image, with reviews separate and unknown times explicit", () => {
  const run = fixture(); run.status = "COMPLETED"; run.checkpoint.requestTimings = {}; run.checkpoint.requests = {};
  run.checkpoint.plan = {}; run.checkpoint.artDirection = {};
  run.checkpoint.images.forEach(image => { image.assetId = `asset-${image.sectionId}`; });
  const html = renderToStaticMarkup(<DetailTaskTiming run={run} sections={sections}/>);
  for (const text of ["任务耗时", "文本处理", "商品规划与文案", "视觉分镜与提示词", "产品全貌", "材质与细节", "质量检查耗时", "未记录"]) assert.ok(html.includes(text), text);
  assert.ok(html.indexOf("文本处理") < html.indexOf("图片生成"));
  assert.ok(html.indexOf("图片生成") < html.indexOf("质量检查耗时"));
});
