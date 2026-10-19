import { NextRequest } from "next/server";
import { z } from "zod";
import { normalizeOpenAiBaseUrl, resolvedTextSettings, textEndpoint } from "@/lib/ai/text-protocol";
import { getProviderAdapter } from "@/lib/services/provider-service";
import { withProviderCredentials } from "@/lib/services/provider-runtime";
import { fail, handleRouteError, ok } from "@/lib/utils/route";
export async function POST(request: NextRequest) {
  let endpoint: string | undefined;
  try {
    return await withProviderCredentials(request, async () => {
      const { provider } = await getProviderAdapter(undefined, undefined, { forceCompatibilityCheck: true });
      const model = provider.models.find(item => item.isDefaultPlanning);
      if (!model || !model.isAvailable) return fail("PLANNING_MODEL_REQUIRED", "请先保存配置并选择可用的规划模型。", null, 400);
      const baseUrl = normalizeOpenAiBaseUrl(provider.baseUrl);
      const settings = resolvedTextSettings(provider, model.modelId);
      endpoint = textEndpoint(baseUrl, settings.textProtocol, model.modelId, settings.nativePathPrefix);
      return ok({ baseUrl, endpoint, modelId: model.modelId, transport: `${settings.textProtocol} / ${settings.structuredOutputMode}`, compatible: true, models: provider.textModelSettings });
    });
  } catch (error) {
    endpoint ??= (error as { endpoint?: string })?.endpoint;
    if ((error as { status?: number })?.status === 404) {
      return fail("PROVIDER_ENDPOINT_NOT_FOUND", "模型服务返回 404：请检查已保存的 API 地址，以及规划模型是否在该服务中可用。", { endpoint }, 502);
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return fail("PROVIDER_STRUCTURED_OUTPUT_INVALID", "模型已响应，但结果不符合任务要求。请使用支持结构化输出的模型后重新探测。", { endpoint }, 502);
    }
    return handleRouteError(error);
  }
}
