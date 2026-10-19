import { NextRequest } from "next/server";
import { queryImageTask } from "@/lib/services/image-task-recovery";
import { withProviderCredentials } from "@/lib/services/provider-runtime";
import { handleRouteError, ok } from "@/lib/utils/route";

export async function POST(request: NextRequest, context: { params: { taskId: string } }) {
  return withProviderCredentials(request, async () => {
    try { return ok(await queryImageTask(context.params.taskId)); }
    catch (error) { return handleRouteError(error); }
  });
}
