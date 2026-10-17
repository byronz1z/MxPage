export type V4TextBlock = { text: string; role: string; lines?: string[]; x?: number; y?: number; width?: number; fontSize?: number; lineHeight?: number; align?: string };

const numberWithUnit = /^[-+]?\d+(?:\.\d+)?(?:[ \t]*[×x*][ \t]*\d+(?:\.\d+)?)*[ \t]*(?:毫米|厘米|千克|公斤|毫升|小时|分钟|英寸|米|克|升|瓦|伏|安|寸|个|件|套|mm|cm|kg|mg|ml|hz|w|v|a|g|l|m|%|℃|°C)(?![a-z])/i;
const tokens = (text: string) => {
  const result: string[] = [];
  for (let index = 0; index < text.length;) {
    const match = text.slice(index).match(numberWithUnit);
    if (match) { result.push(match[0]); index += match[0].length; continue; }
    result.push(Array.from(text.slice(index))[0]); index += Array.from(text.slice(index))[0].length;
  }
  return result;
};

export function wrapExactText(text: string, maxChars = 12) {
  if (!text) return [];
  const result: string[] = [];
  let line = "";
  for (const token of tokens(text)) {
    if (line && line.length + token.length > maxChars) { result.push(line); line = ""; }
    line += token;
  }
  if (line) result.push(line);
  return result.length ? result : [text];
}

export function normalizeTypesetting(blocks: V4TextBlock[], maxChars = 12) {
  return blocks.map((block) => {
    const fontSize = Math.min(40, Math.max(14, block.fontSize || (block.role === "headline" ? 32 : 16)));
    const lines = wrapExactText(block.text, Math.max(4, Math.min(24, Math.round((block.width || 80) / 7) || maxChars)));
    return { ...block, lines, x: Math.max(0, Math.min(94, block.x ?? 8)), y: Math.max(0, Math.min(92, block.y ?? 8)), width: Math.max(6, Math.min(90, block.width ?? 84)), fontSize, lineHeight: Math.max(1.1, Math.min(1.8, block.lineHeight ?? 1.35)), align: block.align || "left" };
  });
}

export function validateExactTypesetting(blocks: V4TextBlock[]) {
  return blocks.flatMap((block, index) => block.lines?.join("") === block.text ? [] : [`Typesetting block ${index}: generated lines do not preserve canonical copy.`]);
}
