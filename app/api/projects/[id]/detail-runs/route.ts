import { NextRequest } from "next/server";
import { createDetailRun, getDetailRun } from "@/lib/detail-runs/service";
import { withProviderCredentials, readProviderCredentialsFromRequest } from "@/lib/services/provider-runtime";
import { handleRouteError, ok } from "@/lib/utils/route";
import { getRunTimingHistory } from "@/lib/monitor/run-timing-history";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const run = await getDetailRun(params.id);
    return ok(run && request.nextUrl.searchParams.get("includeTimings") === "1"
      ? { ...run, timingHistory: await getRunTimingHistory(params.id, run.id) } : run);
  } catch (error) { return handleRouteError(error); }
}
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try { return await withProviderCredentials(request, async () => ok(await createDetailRun(params.id, await request.json(), readProviderCredentialsFromRequest(request)), { status: 202 })); }
  catch (error) { return handleRouteError(error); }
}
