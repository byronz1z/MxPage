import { NextRequest } from "next/server";
import { z } from "zod";
import { invokeStructured, normalizeOpenAiBaseUrl } from "@/lib/detail-runs/structured-model";
import { getProviderAdapter } from "@/lib/services/provider-service";
import { withProviderCredentials } from "@/lib/services/provider-runtime";
import { fail, handleRouteError, ok } from "@/lib/utils/route";
export async function POST(request: NextRequest) {
  let endpoint: string | undefined;
  try {
    return await withProviderCredentials(request, async () => {
      const { provider, apiKey } = await getProviderAdapter();
      const model = provider.models.find(item => item.isDefaultPlanning)
        ?? provider.models.find(item => item.isAvailable && item.capabilities?.text && item.capabilities?.structured_output);
      if (!model || !model.isAvailable) return fail("PLANNING_MODEL_REQUIRED", "请先保存配置并选择可用的规划模型。", null, 400);
      const baseUrl = normalizeOpenAiBaseUrl(provider.baseUrl);
      endpoint = `${baseUrl}/chat/completions`;
      await invokeStructured({
        apiKey, baseUrl, model: model.modelId,
        schema: z.object({ status: z.literal("OK") }),
        system: "This is a connection test. Return only the requested JSON object.",
        input: 'Return {"status":"OK"}.',
        timeoutMs: 15000, maxAttempts: 1,
        monitor: { operation: "provider_connection_probe" },
      });
      return ok({ baseUrl, endpoint, modelId: model.modelId, transport: "chat-completions / JSON Schema", compatible: true });
    });
  } catch (error) {
    if ((error as { status?: number })?.status === 404) {
      return fail("PROVIDER_ENDPOINT_NOT_FOUND", "模型服务返回 404：请检查已保存的 API 地址，以及规划模型是否在该服务中可用。", { endpoint }, 502);
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return fail("PROVIDER_STRUCTURED_OUTPUT_INVALID", "模型已响应，但结果不符合结构化输出要求。请检查该模型是否支持 JSON Schema。", { endpoint }, 502);
    }
    return handleRouteError(error);
  }
}
