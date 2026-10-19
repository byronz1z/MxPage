import { NextRequest } from "next/server";
import { createAgentRun } from "@/lib/agent/service";
import { sameOrigin, agentCredentials } from "@/lib/agent/http";
import { ok, handleRouteError } from "@/lib/utils/route";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try { sameOrigin(request); return ok(await createAgentRun(params.id, await request.json(), agentCredentials(request))); }
  catch (error) { return handleRouteError(error); }
}
