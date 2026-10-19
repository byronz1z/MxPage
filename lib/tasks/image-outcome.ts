import type { UpstreamImageTask } from "@/lib/ai/provider-client";

export type ImageOutcome = "pending_query" | "uncertain" | "failed";
export function imageOutcome(error: unknown, receipt?: UpstreamImageTask, submitted = true): ImageOutcome {
  if (receipt) return receipt.status === "failed" ? "failed" : "pending_query";
  if ((error as { code?: string })?.code === "LOCAL_BUDGET_PAUSED") return "failed";
  const status = Number((error as { status?: number })?.status);
  if (!submitted || (status >= 400 && status < 500 && status !== 408)) return "failed";
  return "uncertain";
}
export const imageOutcomeLabels = { pending_query: "上游任务已受理，等待查询结果", uncertain: "结果未确认，请先核对调用记录", failed: "请求已失败" };
