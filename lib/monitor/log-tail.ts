import fs from "node:fs/promises";

/** Read UTF-8 lines from the tail without loading the historical log. */
export async function readLastLines(file: string, limit: number) {
  const count = Math.max(0, Math.floor(limit));
  if (!count) return [];
  const handle = await fs.open(file, "r");
  try {
    let position = (await handle.stat()).size, newlines = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && newlines <= count) {
      const length = Math.min(position, 64 * 1024);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      const chunk = buffer.subarray(0, bytesRead);
      chunks.push(chunk);
      for (const byte of chunk) if (byte === 10) newlines++;
    }
    const lines = Buffer.concat(chunks.reverse()).toString("utf8").split(/\r?\n/);
    if (position > 0) lines.shift();
    return lines.map(line => line.trim()).filter(Boolean).slice(-count);
  } finally { await handle.close(); }
}
