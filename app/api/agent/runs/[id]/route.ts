import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { controlAgentRun } from "@/lib/agent/service";
import { hash } from "@/lib/agent/contracts";
import { summarizeBudget } from "@/lib/agent/budget";
import { sameOrigin, agentCredentials } from "@/lib/agent/http";
import { ok, handleRouteError } from "@/lib/utils/route";
import { desktopBridgeAvailable, desktopRequest } from "@/lib/agent/desktop";
export const dynamic = "force-dynamic";
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: params.id }, include: { calls: { select: { id: true, name: true, status: true, error: true, createdAt: true, updatedAt: true }, orderBy: { createdAt: "asc" } } } });
    // Re-register persisted proposals after an Electron restart; only the trusted
    // renderer can grant them, and the main process checks this exact digest.
    if (run.plan && desktopBridgeAvailable() && !["COMPLETED", "FAILED", "STOPPED"].includes(run.status)) await desktopRequest("register_plan", { runId: run.id, plan: run.plan, planHash: hash(run.plan) });
    const budget = summarizeBudget(await prisma.agentEvent.findMany({ where: { runId: run.id, type: { in: ["cost", "cost_acknowledged"] } }, orderBy: { seq: "asc" } }));
    return ok({ ...run, budget, planHash: run.plan ? hash(run.plan) : null });
  } catch (error) { return handleRouteError(error); }
}
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try { sameOrigin(request); const body = await request.json(); return ok(await controlAgentRun(params.id, String(body.action), body, agentCredentials(request))); }
  catch (error) { return handleRouteError(error); }
}
