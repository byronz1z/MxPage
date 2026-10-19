import sharp from "sharp";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_PIXELS } from "./upload-limits";

export async function validateUploadedImage(bytes: Buffer, mime: string) {
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new Error("图片不能为空，每张不超过 20MB。");
  let metadata;
  try { metadata = await sharp(bytes, { limitInputPixels: MAX_UPLOAD_PIXELS, animated: true }).metadata(); }
  catch { throw new Error("无法读取图片，图片可能损坏或超过 4000 万像素。"); }
  const formats: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
  if (!metadata.format || formats[metadata.format] !== mime || (metadata.pages || 1) > 1) throw new Error("仅支持实际格式与声明一致的静态 PNG、JPEG、WebP 图片。");
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_UPLOAD_PIXELS) throw new Error("每张图片不能超过 4000 万像素。");
  // Decode to detect truncated/corrupt pixel data before saving any asset.
  try { await sharp(bytes, { limitInputPixels: MAX_UPLOAD_PIXELS, failOn: "warning" }).resize(1, 1).raw().toBuffer(); }
  catch { throw new Error("图片内容损坏，请重新导出图片后上传。"); }
}

export async function readUploadJson(request: Request, maxImageBytes = MAX_UPLOAD_BYTES) {
  const max = Math.ceil(maxImageBytes * 4 / 3) + 64 * 1024;
  if (Number(request.headers.get("content-length")) > max) throw new Error("上传请求过大，请减少图片数量或文件大小。");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("上传内容为空。");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > max) { await reader.cancel(); throw new Error("上传请求过大，请减少图片数量或文件大小。"); }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
