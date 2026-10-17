import { NextRequest } from "next/server";
import { z } from "zod";
import { getBatch, controlBatch } from "@/lib/detail-runs/batch";
import { readProviderCredentialsFromRequest, withProviderCredentials } from "@/lib/services/provider-runtime";
import { fail, handleRouteError, ok } from "@/lib/utils/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try { return ok(await getBatch(params.id)); } catch (error) {
    if ((error as { code?: string })?.code === "P2025") return fail("BATCH_NOT_FOUND", "批量任务不存在或已删除。", null, 404);
    return handleRouteError(error);
  }
}
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try { const { action, retryFailed } = z.object({ action: z.enum(["cancel", "resume"]), retryFailed: z.boolean().default(false) }).parse(await request.json()); return await withProviderCredentials(request, async () => ok(await controlBatch(params.id, action, readProviderCredentialsFromRequest(request), retryFailed))); }
  catch (error) { return handleRouteError(error); }
}
