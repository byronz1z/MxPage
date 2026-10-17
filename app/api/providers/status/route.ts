import { NextRequest } from "next/server";
import { getActiveProviderConfig } from "@/lib/services/provider-service";
import { getRequestProviderCredentials, providerCredentialFingerprint, resolveEffectiveBaseUrl, withProviderCredentials } from "@/lib/services/provider-runtime";
import { listApiUsageEntries } from "@/lib/monitor/api-usage";
import { resolveImageApiStatus } from "@/lib/monitor/provider-status";
import { handleRouteError, ok } from "@/lib/utils/route";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    return await withProviderCredentials(request, async () => {
      const provider = await getActiveProviderConfig();
      const credentials = getRequestProviderCredentials();
      const model = provider?.models.find(item => item.isDefaultDetailImage) ?? provider?.models.find(item => item.isDefaultHeroImage);
      const status = resolveImageApiStatus(await listApiUsageEntries(Number.MAX_SAFE_INTEGER), {
        model: model?.modelId ?? null,
        baseUrl: resolveEffectiveBaseUrl(credentials.baseUrl ?? provider?.baseUrl),
        fingerprint: providerCredentialFingerprint(credentials.apiKey),
      });
      return ok(status, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return handleRouteError(error); }
}
