import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { randomUUID } from "crypto";
import { z } from "zod";
import { logApiUsage } from "@/lib/monitor/api-usage";
import type { AiMonitorContext } from "@/lib/ai/provider-client";

export type StructuredModelInput<T extends z.ZodType> = {
  apiKey: string;
  baseUrl: string;
  model: string;
  schema: T;
  system: string;
  input: string;
  images?: string[];
  timeoutMs: number;
  maxAttempts?: 1 | 2;
  requestId?: string;
  monitor?: AiMonitorContext;
};

export function normalizeOpenAiBaseUrl(baseUrl: string) {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  // Provider settings accept either the host root or an explicit OpenAI
  // version path. The OpenAI SDK does not add `/v1` when a custom baseURL is
  // supplied, while our compatible adapter does. Keep structured calls on
  // the same endpoint selection so a saved root URL does not become a 404.
  return /\/v\d+(?:beta)?$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

function imagePart(image: string) {
  return { type: "image_url" as const, image_url: { url: image, detail: "high" as const } };
}

function retryable(error: unknown) {
  const value = error as { status?: number; code?: string; cause?: { code?: string } };
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(value.status || 0) || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"].includes(value.code || value.cause?.code || "");
}

export async function invokeStructured<T extends z.ZodType>(input: StructuredModelInput<T>): Promise<z.infer<T>> {
  const baseUrl = normalizeOpenAiBaseUrl(input.baseUrl);
  const client = new OpenAI({ apiKey: input.apiKey, baseURL: baseUrl, maxRetries: 0, timeout: input.timeoutMs });
  // Use the SDK's strict-schema conversion (including nested required fields).
  // Local response validation can still apply defaults and tolerant repairs.
  const responseFormat = zodResponseFormat(input.schema, "mxpage_workflow_result");
  let lastError: unknown;
  let requestInput = input.input;
  let repairOnly = false;
  let invalidResult = "";
  const maxAttempts = input.maxAttempts ?? 2;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const started = Date.now();
    const requestId = input.requestId ?? randomUUID();
    const content: Array<{ type: "text"; text: string } | ReturnType<typeof imagePart>> = [{ type: "text", text: requestInput }];
    if (!repairOnly) for (const image of input.images || []) content.push(imagePart(image));
    const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: input.model, user: requestId,
      messages: [{ role: "system", content: input.system }, { role: "user", content }],
      response_format: responseFormat,
    };
    let response: OpenAI.Chat.Completions.ChatCompletion | undefined;
    const record = (success: boolean, error?: unknown) => logApiUsage({
      providerBaseUrl: baseUrl, endpoint: `${baseUrl}/chat/completions`, method: "POST", model: input.model,
      projectId: input.monitor?.projectId, sectionId: input.monitor?.sectionId, runId: input.monitor?.runId,
      operation: input.monitor?.operation || "workflow_structured", category: "chat",
      statusCode: response ? 200 : (error as { status?: number })?.status || 0,
      durationMs: Date.now() - started, success,
      requestBytes: Buffer.byteLength(JSON.stringify(request)), responseBytes: response ? Buffer.byteLength(JSON.stringify(response)) : 0,
      requestBody: request, responseBody: response ? JSON.stringify(response) : "",
      errorMessage: error instanceof Error ? error.message : null,
    }).catch(() => undefined);
    try {
      response = await client.chat.completions.create(request);
      const raw = response.choices[0]?.message?.content || "";
      invalidResult = raw;
      const parsed = input.schema.parse(JSON.parse(raw));
      await record(true);
      return parsed;
    } catch (error) {
      lastError = error;
      await record(false, error);
      const semantic = error instanceof SyntaxError || error instanceof z.ZodError;
      if (semantic && attempt + 1 < maxAttempts) {
        requestInput = JSON.stringify({ invalidResult, validationError: error instanceof Error ? error.message : String(error), instruction: "Return only a corrected JSON object matching the schema." });
        repairOnly = true;
        continue;
      }
      if (!retryable(error) || attempt + 1 >= maxAttempts) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("结构化模型请求失败");
}
