import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
let root: string, thumbnails: typeof import("../lib/storage/thumbnails");
before(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "mxpage-thumbnails-"));
  process.env.STORAGE_ROOT = path.join(root, "storage");
  process.env.DATABASE_URL = `file:${path.join(root, "unused.db").replaceAll("\\", "/")}`;
  await fs.mkdir(process.env.STORAGE_ROOT);
  thumbnails = await import("../lib/storage/thumbnails");
});
after(async () => { if (root && path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith("mxpage-thumbnails-")) await fs.rm(root, { recursive: true, force: true }); });
test("thumbnail is bounded WebP, concurrent requests share a cache file, originals remain byte-identical", async () => {
  const original = await sharp({ create: { width: 1800, height: 3600, channels: 3, background: "#98aabb" } }).png().toBuffer();
  const file = path.join(process.env.STORAGE_ROOT!, "original.png"); await fs.writeFile(file, original);
  const results = await Promise.all(Array.from({ length: 8 }, () => thumbnails.readThumbnail("original.png")));
  const metadata = await sharp(results[0].bytes).metadata();
  assert.equal(metadata.format, "webp"); assert.equal(metadata.width, 480); assert.equal(metadata.height, 960);
  assert.ok(results[0].bytes.length < original.length);
  for (const result of results) { assert.equal(result.etag, results[0].etag); assert.deepEqual(result.bytes, results[0].bytes); }
  assert.equal((await fs.readdir(path.join(process.env.STORAGE_ROOT!, ".thumbnails"))).length, 1);
  assert.deepEqual(await fs.readFile(file), original);
  assert.deepEqual((await thumbnails.readThumbnail("original.png")).bytes, results[0].bytes);
});
test("source replacement invalidates cache and deleting disposable caches regenerates identical previews", async () => {
  const before = await thumbnails.readThumbnail("original.png");
  await fs.writeFile(path.join(process.env.STORAGE_ROOT!, "original.png"), await sharp({ create: { width: 40, height: 60, channels: 3, background: "red" } }).png().toBuffer());
  const after = await thumbnails.readThumbnail("original.png"); assert.notEqual(after.etag, before.etag);
  const metadata = await sharp(after.bytes).metadata(); assert.equal(metadata.width, 40); assert.equal(metadata.height, 60);
  await fs.rm(path.join(process.env.STORAGE_ROOT!, ".thumbnails"), { recursive: true });
  assert.deepEqual((await thumbnails.readThumbnail("original.png")).bytes, after.bytes);
});
test("thumbnail generator rejects path escape and unsupported data without touching the source", async () => {
  await fs.writeFile(path.join(root, "outside.png"), "outside");
  await assert.rejects(thumbnails.readThumbnail("../outside.png"), /越界/);
  await fs.writeFile(path.join(process.env.STORAGE_ROOT!, "bad.png"), "broken");
  await assert.rejects(thumbnails.readThumbnail("bad.png"));
  assert.equal(await fs.readFile(path.join(process.env.STORAGE_ROOT!, "bad.png"), "utf8"), "broken");
});
