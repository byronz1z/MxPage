import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import { listProjectHistory } from "../lib/services/project-history-service";
import { historyHref, historyPageNumbers, parseHistoryQuery } from "../lib/utils/project-history";

let directory: string;
let db: PrismaClient;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mxpage-history-test-"));
  const filename = path.join(directory, "history.db");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const sqlite = new DatabaseSync(filename);
  const migrations = path.resolve("prisma/migrations");
  try {
    for (const folder of (await readdir(migrations, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      sqlite.exec(await readFile(path.join(migrations, folder.name, "migration.sql"), "utf8"));
    }
  } finally { sqlite.close(); }
  db = new PrismaClient({ datasourceUrl: `file:${filename.replaceAll("\\", "/")}` });
  const common = { name: "翻译只是商品名称", platform: "general_ecommerce", style: "generic_clean", updatedAt: new Date("2026-10-01") };
  await db.project.createMany({ data: [
    ...Array.from({ length: 13 }, (_, i) => ({ ...common, id: `detail-${String(i + 1).padStart(2, "0")}`, ...(i === 0 ? { modelSnapshot: { translationReady: false } } : {}) })),
    ...Array.from({ length: 13 }, (_, i) => ({ ...common, id: `xhs-${i}`, platform: "xiaohongshu" })),
    ...Array.from({ length: 9 }, (_, i) => ({ ...common, id: `translated-${i}`, platform: "xiaohongshu", modelSnapshot: { translationReady: true } })),
    { ...common, id: "translation-interrupted" },
    { ...common, id: "draft-marker", modelSnapshot: { workType: "translation" } },
    { ...common, id: "run-marker" },
    { ...common, id: "legacy-marker" },
    { ...common, id: "system", platform: "__mxpage_system_task__", modelSnapshot: { translationReady: true } },
  ] });
  await db.detailRun.create({ data: { projectId: "run-marker", idempotencyKey: "test", input: { mode: "translate" }, checkpoint: {} } });
  await db.generationTask.create({ data: { projectId: "legacy-marker", taskType: "TRANSLATE_PAGE" } });
  await db.productAsset.create({ data: { projectId: "detail-13", type: "MAIN", filePath: "storage/history-cover.png", fileName: "history-cover.png" } });
  await db.pageSection.create({ data: { projectId: "detail-13", sectionKey: "hero", type: "HERO", title: "Hero", goal: "", copy: "", visualPrompt: "", order: 0 } });
});
after(async () => {
  await db?.$disconnect();
  if (directory && path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith("mxpage-history-test-")) await rm(directory, { recursive: true, force: true });
});

test("categories are disjoint, translation takes precedence over platform, and system records are excluded", async () => {
  const all = await listProjectHistory({}, db);
  assert.deepEqual(all.counts, { all: 39, detail: 13, xiaohongshu: 13, translation: 13 });
  for (const category of ["detail", "xiaohongshu", "translation"] as const) {
    const first = await listProjectHistory({ category }, db);
    const second = await listProjectHistory({ category, page: "2" }, db);
    assert.equal(first.projects.length, 12);
    assert.equal(second.projects.length, 1);
    assert.ok([...first.projects, ...second.projects].every(project => project.category === category));
    assert.equal(new Set([...first.projects, ...second.projects].map(project => project.id)).size, 13);
    if (category === "translation") {
      const ids = [...first.projects, ...second.projects].map(project => project.id);
      for (const id of ["run-marker", "legacy-marker", "translation-interrupted", "draft-marker", "translated-0"]) assert.ok(ids.includes(id));
    }
  }
  const detail = await listProjectHistory({ category: "detail" }, db);
  assert.equal(detail.projects[0].id, "detail-13");
  assert.equal(detail.projects[0].sectionCount, 1);
  assert.ok(detail.projects[0].coverImageUrl?.endsWith("history-cover.png"));
  assert.equal("modelSnapshot" in detail.projects[0], false);
});

test("all pages are bounded and stable even with equal update timestamps", async () => {
  const ids: string[] = [];
  for (let page = 1; page <= 4; page++) {
    const result = await listProjectHistory({ page: String(page) }, db);
    assert.equal(result.page, page);
    assert.equal(result.projects.length, page === 4 ? 3 : 12);
    ids.push(...result.projects.map(project => project.id));
  }
  assert.equal(new Set(ids).size, 39);
  assert.ok(!ids.includes("system"));
});

test("out-of-range pages and deletion of the final page item recover to a populated page", async () => {
  const last = await listProjectHistory({ category: "detail", page: "999" }, db);
  assert.equal(last.page, 2);
  assert.equal(last.projects[0].id, "detail-01");
  await db.project.delete({ where: { id: "detail-01" } });
  const afterDelete = await listProjectHistory({ category: "detail", page: "2" }, db);
  assert.equal(afterDelete.page, 1);
  assert.equal(afterDelete.totalPages, 1);
  assert.equal(afterDelete.projects.length, 12);
  assert.equal(afterDelete.counts.all, 38);
});

test("empty categories retain pagination metadata and all category counts", async () => {
  await db.project.deleteMany({ where: { id: { startsWith: "xhs-" } } });
  const empty = await listProjectHistory({ category: "xiaohongshu", page: "2" }, db);
  assert.equal(empty.page, 1);
  assert.equal(empty.totalPages, 1);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.projects, []);
  assert.equal(empty.counts.translation, 13);
});

test("query parsing, category reset links and bounded page navigation", () => {
  for (const page of ["-1", "0", "NaN", "2.5", "1e2", "99999999999999999999", ["2", "3"]]) {
    assert.deepEqual(parseHistoryQuery({ category: "invalid", page }), { category: "all", page: 1 });
  }
  assert.deepEqual(parseHistoryQuery({ category: "translation", page: "2" }), { category: "translation", page: 2 });
  assert.equal(historyHref("translation"), "/history?category=translation");
  assert.equal(historyHref("translation", 2), "/history?category=translation&page=2");
  assert.equal(historyHref("all"), "/history");
  assert.deepEqual(historyPageNumbers(1, 1), [1]);
  assert.deepEqual(historyPageNumbers(2, 4), [1, 2, 3, 4]);
  assert.deepEqual(historyPageNumbers(8, 20), [1, "ellipsis", 7, 8, 9, "ellipsis", 20]);
});
