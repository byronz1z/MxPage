export class InvalidStoryboard extends Error {
  readonly code = "ART_DIRECTION_INVALID";
}

export function storyboardIssue(sections: Array<{ sectionIndex: number }>, expected: number): string | undefined {
  if (sections.length !== expected) return `视觉分镜数量与页面数量不一致：需要 ${expected} 张，实际 ${sections.length} 张。`;
  const indices = new Set(sections.map(section => section.sectionIndex));
  if (indices.size !== expected || sections.some(section => !Number.isInteger(section.sectionIndex) || section.sectionIndex < 0 || section.sectionIndex >= expected)) {
    return `视觉分镜页面下标必须完整且不重复，范围为 0–${expected - 1}。`;
  }
}
