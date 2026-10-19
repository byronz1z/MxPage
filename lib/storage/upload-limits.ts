export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOAD_PIXELS = 40_000_000;
export const MAX_UPLOAD_BATCH_BYTES = 300 * 1024 * 1024;
export function validateUploadFiles(files: Array<Pick<File, "name" | "size" | "type">>) {
  for (const file of files) {
    if (!file.size || file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name}：图片不能为空，每张不超过 20MB。`);
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error(`${file.name}：仅支持 PNG、JPEG、WebP 图片。`);
  }
  if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_BATCH_BYTES) throw new Error("本次图片总量超过 300MB，请分批上传。");
}
