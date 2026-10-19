import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { logApiUsage } from "@/lib/monitor/api-usage";
import { getRequestProviderCredentials } from "@/lib/services/provider-runtime";
import type { AiMonitorContext } from "./provider-client";
import { normalizeOpenAiBaseUrl, resolvedTextSettings, textEndpoint, type TextSettings } from "./text-protocol";
import { nativeCompletion, nativeHeaders, nativeRequest, textHeaders } from "./native-text";
export type TextCall = TextSettings & {
  apiKey: string; baseUrl: string; model: string; system: string; input: string;
  images?: string[]; schema?: z.ZodType; timeoutMs: number; requestId?: string;
  monitor?: AiMonitorContext; signal?: AbortSignal; suppressUsageLog?: boolean; maxOutputTokens?: number;
};
export function buildTextRequest(input: TextCall) {
  const settings = resolvedTextSettings(input, input.model);
  const format = input.schema && settings.structuredOutputMode === "json_schema" ? zodResponseFormat(input.schema, "mxpage_workflow_result") : undefined;
  let system = input.system;
  if (input.schema && !format) system += `\nReturn only JSON matching this JSON Schema: ${JSON.stringify(z.toJSONSchema(input.schema, { unrepresentable: "any" }))}`;
  if (["anthropic_messages", "gemini_native"].includes(settings.textProtocol)) return nativeRequest(settings.textProtocol, {
    model: input.model, max_tokens: input.maxOutputTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: [{ type: "text", text: input.input }, ...(input.images || []).map(url => ({ type: "image_url", image_url: { url } }))] }],
    schema: format?.json_schema?.schema,
  });
  if (settings.textProtocol === "responses") return {
    model: input.model, store: false, stream: settings.responsesStream !== false, instructions: system,
    input: [{ role: "user", content: [{ type: "input_text", text: input.input }, ...(input.images || []).map(url => ({ type: "input_image", image_url: url, detail: "high" }))] }],
    ...(input.schema && settings.structuredOutputMode !== "prompt_json" ? { text: { format: format ? { type: "json_schema", ...format.json_schema } : { type: "json_object" } } } : {}),
  };
  return { model: input.model, ...(input.requestId ? { user: input.requestId } : {}),
    messages: [{ role: "system", content: system }, { role: "user", content: [{ type: "text", text: input.input }, ...(input.images || []).map(url => ({ type: "image_url", image_url: { url, detail: "high" } }))] }],
    ...(input.schema && settings.structuredOutputMode !== "prompt_json" ? { response_format: format || { type: "json_object" } } : {}),
  };
}
export function parseTextResponse(body: string, protocol: string) {
  let payload: any;
  if (/^\s*(?:event:|data:|:)/.test(body)) {
    let complete = false, text = "", finish: string | undefined;
    const nativeBlocks: any[] = [];
    for (const block of body.replace(/\r\n/g, "\n").split("\n\n")) {
      const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      if (data === "[DONE]") { complete = true; continue; }
      const event = JSON.parse(data);
      if (["error", "response.failed", "response.incomplete"].includes(event.type)) throw new Error(event.error?.message || event.response?.error?.message || `Provider ${event.type}`);
      if (event.type === "response.completed") payload = event.response;
      if (protocol === "chat_completions") {
        text += event.choices?.[0]?.delta?.content || "";
        finish = event.choices?.[0]?.finish_reason || finish;
        payload = { ...payload, ...event, usage: event.usage || payload?.usage };
      } else if (protocol === "anthropic_messages") {
        if (event.type === "message_start") payload = event.message;
        if (event.type === "content_block_start") nativeBlocks[event.index] = event.content_block;
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") nativeBlocks[event.index].text += event.delta.text;
        if (event.type === "message_delta") payload = { ...payload, ...event.delta, usage: { ...payload?.usage, ...event.usage } };
        if (event.type === "message_stop") complete = true;
      } else if (protocol === "gemini_native") {
        nativeBlocks.push(...event.candidates?.[0]?.content?.parts || []);
        finish = event.candidates?.[0]?.finishReason || finish;
        payload = { ...payload, ...event };
      }
    }
    if (protocol === "chat_completions") {
      if (!complete || !finish) throw new Error("Provider Chat stream interrupted; request outcome uncertain.");
      payload.choices = [{ message: { content: text }, finish_reason: finish }];
    } else if (protocol === "anthropic_messages") {
      if (!complete) throw new Error("Provider Messages stream interrupted; request outcome uncertain.");
      payload.content = nativeBlocks;
    } else if (protocol === "gemini_native") {
      if (!finish) throw new Error("Provider Gemini stream interrupted; request outcome uncertain.");
      payload.candidates = [{ finishReason: finish, content: { parts: nativeBlocks } }];
    }
    if (!payload) throw new Error("Provider stream interrupted before response.completed; request outcome uncertain.");
  } else payload = JSON.parse(body);
  if (protocol === "anthropic_messages" || protocol === "gemini_native") {
    const completion = nativeCompletion(payload, protocol);
    const text = completion.choices[0].message.content;
    if (!text.trim()) throw new Error("Provider returned empty text or refused the request.");
    return { text, payload: { ...payload, usage: completion.usage, model: completion.model } };
  }
  if (payload.error || (protocol === "responses" && payload.status && payload.status !== "completed")) throw new Error(payload.error?.message || `Provider response ${payload.status}`);
  if (protocol !== "responses" && ["length", "content_filter"].includes(payload.choices?.[0]?.finish_reason)) throw new Error("Provider returned incomplete text.");
  const text = protocol === "responses"
    ? (payload.output || []).flatMap((item: any) => item.content || []).filter((part: any) => part.type === "output_text").map((part: any) => part.text || "").join("") || payload.output_text || ""
    : payload.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("Provider returned empty text or refused the request.");
  return { text, payload };
}
export async function callText(input: TextCall) {
  const settings = resolvedTextSettings(input, input.model);
  const protocol = settings.textProtocol;
  const baseUrl = normalizeOpenAiBaseUrl(input.baseUrl);
  const endpoint = textEndpoint(input.baseUrl, protocol, input.model, settings.nativePathPrefix);
  const request = buildTextRequest(input);
  const started = Date.now();
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
  let response: Response | undefined, body = "", payload: any, failure: unknown;
  const costReservation = await getRequestProviderCredentials().agentBeforeDispatch?.();
  try {
    response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { ...(input.monitor?.operation === "provider_connection_probe" ? { ...nativeHeaders("anthropic_messages", input.apiKey), ...nativeHeaders("gemini_native", input.apiKey) } : {}), ...textHeaders(input.baseUrl, protocol, input.apiKey), "Content-Type": "application/json", Accept: protocol === "responses" ? "text/event-stream, application/json" : "application/json" }, body: JSON.stringify(request), signal });
    body = await response.text();
    if (!response.ok) {
      let upstream: { message?: string; code?: string; param?: string } = {};
      try { upstream = JSON.parse(body).error || {}; } catch {}
      throw Object.assign(new Error(upstream.message || body || `Provider HTTP ${response.status}`), {
        status: response.status, code: upstream.code, param: upstream.param, endpoint,
      });
    }
    const result = parseTextResponse(body, protocol);
    payload = result.payload;
    const parsed = input.schema ? input.schema.parse(JSON.parse(result.text)) : undefined;
    return { text: result.text, parsed };
  } catch (error) {
    failure = timeout.aborted && !input.signal?.aborted
      ? Object.assign(new Error(`模型响应等待超过 ${Math.ceil(input.timeoutMs / 1000)} 秒，尚未收到完整结果，当前步骤已暂停。请在任务详情中明确重试，可能产生额外费用。`), { name: "TimeoutError", code: "MODEL_RESPONSE_TIMEOUT" })
      : error;
    throw failure;
  }
  finally {
    if (costReservation) await getRequestProviderCredentials().agentAfterDispatch?.(costReservation, { model: input.model, responseBody: payload ? JSON.stringify(payload) : body, requestBody: request, statusCode: response?.status || 0, success: !failure });
    if (!input.suppressUsageLog) await logApiUsage({
      providerBaseUrl: baseUrl, endpoint, finalEndpoint: response?.url || endpoint, method: "POST", model: input.model,
      protocol, upstreamModel: typeof payload?.model === "string" ? payload.model : null,
      ...input.monitor, operation: input.monitor?.operation || "workflow_structured", category: "chat",
      statusCode: response?.status || 0, durationMs: Date.now() - started, success: !failure,
      requestBytes: Buffer.byteLength(JSON.stringify(request)), responseBytes: Buffer.byteLength(body), requestBody: request,
      responseBody: payload ? JSON.stringify(payload) : body, errorMessage: failure instanceof Error ? failure.message : null,
    }).catch(() => undefined);
  }
}
