import { z } from "zod";

export type PromptReview = {
  revision: number;
  pages: Array<{ sectionId: string; title: string; kind: "HERO" | "DETAIL"; prompt: string }>;
  approvedAt?: string;
  confirmationId?: string;
};

export const promptReviewSubmission = z.object({
  revision: z.number().int().nonnegative(),
  pages: z.array(z.object({
    sectionId: z.string().min(1),
    prompt: z.string().max(30000).refine(value => value.trim().length > 0, "提示词不能为空"),
  })).min(1).max(30),
  confirmationId: z.string().uuid().optional(),
});

export class PromptReviewConflict extends Error {
  readonly code = "PROMPT_REVIEW_CONFLICT";
}
