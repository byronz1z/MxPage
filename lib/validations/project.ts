import { z } from "zod";

import { platformOptions, styleOptions } from "@/types/domain";
import { HERO_MIN, HERO_MAX, DETAIL_MIN, DETAIL_MAX, hasOutputImages, OUTPUT_COUNT_ERROR } from "@/lib/utils/image-counts";

export const previewImageCountsSchema = z.object({
  heroImageCount: z.number().int().min(HERO_MIN).max(HERO_MAX).default(4),
  detailSectionCount: z.number().int().min(DETAIL_MIN).max(DETAIL_MAX).default(6),
}).refine(value => hasOutputImages(value.heroImageCount, value.detailSectionCount), { message: OUTPUT_COUNT_ERROR, path: ["heroImageCount"] });

export const projectCreateSchema = z.object({
  name: z.string().trim().min(2, "项目名称至少 2 个字符"),
  platform: z.enum(platformOptions),
  style: z.enum(styleOptions),
  description: z.string().trim().optional().nullable(),
});

export const projectUpdateSchema = projectCreateSchema.partial().extend({
  status: z
    .enum(["DRAFT", "ANALYZED", "PLANNED", "EDITING", "COMPLETED"])
    .optional(),
  modelSnapshot: z.record(z.string(), z.any()).optional(),
});

export const projectSubmissionSchema = projectCreateSchema.extend({
  translationUpload: z.object({ batchId: z.string().uuid(), groupIndex: z.number().int().min(0).max(49) }).optional(),
});
