import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

let directory: string;
let db: typeof import("../lib/db/prisma").prisma;
let history: typeof import("../lib/services/project-history-service");
let projects: typeof import("../lib/services/project-service");

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "mxpage-visibility-test-"));
  const filename = path.join(directory, "test.db");
  process.env.DATABASE_URL = `file:${filename.replaceAll("\\", "/")}`;
  process.env.STORAGE_ROOT = path.join(directory, "storage");
  assert.equal(path.dirname(filename), directory);
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const sqlite = new DatabaseSync(filename);
  try {
    const migrations = path.resolve("prisma/migrations");
    for (const folder of (await readdir(migrations, { withFileTypes: true })).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      sqlite.exec(await readFile(path.join(migrations, folder.name, "migration.sql"), "utf8"));
    }
  } finally { sqlite.close(); }
  db = (await import("../lib/db/prisma")).prisma;
  history = await import("../lib/services/project-history-service");
  projects = await import("../lib/services/project-service");
  const common = { name: "Original", platform: "general_ecommerce", style: "generic_clean" };
  for (const id of ["duplicate", "uploading", "has-output", "ordinary", "in-place", "result", "output-result", "ordinary-result"]) {
    const source = { result: "duplicate", "output-result": "has-output", "ordinary-result": "ordinary", "in-place": "in-place" }[id];
    await db.project.create({ data: { ...common, id, modelSnapshot: id === "ordinary" ? {} : { workType: "translation", ...(source ? { translationReady: true, translationSourceProjectId: source } : {}) } } });
  }
  const storage = await import("../lib/storage/asset-manager");
  for (const id of ["duplicate", "result"]) {
    await storage.saveUploadAsset({ projectId: id, type: "DETAIL", fileName: "original.png", fileBuffer: Buffer.from("original image bytes"), sortOrder: 0 });
  }
  await db.productAsset.create({ data: { projectId: "has-output", type: "GENERATED", filePath: "generated/kept.png", fileName: "kept.png" } });
  const original = await db.productAsset.findFirstOrThrow({ where: { projectId: "result" } });
  await db.pageSection.create({ data: { projectId: "result", sectionKey: "translation-0", type: "CUSTOM", title: "Translated", goal: "", copy: "", visualPrompt: "", order: 0, editableData: { translationSourceAssetId: original.id } } });
});

after(async () => {
  await db?.$disconnect();
  if (directory && path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith("mxpage-visibility-test-")) await rm(directory, { recursive: true, force: true });
});

test("legacy source-only duplicates are excluded from both lists, counts and categories without modifying assets or comparison", async () => {
  const before = await db.project.findMany({ include: { assets: true, sections: true } });
  const all = await history.listProjectHistory({}, db);
  assert.equal(all.total, 7);
  assert.equal(all.counts.translation, 6);
  assert.equal(all.counts.detail, 1);
  assert.ok(!all.projects.some(p => p.id === "duplicate"));
  const translated = await history.listProjectHistory({ category: "translation" }, db);
  assert.equal(translated.total, 6);
  const api = await projects.listProjects();
  assert.deepEqual(api.map(p => p.id).sort(), all.projects.map(p => p.id).sort());
  for (const id of ["uploading", "has-output", "ordinary", "in-place", "result"]) assert.ok(api.some(p => p.id === id));
  assert.ok(await projects.getProjectDetail("duplicate"), "Hidden sources stay directly accessible");
  const result = (await projects.getProjectDetail("result"))!;
  const sourceId = (result.sections[0].editableData as { translationSourceAssetId: string }).translationSourceAssetId;
  const source = result.assets.find(a => a.id === sourceId)!;
  assert.ok(source.url);
  const { readStorageFile } = await import("../lib/storage/asset-manager");
  assert.equal((await readStorageFile(source.filePath)).toString(), "original image bytes");
  assert.deepEqual(await db.project.findMany({ include: { assets: true, sections: true } }), before);
});

test("work covers use the first current result, follow version switches, and fall back to originals without changing comparison", async () => {
  const original = await db.productAsset.findFirstOrThrow({ where: { projectId: "result", type: "DETAIL" } });
  const section = await db.pageSection.findFirstOrThrow({ where: { projectId: "result" } });
  const storage = await import("../lib/storage/asset-manager");
  const cover = async (id: string) => {
    const api = (await projects.listProjects()).find(p => p.id === id)!;
    const list = (await history.listProjectHistory({}, db)).projects.find(p => p.id === id)!;
    assert.equal(api.coverImageUrl, list.coverImageUrl);
    assert.equal(api.coverThumbnailUrl, list.coverThumbnailUrl);
    assert.ok(list.coverThumbnailUrl?.startsWith("/api/thumbnails/"));
    return list.coverImageUrl;
  };
  assert.equal(await cover("result"), storage.assetPublicUrl(original));
  const first = await db.productAsset.create({ data: { projectId: "result", type: "GENERATED", filePath: "generated/first.png", fileName: "first.png" } });
  const second = await db.productAsset.create({ data: { projectId: "result", type: "GENERATED", filePath: "generated/second.png", fileName: "second.png" } });
  await db.pageSection.update({ where: { id: section.id }, data: { currentImageAssetId: first.id } });
  assert.equal(await cover("result"), storage.assetPublicUrl(first));
  await db.pageSection.update({ where: { id: section.id }, data: { currentImageAssetId: second.id } });
  assert.equal(await cover("result"), storage.assetPublicUrl(second));
  assert.equal((await db.pageSection.findUniqueOrThrow({ where: { id: section.id } })).editableData && ((await projects.getProjectDetail("result"))!.sections[0].editableData as any).translationSourceAssetId, original.id);
  assert.equal((await storage.readStorageFile(original.filePath)).toString(), "original image bytes");
  await db.pageSection.update({ where: { id: section.id }, data: { currentImageAssetId: null } });
  assert.equal(await cover("result"), storage.assetPublicUrl(original), "Unselected generated versions must not become the cover");
  const generated = await db.productAsset.findFirstOrThrow({ where: { projectId: "has-output" } });
  await db.pageSection.create({ data: { projectId: "ordinary", sectionKey: "hero", type: "HERO", title: "Hero", goal: "", copy: "", visualPrompt: "", order: 0, currentImageAssetId: generated.id } });
  assert.equal(await cover("ordinary"), storage.assetPublicUrl(generated));
});

test("when no prepared result remains, the retained source becomes visible again", async () => {
  await db.project.update({ where: { id: "result" }, data: { modelSnapshot: { workType: "translation" } } });
  const all = await history.listProjectHistory({}, db);
  assert.equal(all.total, 8);
  assert.ok(all.projects.some(p => p.id === "duplicate"));
});
