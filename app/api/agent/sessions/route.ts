import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { ok, handleRouteError } from "@/lib/utils/route";
import { sameOrigin } from "@/lib/agent/http";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try { return ok(await prisma.agentSession.findMany({ where: { archived: request.nextUrl.searchParams.get("archived") === "true" }, orderBy: { updatedAt: "desc" }, take: 200 })); }
  catch (error) { return handleRouteError(error); }
}
export async function POST(request: NextRequest) {
  try { sameOrigin(request); return ok(await prisma.agentSession.create({ data: {} })); }
  catch (error) { return handleRouteError(error); }
}
