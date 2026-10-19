import { prisma } from "@/lib/db/prisma";
import { readAgentFile } from "@/lib/agent/files";
import { ok, handleRouteError } from "@/lib/utils/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    const artifact = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: params.id } });
    if (!artifact.filePath || artifact.kind === "archive") throw new Error("Agent: 此成果请下载后查看。");
    return ok(await readAgentFile(artifact.sessionId, artifact.id));
  } catch (error) { return handleRouteError(error); }
}
