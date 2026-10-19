import { NextRequest } from "next/server";
import { getActiveProviderConfig } from "@/lib/services/provider-service";
import { imageCapabilities } from "@/lib/ai/image-capabilities";
import { selectModel, type ModelRole } from "@/lib/ai/model-selection";
import { ok, handleRouteError } from "@/lib/utils/route";

export async function GET(request: NextRequest) {
  try {
    const provider = await getActiveProviderConfig();
    if (!provider) return ok([]);
    const roles = (request.nextUrl.searchParams.get("roles") || "hero,detail").split(",").filter(role => ["hero", "detail", "edit"].includes(role));
    const ids = [...new Set(roles.map(role => selectModel(provider.models, role as ModelRole)))];
    return ok(ids.map(id => imageCapabilities(provider.baseUrl, provider.models.find(m => m.modelId === id)!)));
  } catch (error) { return handleRouteError(error); }
}
