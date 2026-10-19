import { NextRequest } from "next/server";
import { sameOrigin, agentCredentials } from "@/lib/agent/http";
import { getAgentSettings } from "@/lib/agent/settings";
import { prepareAgentModel } from "@/lib/agent/model";
import { verifyNativeSearch } from "@/lib/agent/native-search";
import { runWithProviderCredentials } from "@/lib/services/provider-runtime";
import { ok, handleRouteError } from "@/lib/utils/route";
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request); const credentials = agentCredentials(request);
    return ok(await runWithProviderCredentials(credentials, async () => verifyNativeSearch(await prepareAgentModel(null, await getAgentSettings(), []), credentials.apiKey!)));
  } catch (error) { return handleRouteError(error); }
}
