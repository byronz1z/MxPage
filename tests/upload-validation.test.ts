import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { validateUploadedImage, readUploadJson } from "../lib/storage/upload-validation";
import { MAX_UPLOAD_BYTES, validateUploadFiles } from "../lib/storage/upload-limits";
test("upload validates bytes, real format, corrupt data and pixel limits without modifying images", async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
  const before = Buffer.from(png);
  await validateUploadedImage(png, "image/png"); assert.deepEqual(png, before);
  await assert.rejects(validateUploadedImage(png, "image/jpeg"), /实际格式/);
  await assert.rejects(validateUploadedImage(Buffer.from("not an image"), "image/png"), /无法读取/);
  await assert.rejects(validateUploadedImage(png.subarray(0, 40), "image/png"));
  await assert.rejects(validateUploadedImage(Buffer.alloc(MAX_UPLOAD_BYTES + 1), "image/png"), /20MB/);
  const huge = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(validateUploadedImage(huge, "image/png"), /像素/);
});
test("client limits reject large files and excessive batch totals before reading file data", () => {
  assert.throws(() => validateUploadFiles([{ name: "large.png", size: MAX_UPLOAD_BYTES + 1, type: "image/png" }]), /20MB/);
  assert.throws(() => validateUploadFiles([{ name: "svg", size: 10, type: "image/svg+xml" }]), /PNG/);
  assert.throws(() => validateUploadFiles(Array.from({ length: 16 }, () => ({ name: "large.png", size: MAX_UPLOAD_BYTES, type: "image/png" }))), /300MB/);
});
test("upload body is bounded even when content-length is absent", async () => {
  assert.deepEqual(await readUploadJson(new Request("http://local", { method: "POST", body: '{"ok":true}' })), { ok: true });
  await assert.rejects(readUploadJson(new Request("http://local", { method: "POST", body: "{}", headers: { "Content-Length": String(40 * 1024 * 1024) } })), /请求过大/);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(29 * 1024 * 1024)); controller.close(); } });
  await assert.rejects(readUploadJson(new Request("http://local", { method: "POST", body: stream, duplex: "half" } as RequestInit)), /请求过大/);
});
