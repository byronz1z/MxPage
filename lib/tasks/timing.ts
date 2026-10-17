/** Stored in a task's existing JSON checkpoint; no database migration required. */
export type TaskTiming = { elapsedMs: number; startedAt: string; updatedAt: string; finishedAt?: string };
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
export function readTaskTiming(value: unknown): TaskTiming | undefined {
  const timing = value as TaskTiming | undefined;
  return timing && Number.isFinite(timing.elapsedMs) && timing.elapsedMs >= 0 && timestamp(timing.startedAt) !== undefined && timestamp(timing.updatedAt) !== undefined ? timing : undefined;
}
export function timingElapsed(timing: TaskTiming, now = Date.now()) {
  return timing.elapsedMs + Math.max(0, (timestamp(timing.finishedAt) ?? now) - Date.parse(timing.startedAt));
}
export function startTiming(previous?: unknown, now = Date.now()): TaskTiming {
  const saved = readTaskTiming(previous), stamp = new Date(now).toISOString();
  // A stopped/crashed session ends at its last saved checkpoint, never at resume time.
  return { elapsedMs: saved ? timingElapsed(saved, Date.parse(saved.updatedAt)) : 0, startedAt: stamp, updatedAt: stamp };
}
export function touchTiming(timing: TaskTiming, finish = false, now = Date.now()): TaskTiming {
  const stamp = new Date(now).toISOString();
  return { ...timing, updatedAt: stamp, ...(finish ? { finishedAt: stamp } : {}) };
}
export type TaskDuration = { elapsedMs: number; timerStartedAt?: string; timingEstimated?: boolean };
export function projectTaskDuration(input: { status: string; createdAt: string; updatedAt: string; startedAt?: string | null; completedAt?: string | null; timing?: unknown }, now = Date.now()): TaskDuration {
  const timing = readTaskTiming(input.timing);
  const running = input.status === "RUNNING";
  const end = timestamp(input.completedAt) ?? timestamp(input.updatedAt) ?? now;
  const start = timestamp(input.startedAt) ?? timestamp(input.createdAt) ?? end;
  const elapsedMs = input.status === "PENDING" ? (timing ? timingElapsed(timing, Date.parse(timing.updatedAt)) : 0)
    : timing ? timingElapsed(timing, running ? now : Math.min(end, Date.parse(timing.updatedAt))) : Math.max(0, (running ? now : end) - start);
  return { elapsedMs, ...(running && !timing?.finishedAt ? { timerStartedAt: new Date(now).toISOString() } : {}), ...(!timing && !input.startedAt ? { timingEstimated: true } : {}) };
}
export function taskElapsed(item: TaskDuration, now = Date.now()) {
  return Math.max(0, item.elapsedMs + (item.timerStartedAt ? Math.max(0, now - (timestamp(item.timerStartedAt) ?? now)) : 0));
}
export function formatTaskDuration(ms: number) {
  const seconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}小时 ${minutes}分 ${seconds % 60}秒` : minutes ? `${minutes}分 ${seconds % 60}秒` : `${seconds}秒`;
}
