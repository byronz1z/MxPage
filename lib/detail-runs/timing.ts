import { readTaskTiming, timingElapsed, type TaskDuration, type TaskTiming } from "@/lib/tasks/timing";

// Kept separately from the request ledger: answering questions or changing an
// image can invalidate a result, but must not erase time already spent on it.
export type RequestTiming = TaskTiming & { firstStartedAt?: string };
export type TimingHistoryEntry = { key: string; durationMs: number; finishedAt: string };
export type DetailTimingRun = {
  id: string; status: string; draining?: boolean; createdAt?: string; updatedAt?: string;
  timingHistory?: TimingHistoryEntry[];
  checkpoint: {
    taskTiming?: TaskTiming;
    requestTimings?: Record<string, RequestTiming>;
    requests?: Record<string, { state: string }>;
    plan?: unknown; artDirection?: unknown; setReview?: unknown;
    images: Array<{ sectionId: string; title: string; state: string; assetId?: string; check?: unknown }>;
  };
};
export type TimingSection = { id: string; title: string; type: string; imageUrl?: string | null };
export type DetailTimingRow = {
  key: string; label: string; group: "text" | "image" | "review"; sectionId?: string;
  state: "pending" | "running" | "completed" | "uncertain";
  duration?: TaskDuration; source?: "checkpoint" | "monitor";
};

const operations: Record<string, string> = {
  v4_plan: "PLAN", v4_input_suggestions: "INPUT_SUGGESTIONS", v4_art_direction: "ART_DIRECTION",
  v4_plan_content_repair: "PLAN_CONTENT_REPAIR", v4_image_generation: "GENERATE",
  v4_image_review: "IMAGE_REVIEW", v4_set_review: "SET_REVIEW",
};

/** Return only public timing fields, and never attribute another run's requests. */
export function runTimingHistory(entries: Array<{ projectId: string | null; runId?: string | null; operation: string | null; sectionId: string | null; durationMs: number; timestamp: string }>, projectId: string, runId: string): TimingHistoryEntry[] {
  return entries.flatMap(entry => {
    const key = operations[entry.operation || ""];
    if (entry.projectId !== projectId || entry.runId !== runId || !key || !Number.isFinite(entry.durationMs) || entry.durationMs < 0 || !Number.isFinite(Date.parse(entry.timestamp))) return [];
    if ((key === "GENERATE" || key === "IMAGE_REVIEW") && !entry.sectionId) return [];
    return [{ key: entry.sectionId ? `${key}:${entry.sectionId}` : key, durationMs: entry.durationMs, finishedAt: entry.timestamp }];
  });
}

export function detailTimingRows(run: DetailTimingRun, sections: TimingSection[], now = Date.now()): DetailTimingRow[] {
  const cp = run.checkpoint;
  const matches = (key: string, candidate: string) => key === candidate || (key === "SET_REVIEW" && candidate.startsWith("SET_REVIEW:"));
  const hasRecord = (key: string) => Object.keys(cp.requests || {}).some(k => matches(key, k))
    || Object.keys(cp.requestTimings || {}).some(k => matches(key, k)) || run.timingHistory?.some(entry => matches(key, entry.key));
  function row(key: string, label: string, group: DetailTimingRow["group"], completed: boolean, sectionId?: string): DetailTimingRow {
    const requests = Object.entries(cp.requests || {}).filter(([k]) => matches(key, k)).map(([, value]) => value);
    const timings = Object.entries(cp.requestTimings || {}).filter(([k, value]) => matches(key, k) && readTaskTiming(value)).map(([, value]) => value);
    const running = (run.status === "RUNNING" || run.draining === true) && requests.some(request => request.state === "running");
    // Logs fill old checkpoints. A request measured in the checkpoint must not
    // also be counted from its API log; only earlier, uninstrumented calls apply.
    const firstStarted = timings.length ? Math.min(...timings.map(timing => Date.parse(timing.firstStartedAt || timing.startedAt))) : Infinity;
    const history = (run.timingHistory || []).filter(entry => matches(key, entry.key) && Date.parse(entry.finishedAt) < firstStarted);
    const elapsedMs = timings.reduce((sum, timing) => sum + timingElapsed(timing, running ? now : Date.parse(timing.updatedAt)), 0)
      + history.reduce((sum, entry) => sum + entry.durationMs, 0);
    const state = running ? "running" : requests.some(request => ["running", "uncertain", "rejected"].includes(request.state)) && !completed ? "uncertain"
      : completed || requests.some(request => request.state === "completed") ? "completed" : "pending";
    const measured = timings.length > 0 || history.length > 0;
    return { key, label, group, sectionId, state, ...(measured ? {
      duration: { elapsedMs, ...(running && timings.some(timing => !timing.finishedAt) ? { timerStartedAt: new Date(now).toISOString() } : {}),
        ...(timings.some(timing => !timing.finishedAt) && !running ? { timingEstimated: true } : {}) },
      source: timings.length ? "checkpoint" as const : "monitor" as const,
    } : {}) };
  }
  const rows: DetailTimingRow[] = [row("PLAN", "商品规划与文案", "text", !!cp.plan)];
  if (hasRecord("INPUT_SUGGESTIONS")) rows.push(row("INPUT_SUGGESTIONS", "补充信息建议", "text", false));
  if (hasRecord("PLAN_CONTENT_REPAIR")) rows.push(row("PLAN_CONTENT_REPAIR", "内容整理", "text", false));
  rows.push(row("ART_DIRECTION", "视觉分镜与提示词", "text", !!cp.artDirection));
  let heroIndex = 0, detailIndex = 0;
  const images: TimingSection[] = sections.length ? sections : cp.images.map(image => ({ id: image.sectionId, title: image.title, type: "CUSTOM" }));
  for (const section of images) {
    const image = cp.images.find(item => item.sectionId === section.id);
    const label = `${section.type === "HERO" ? `头图 ${++heroIndex}` : `详情 ${++detailIndex}`} · ${section.title}`;
    rows.push(row(`GENERATE:${section.id}`, label, "image", !!image?.assetId || !!section.imageUrl, section.id));
    rows.push(row(`IMAGE_REVIEW:${section.id}`, label, "review", !!image?.check, section.id));
  }
  rows.push(row("SET_REVIEW", "整套页面检查", "review", !!cp.setReview));
  return rows;
}
