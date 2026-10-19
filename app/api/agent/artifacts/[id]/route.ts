import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import { prisma } from "@/lib/db/prisma";
import { artifactFile } from "@/lib/agent/files";
import { handleRouteError } from "@/lib/utils/route";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const artifact = await prisma.agentArtifact.findUniqueOrThrow({ where: { id: params.id } });
    const { filename } = await artifactFile(artifact.sessionId, artifact.id);
    return new Response(await fs.readFile(filename), { headers: { "Content-Type": artifact.mimeType, "Content-Disposition": `${request.nextUrl.searchParams.has("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(artifact.name)}`, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'", "Cache-Control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}
