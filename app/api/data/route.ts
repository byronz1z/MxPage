import { z } from "zod";
import { dataOverview, createDataBackup, previewDataRestore, restoreDataBackup } from "@/lib/storage/data-backups";
import { listTrash, restoreTrash } from "@/lib/services/recycle-bin";
import { ok, handleRouteError } from "@/lib/utils/route";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return ok({ ...await dataOverview(), trash: await listTrash() }); }
  catch (error) { return handleRouteError(error); }
}
export async function POST(request: Request) {
  try {
    const input = z.discriminatedUnion("action", [
      z.object({ action: z.literal("backup") }),
      z.object({ action: z.literal("preview"), id: z.string().uuid() }),
      z.object({ action: z.literal("restore"), id: z.string().uuid() }),
      z.object({ action: z.literal("untrash"), id: z.string().min(1).max(160) }),
    ]).parse(await request.json());
    if (input.action === "backup") return ok(await createDataBackup());
    if (input.action === "preview") return ok(await previewDataRestore(input.id));
    if (input.action === "restore") return ok(await restoreDataBackup(input.id));
    return ok(await restoreTrash(input.id));
  } catch (error) { return handleRouteError(error); }
}
