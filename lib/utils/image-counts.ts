// Shared by configuration, API validation, saved projects and Agent tool schemas.
export const HERO_MIN = 0;
export const HERO_MAX = 10;
export const DETAIL_MIN = 0;
export const DETAIL_MAX = 20;
export const TOTAL_IMAGE_MAX = HERO_MAX + DETAIL_MAX;
export const heroCountOptions = Array.from({ length: HERO_MAX - HERO_MIN + 1 }, (_, i) => HERO_MIN + i);
export const detailCountOptions = Array.from({ length: DETAIL_MAX - DETAIL_MIN + 1 }, (_, i) => DETAIL_MIN + i);
// The legacy manual planner also supports one-off images.
export const legacyHeroCountOptions = heroCountOptions;
export const legacyDetailCountOptions = detailCountOptions;
export const OUTPUT_COUNT_ERROR = "主图和详情图不能同时为 0，请至少选择 1 张图片。";
export function hasOutputImages(heroCount: number, detailCount: number) {
  return heroCount + detailCount > 0;
}
