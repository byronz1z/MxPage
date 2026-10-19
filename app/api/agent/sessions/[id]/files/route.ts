import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { saveAgentFile } from "@/lib/agent/files";
import { sameOrigin } from "@/lib/agent/http";
import { ok, handleRouteError } from "@/lib/utils/route";
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    sameOrigin(request);
    await prisma.agentSession.findUniqueOrThrow({ where: { id: params.id } });
    if (Number(request.headers.get("content-length")) > 26 * 1024 * 1024) throw new Error("Agent: 每次上传不能超过 25MB。");
    const form = await request.formData(); const file = form.get("file");
    if (!(file instanceof File) || file.size > 25 * 1024 * 1024) throw new Error("Agent: 请选择不超过 25MB 的文件。");
    return ok(await saveAgentFile(params.id, file.name, Buffer.from(await file.arrayBuffer())));
  } catch (error) { return handleRouteError(error); }
}
