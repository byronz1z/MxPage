import { NextRequest } from "next/server";
import { saveProviderDefaults } from "@/lib/services/provider-defaults";
import { ok, handleRouteError } from "@/lib/utils/route";
export async function PATCH(request: NextRequest, context: { params: { id: string } }) {
  try { return ok(await saveProviderDefaults(context.params.id, await request.json())); }
  catch (error) { return handleRouteError(error); }
}
