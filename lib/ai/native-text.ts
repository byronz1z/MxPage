import type { TextProtocol } from "./text-protocol";
import { randomUUID } from "node:crypto";

type Message = { role: string; content: any; tool_calls?: any[]; tool_call_id?: string; nativeParts?: any[] };
export function nativeHeaders(protocol: TextProtocol, apiKey: string): Record<string, string> {
  return protocol === "anthropic_messages" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : protocol === "gemini_native" ? { "x-goog-api-key": apiKey } : {};
}
export function textHeaders(baseUrl: string, protocol: TextProtocol, apiKey: string): Record<string, string> {
  const host = new URL(baseUrl).hostname;
  const nativeOrigin = host === "api.anthropic.com" || host === "generativelanguage.googleapis.com";
  return { ...(nativeOrigin ? {} : { Authorization: `Bearer ${apiKey}` }), ...nativeHeaders(protocol, apiKey) };
}
function imagePart(url: string, protocol: TextProtocol) {
  const data = url.match(/^data:([^;,]+);base64,([\s\S]+)$/);
  if (protocol === "anthropic_messages") return { type: "image", source: data ? { type: "base64", media_type: data[1], data: data[2] } : { type: "url", url } };
  return data ? { inlineData: { mimeType: data[1], data: data[2] } } : { fileData: { mimeType: "image/png", fileUri: url } };
}
function parts(content: any, protocol: TextProtocol) {
  return (typeof content === "string" ? [{ type: "text", text: content }] : content || []).filter((part: any) => part.type !== "text" || part.text).map((part: any) => {
    if (part.type === "image_url") return imagePart(typeof part.image_url === "string" ? part.image_url : part.image_url.url, protocol);
    if (part.type === "text") return protocol === "gemini_native" ? { text: part.text } : part;
    throw new Error("此原生文本接口不支持当前消息内容类型。");
  });
}

// Shared by ordinary text/vision calls and the Agent's existing LangChain client.
// Translate one request/response only; this layer never negotiates or retries.
export function nativeRequest(protocol: TextProtocol, input: { model: string; messages: Message[]; tools?: any[]; tool_choice?: any; max_tokens?: number; schema?: unknown }) {
  const system = input.messages.filter(m => ["system", "developer"].includes(m.role)).map(m => typeof m.content === "string" ? m.content : m.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")).join("\n");
  const messages = input.messages.filter(m => !["system", "developer"].includes(m.role));
  const toolNames = new Map(messages.flatMap(m => (m.tool_calls || []).map((call: any) => [call.id, call.function.name] as [string, string])));
  const nativeToolIds = new Set(messages.flatMap(m => (m.nativeParts || []).map(p => p.functionCall?.id).filter(Boolean)));
  if (protocol === "anthropic_messages") {
    const nativeMessages: Array<{ role: string; content: any[] }> = [];
    for (const m of messages) {
      const content = m.role === "tool" ? [{ type: "tool_result", tool_use_id: m.tool_call_id, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }]
        : [...parts(m.content, protocol), ...(m.tool_calls || []).map(call => ({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || "{}") }))];
      const role = m.role === "assistant" ? "assistant" : "user";
      if (nativeMessages.at(-1)?.role === role) nativeMessages.at(-1)!.content.push(...content);
      else nativeMessages.push({ role, content });
    }
    return { model: input.model, ...(system ? { system } : {}), max_tokens: input.max_tokens ?? 4096, stream: false, messages: nativeMessages,
      ...(input.schema ? { output_config: { format: { type: "json_schema", schema: input.schema } } } : {}),
      ...(input.tools?.length ? { tools: input.tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })),
        tool_choice: input.tool_choice?.function?.name ? { type: "tool", name: input.tool_choice.function.name, disable_parallel_tool_use: true } : { type: input.tool_choice === "required" ? "any" : input.tool_choice === "none" ? "none" : "auto", disable_parallel_tool_use: true } } : {}),
    };
  }
  return { ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents: messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: m.role === "tool" ? [{ functionResponse: { ...(nativeToolIds.has(m.tool_call_id) ? { id: m.tool_call_id } : {}), name: toolNames.get(m.tool_call_id || "") || m.tool_call_id, response: { result: m.content } } }]
      : m.nativeParts || [...parts(m.content, protocol), ...(m.tool_calls || []).map(call => ({ functionCall: { name: call.function.name, args: JSON.parse(call.function.arguments || "{}") } }))],
  })), generationConfig: { ...(input.max_tokens ? { maxOutputTokens: input.max_tokens } : {}), ...(input.schema ? { responseMimeType: "application/json", responseJsonSchema: input.schema } : {}) },
    ...(input.tools?.length ? { tools: [{ functionDeclarations: input.tools.map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })) }],
      toolConfig: { functionCallingConfig: { mode: input.tool_choice === "required" || input.tool_choice?.function?.name ? "ANY" : input.tool_choice === "none" ? "NONE" : "AUTO", ...(input.tool_choice?.function?.name ? { allowedFunctionNames: [input.tool_choice.function.name] } : {}) } } } : {}),
  };
}

export function nativeCompletion(payload: any, protocol: TextProtocol) {
  if (payload.error) throw new Error(payload.error.message || "Native provider error");
  let content: string, toolCalls: any[], model: string | undefined, usage: any;
  if (protocol === "anthropic_messages") {
    if (!["end_turn", "stop_sequence", "tool_use"].includes(payload.stop_reason)) throw new Error("Provider returned incomplete Messages output.");
    content = (payload.content || []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
    toolCalls = (payload.content || []).filter((p: any) => p.type === "tool_use").map((p: any) => ({ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input) } }));
    model = payload.model; usage = { ...payload.usage, prompt_tokens: payload.usage?.input_tokens, completion_tokens: payload.usage?.output_tokens };
  } else {
    const candidate = payload.candidates?.[0];
    if (candidate?.finishReason !== "STOP") throw new Error("Provider returned incomplete or blocked Gemini output.");
    content = (candidate.content?.parts || []).filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("");
    toolCalls = (candidate.content?.parts || []).filter((p: any) => p.functionCall).map((p: any, index: number) => ({ id: p.functionCall.id || `call_${payload.responseId || randomUUID()}_${index}`, type: "function", function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } }));
    model = payload.modelVersion; usage = { prompt_tokens: payload.usageMetadata?.promptTokenCount, completion_tokens: payload.usageMetadata?.candidatesTokenCount, total_tokens: payload.usageMetadata?.totalTokenCount };
  }
  return { id: payload.id || payload.responseId || "native-response", object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? "tool_calls" : "stop" }], usage };
}
