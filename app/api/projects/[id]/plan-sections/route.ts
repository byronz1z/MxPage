import { NextRequest } from "next/server";
import { HERO_MAX, DETAIL_MAX, hasOutputImages, OUTPUT_COUNT_ERROR } from "@/lib/utils/image-counts";
import { z } from "zod";

import { planSections } from "@/lib/services/planner-service";
import { handleRouteError, ok } from "@/lib/utils/route";
import { withProviderCredentials } from "@/lib/services/provider-runtime";
import { contentLanguageOptions } from "@/lib/utils/content-language";

const planRequestSchema = z.object({
  modelId: z.string().optional().nullable(),
  autoDecideCounts: z.boolean().optional(),
  previewConfig: z
    .object({
      heroImageCount: z.number().int().min(0).max(HERO_MAX),
      detailSectionCount: z.number().int().min(0).max(DETAIL_MAX),
      imageAspectRatio: z.enum(["3:4", "9:16"]),
      contentLanguage: z.enum(contentLanguageOptions),
    })
    .refine(value => hasOutputImages(value.heroImageCount, value.detailSectionCount), { message: OUTPUT_COUNT_ERROR, path: ["heroImageCount"] })
    .optional(),
});

export async function POST(request: NextRequest, context: { params: { id: string } }) {
  return withProviderCredentials(request, async () => {
    try {
    const input = planRequestSchema.parse(await request.json().catch(() => ({})));
    const result = await planSections(context.params.id, {
      modelId: input.modelId,
      autoDecideCounts: input.autoDecideCounts,
      previewConfig: input.previewConfig,
    });
    return ok(result);
    } catch (error) {
      return handleRouteError(error);
    }
  });
}
