import type { ApiUsageEntry } from "./api-usage";

const DAY = 86_400_000;
// Usage days follow the same UTC+8 calendar as the monitor charts.
export const usageDay = (time: number) => new Date(time + 8 * 3_600_000).toISOString().slice(0, 10);
export function buildUsageActivity(entries: ApiUsageEntry[], now = Date.now()) {
  const today = usageDay(now);
  const [year, month] = today.split("-").map(Number);
  // Include this month and the previous 11 calendar months, ending today.
  const start = Date.UTC(year, month - 12, 1);
  const end = Date.parse(today) + DAY;
  const days = Array.from({ length: (end - start) / DAY }, (_, index) => ({
    date: new Date(start + index * DAY).toISOString().slice(0, 10),
    requests: 0, tokens: 0, tokenSamples: 0, costUsd: 0, priced: 0,
  }));
  const byDay = new Map(days.map(day => [day.date, day]));
  const activeDates = new Set<string>();
  for (const entry of entries) {
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp) || timestamp > now) continue;
    const date = usageDay(timestamp);
    activeDates.add(date);
    const day = byDay.get(date);
    if (!day) continue;
    day.requests++;
    if (entry.totalTokens != null && Number.isFinite(entry.totalTokens) && entry.totalTokens >= 0) {
      day.tokens += entry.totalTokens; day.tokenSamples++;
    }
    const cost = entry.billing?.costUsd ?? entry.actualCostUsd;
    if (cost != null && Number.isFinite(cost) && cost >= 0) { day.costUsd += cost; day.priced++; }
  }
  let longestStreak = 0, run = 0;
  for (const day of days) {
    run = day.requests ? run + 1 : 0;
    longestStreak = Math.max(longestStreak, run);
  }
  let currentStreak = 0;
  let cursor = Date.parse(today);
  if (!activeDates.has(today)) cursor -= DAY;
  while (activeDates.has(new Date(cursor).toISOString().slice(0, 10))) { currentStreak++; cursor -= DAY; }
  return {
    startDate: days[0].date, today, days,
    totals: days.reduce((total, day) => ({
      requests: total.requests + day.requests, tokens: total.tokens + day.tokens,
      costUsd: total.costUsd + day.costUsd, priced: total.priced + day.priced,
      tokenSamples: total.tokenSamples + day.tokenSamples, activeDays: total.activeDays + (day.requests ? 1 : 0),
    }), { requests: 0, tokens: 0, costUsd: 0, priced: 0, tokenSamples: 0, activeDays: 0 }),
    longestStreak, currentStreak, peakTokens: Math.max(0, ...days.map(day => day.tokens)),
    startWeekday: new Date(start).getUTCDay(),
  };
}
export type UsageActivity = ReturnType<typeof buildUsageActivity>;
