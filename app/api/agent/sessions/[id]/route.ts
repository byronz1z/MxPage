import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getAgentSession } from "@/lib/agent/store";
import { deleteAgentSession } from "@/lib/agent/service";
import { sameOrigin } from "@/lib/agent/http";
import { ok, handleRouteError } from "@/lib/utils/route";
export const dynamic = "force-dynamic";
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try { return ok(await getAgentSession(params.id)); } catch (error) { return handleRouteError(error); }
}
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    sameOrigin(request);
    const body = z.object({ title: z.string().trim().min(1).max(100).optional(), archived: z.boolean().optional(), modelId: z.string().max(200).nullable().optional() }).parse(await request.json());
    return ok(await prisma.agentSession.update({ where: { id: params.id }, data: body }));
  } catch (error) { return handleRouteError(error); }
}
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try { sameOrigin(request); await deleteAgentSession(params.id); return ok({ deleted: true }); } catch (error) { return handleRouteError(error); }
}
