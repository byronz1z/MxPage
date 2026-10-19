import { HERO_MIN, HERO_MAX, DETAIL_MIN, DETAIL_MAX, TOTAL_IMAGE_MAX, hasOutputImages, OUTPUT_COUNT_ERROR } from "@/lib/utils/image-counts";
import { z } from "zod";
import { contentLanguageOptions } from "@/lib/utils/content-language";
import type { ArtDirection, ArtReview } from "./art-direction";
import type { StyleReference } from "./reference-catalog";

const imageSizeSchema = z.string().regex(/^(auto|\d{2,4}x\d{2,4})$/).refine((value) => {
  if (value === "auto") return true;
  const [width, height] = value.split("x").map(Number);
  const long = Math.max(width, height), short = Math.min(width, height);
  return width % 16 === 0 && height % 16 === 0 && long <= 3840 && short > 0 && long / short <= 3 && width * height >= 655360 && width * height <= 8294400;
}, "尺寸必须为 16 的倍数，像素数在 655360–8294400 之间，长宽比不超过 3:1");

export const detailRunInputSchema = z.object({
  idempotencyKey: z.string().min(8).max(100),
  language: z.enum(contentLanguageOptions).default("zh-CN"),
  quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).default("auto"),
  imageSettings: z.object({
    size: imageSizeSchema.default("auto"),
    background: z.enum(["auto", "opaque", "transparent"]).default("auto"),
    outputFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
    outputCompression: z.number().int().min(0).max(100).default(100),
    moderation: z.enum(["auto", "low"]).default("auto"),
  }).default({ size: "auto", background: "auto", outputFormat: "png", outputCompression: 100, moderation: "auto" }),
  heroCount: z.number().int().min(HERO_MIN).max(HERO_MAX).default(4),
  detailCount: z.number().int().min(DETAIL_MIN).max(DETAIL_MAX).default(6),
  mode: z.enum(["create", "xhs", "edit", "regenerate", "translate"]).default("create"),
  sectionId: z.string().optional(),
  instruction: z.string().trim().max(4000).default(""),
}).refine(value => hasOutputImages(value.heroCount, value.detailCount), { message: OUTPUT_COUNT_ERROR, path: ["heroCount"] });
export type DetailRunInput = z.infer<typeof detailRunInputSchema>;
export const planSchema = z.object({
  productName: z.string().min(1),
  facts: z.array(z.string()).max(30),
  style: z.string().min(10).max(6000),
  sections: z.array(z.object({
    kind: z.enum(["HERO", "DETAIL"]),
    title: z.string().min(1),
    copy: z.string(),
    prompt: z.string().min(10).max(10000),
  })).min(1).max(TOTAL_IMAGE_MAX),
});
export const socialPostSchema = z.object({ title: z.string().min(1).max(200), caption: z.string().min(1).max(6000), hashtags: z.array(z.string().min(1).max(80)).min(3).max(8), language: z.enum(contentLanguageOptions) });
export const xhsPlanSchema = planSchema.extend({ post: socialPostSchema });
export type DetailPlan = z.infer<typeof planSchema> & { post?: z.infer<typeof socialPostSchema> };
export type ImageProgress = {
  sectionId: string;
  title: string;
  state: "pending" | "generating" | "generated" | "checked" | "uncertain";
  assetId?: string;
  correctionCount: number;
  check?: { passed: boolean; issues: string[]; assetId: string; visualQuality?: ArtReview };
  viewedAssetId?: string;
  error?: string;
  attemptKey?: string;
  retryRequested?: boolean;
};
export type RunCheckpoint = {
  taskTiming?: import("@/lib/tasks/timing").TaskTiming;
  contentWarnings?: string[];
  failure?: { code: string; phase: string; message: string; networkCode?: string; fields?: string[]; at: string };
  creativeVersion?: 2 | 3;
  adaptations?: Partial<Record<"heroes" | "details", { status: "claimed" | "applied" | "skipped" | "failed"; reason: string; basis: string[]; sectionIds: string[] }>>;
  flexibleReview?: import("./flexible-creative").FlexibleReview;
  recommendedDirection?: string;
  styleReferences?: StyleReference[];
  designReview?: { passed: boolean; issues: { sectionIds: string[]; message: string; kind?: "fact" | "design" | "copy" | "typography"; resolved?: boolean }[] };
  designDraft?: ArtDirection;
  designPatches?: import("./design-review").CreativeReview["patches"];
  designAttempts?: number;
  firstHeroGate?: { sectionId: string; assetId?: string; passed: boolean; reason?: string };
  imageRequests?: number;
  reviewErrors?: Record<string, string>;
  continuationRunId?: string;
  plan?: DetailPlan;
  planDraft?: DetailPlan;
  planningReview?: { issues: string[] };
  artDirection?: ArtDirection;
  userVisualDirection?: string;
  images: ImageProgress[];
  questions?: import("./supplemental-input").StoredSupplementalQuestion[];
  supplementalQuestionIssue?: string;
  answers: string[];
  skippedQuestions?: boolean;
  toolCalls: number;
  events: { at: string; tool: string; sectionId?: string }[];
  agentSummary?: string;
  transport?: "responses" | "chat";
  modelId?: string;
  imageModelId?: string;
  editModelId?: string;
  providerId?: string;
  providerBaseUrl?: string;
  questionAssetCount?: number;
  setReview?: { passed: boolean; issues: { sectionIds: string[]; message: string }[]; assetIds: string[] };
};
export const RUN_ACTIVE = ["PENDING", "RUNNING", "WAITING_INPUT"];
export function outcome(images: ImageProgress[]) {
  return images.length > 0 && images.every(i => i.state === "checked" && i.check?.passed)
    ? "COMPLETED" : "PARTIAL";
}
export function mayGenerate(image: ImageProgress, correction: boolean) {
  if (image.state === "uncertain" || image.state === "generating") return false;
  return correction
    ? Boolean(image.assetId && image.check && !image.check.passed && image.correctionCount < 1)
    : !image.assetId;
}
