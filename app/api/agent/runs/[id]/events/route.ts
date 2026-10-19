import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handleRouteError } from "@/lib/utils/route";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    await prisma.agentRun.findUniqueOrThrow({ where: { id: params.id } });
    let cursor = Number(request.headers.get("last-event-id") || request.nextUrl.searchParams.get("after") || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
    const encoder = new TextEncoder(); let timer: ReturnType<typeof setTimeout> | undefined; let closed = false;
    const stream = new ReadableStream({
      start(controller) {
        const stop = () => { if (!closed) { closed = true; clearTimeout(timer); try { controller.close(); } catch {} } };
        request.signal.addEventListener("abort", stop, { once: true });
        const poll = async () => {
          if (closed) return;
          try {
            const events = await prisma.agentEvent.findMany({ where: { runId: params.id, seq: { gt: cursor } }, orderBy: { seq: "asc" }, take: 200 });
            if (closed) return;
            for (const event of events) { controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)); cursor = event.seq; }
            if (!events.length) controller.enqueue(encoder.encode(": heartbeat\n\n"));
            timer = setTimeout(poll, 1000);
          } catch { stop(); }
        };
        void poll();
      },
      cancel() { closed = true; clearTimeout(timer); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" } });
  } catch (error) { return handleRouteError(error); }
}
