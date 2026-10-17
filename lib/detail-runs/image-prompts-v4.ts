import { cleanCustomerDirection, confirmedAnswerCopyRules } from "./customer-copy";
type Section = { order: number; visualPrompt: string };
type Direction = { sectionIndex: number; prompt: string; textBlocks: Array<{ text: string }> };

// Persistence and paid generation must consume the same finalized storyboard.
// Reading sections before saving the storyboard leaves stale planning prompts.
export function materializeImagePrompts<S extends Section, D extends Direction>(sections: S[], directions: D[], confirmedEstimates = false) {
  const byIndex = new Map(directions.map(direction => [direction.sectionIndex, confirmedEstimates ? cleanCustomerDirection(direction) : direction]));
  if (byIndex.size !== directions.length || directions.length !== sections.length) {
    throw new Error("视觉分镜编号重复或数量不匹配，未发起图片请求。");
  }
  return sections.map(section => {
    const artDirection = byIndex.get(section.order);
    if (!artDirection) throw new Error(`缺少第 ${section.order + 1} 张图片的视觉分镜，未发起图片请求。`);
    return {
      ...section,
      artDirection,
      visualPrompt: `${artDirection.prompt}\n${confirmedEstimates ? `${confirmedAnswerCopyRules}\n` : ""}Use the following Exact copy as the sole source of visible text. It overrides any conflicting wording in the visual description; do not rephrase, omit or add claims.\nExact copy:\n${artDirection.textBlocks.map(block => block.text).join("\n")}`,
    };
  });
}
