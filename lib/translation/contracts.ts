export const TRANSLATION_WORKFLOW = "image-translation-v1";
export type TranslationImage = {
  sectionId: string;
  sourceAssetId: string;
  title: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "UNCERTAIN";
  attempts: number;
  assetId?: string;
  error?: string;
};
export type TranslationProgress = { images: TranslationImage[]; message: string; taskTiming?: import("@/lib/tasks/timing").TaskTiming };
export function translationSummary(images: TranslationImage[]) {
  const completed = images.filter(image => image.status === "COMPLETED").length;
  const failed = images.filter(image => image.status === "FAILED" || image.status === "UNCERTAIN").length;
  return { completed, failed, total: images.length, message: `已翻译 ${completed}/${images.length} 张${failed ? `，${failed} 张未完成` : ""}` };
}
