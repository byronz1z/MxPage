import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { env } from "@/lib/utils/env";

const runtime = globalThis as typeof globalThis & { thumbnailJobs?: Map<string, Promise<Buffer>>; thumbnailSlots?: { active: number; waiting: Array<() => void> } };
const jobs = runtime.thumbnailJobs ??= new Map();
const slots = runtime.thumbnailSlots ??= { active: 0, waiting: [] };
async function encode(source: string) {
  if (slots.active >= 2) await new Promise<void>(resolve => slots.waiting.push(resolve)); else slots.active++;
  try { return await sharp(source, { limitInputPixels: 100_000_000 }).rotate().resize({ width: 640, height: 960, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer(); }
  finally { const next = slots.waiting.shift(); if (next) next(); else slots.active--; }
}
export async function readThumbnail(filePath: string) {
  const root = await fs.realpath(path.resolve(env.STORAGE_ROOT));
  const source = await fs.realpath(path.resolve(root, filePath));
  if (!source.startsWith(root + path.sep)) throw new Error("图片路径越界。");
  const stat = await fs.stat(source);
  const key = createHash("sha256").update(`v1:640:960:webp:78:${source}:${stat.size}:${stat.mtimeMs}`).digest("hex");
  const directory = path.join(root, ".thumbnails");
  const destination = path.join(directory, `${key}.webp`);
  let job = jobs.get(key);
  if (!job) {
    job = (async () => {
      try { return await fs.readFile(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const bytes = await encode(source);
      await fs.mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `${key}-${randomUUID()}.tmp`);
      try { await fs.writeFile(temporary, bytes, { flag: "wx" }); await fs.rename(temporary, destination); }
      finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
      return bytes;
    })();
    jobs.set(key, job);
    void job.finally(() => jobs.delete(key)).catch(() => undefined);
  }
  return { bytes: await job, etag: `"${key}"` };
}
