/** Freeze the requested social-card count before planning or any paid dispatch. */
export function xhsImageCount(raw: { heroCount?: number; detailCount?: number }, brief: string) {
  let count: number;
  if (raw.heroCount !== undefined || raw.detailCount !== undefined) {
    count = (raw.heroCount ?? 0) + (raw.detailCount ?? 0);
  } else {
    const chinese: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const counts = [...new Set([...brief.matchAll(/(?<![\d一二三四五六七八九十两])([0-9]+|[一二三四五六七八九十两]+)\s*张/g)].map(match => /^\d+$/.test(match[1]) ? Number(match[1]) : chinese[match[1]] ?? 99))];
    if (counts.length > 1) throw new Error("小红书要求中有多个不同的图片数量，请明确一个 1–8 张的数量。");
    count = counts[0] ?? 5;
  }
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error("小红书配图数量必须为 1–8 张。");
  return count;
}
