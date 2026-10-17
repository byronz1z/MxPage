import { listApiUsageEntries } from "./api-usage";
import { runTimingHistory } from "@/lib/detail-runs/timing";

// Editor polling shares a short cache. Reading timings never changes usage logs
// or exposes provider URLs, credentials, prompts, or billing details.
let cached: { expires: number; entries: Awaited<ReturnType<typeof listApiUsageEntries>> } | undefined;
let pending: Promise<Awaited<ReturnType<typeof listApiUsageEntries>>> | undefined;
export async function getRunTimingHistory(projectId: string, runId: string) {
  if (!cached || cached.expires <= Date.now()) {
    pending ??= listApiUsageEntries(10000);
    try { cached = { entries: await pending, expires: Date.now() + 5000 }; }
    finally { pending = undefined; }
  }
  return runTimingHistory(cached.entries, projectId, runId);
}
