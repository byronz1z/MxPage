export type TextProtocol = "chat_completions" | "responses" | "anthropic_messages" | "gemini_native";
export type NativePathPrefix = "anthropic" | "google";
// Documented CloseAI routes; explicit custom paths and other gateways are untouched.
// Only new compatibility checks opt in. Missing snapshot fields retain legacy routes.
export function nativePathPrefix(baseUrl: string, protocol: TextProtocol): NativePathPrefix | undefined {
  const url = new URL(baseUrl);
  if (url.origin !== "https://api.openai-proxy.org" || !/^\/(?:v1\/?)?$/.test(url.pathname)) return;
  return protocol === "anthropic_messages" ? "anthropic" : protocol === "gemini_native" ? "google" : undefined;
}
export const textProtocols: TextProtocol[] = ["responses", "chat_completions", "anthropic_messages", "gemini_native"];
export function textProtocolOrder(baseUrl: string): TextProtocol[] {
  const host = new URL(baseUrl).hostname;
  const preferred = host === "api.anthropic.com" ? "anthropic_messages" : host === "generativelanguage.googleapis.com" ? "gemini_native" : "responses";
  return [preferred, ...textProtocols.filter(protocol => protocol !== preferred)];
}
export type StructuredOutputMode = "json_schema" | "json_object" | "prompt_json";
export type ResolvedTextSettings = { textProtocol: TextProtocol; structuredOutputMode: StructuredOutputMode; responsesStream?: boolean; nativePathPrefix?: NativePathPrefix };
export type TextSettings = {
  textProtocol?: string; structuredOutputMode?: string; responsesStream?: boolean;
  nativePathPrefix?: NativePathPrefix;
  textModelSettings?: Record<string, ResolvedTextSettings>;
};
export function textSettings(value: TextSettings = {}) {
  return {
    textProtocol: value.textProtocol === "auto" ? "auto" as const : (textProtocols.includes(value.textProtocol as TextProtocol) ? value.textProtocol : "chat_completions") as TextProtocol,
    structuredOutputMode: (["json_object", "prompt_json"].includes(value.structuredOutputMode || "") ? value.structuredOutputMode : "json_schema") as StructuredOutputMode,
    ...(value.responsesStream === false ? { responsesStream: false } : {}),
    ...(value.nativePathPrefix ? { nativePathPrefix: value.nativePathPrefix } : {}),
    ...(value.textModelSettings ? { textModelSettings: value.textModelSettings } : {}),
  };
}
export function resolvedTextSettings(value: TextSettings, model: string): ResolvedTextSettings {
  const settings = textSettings(value);
  if (settings.textProtocol !== "auto") return settings as ResolvedTextSettings;
  const resolved = settings.textModelSettings?.[model];
  if (!resolved) throw new Error(`模型 ${model} 尚未完成自动连接检查，请重新探测服务后再试。`);
  return resolved;
}
export function normalizeOpenAiBaseUrl(value: string) {
  const base = value.trim().replace(/\/+$/, "");
  return /\/v\d+(?:beta)?$/i.test(base) ? base : `${base}/v1`;
}

export function textEndpoint(baseUrl: string, protocol: TextProtocol, model: string, prefix?: NativePathPrefix) {
  const routed = prefix && prefix === nativePathPrefix(baseUrl, protocol) ? `${new URL(baseUrl).origin}/${prefix}` : baseUrl;
  const base = normalizeOpenAiBaseUrl(routed);
  if (protocol === "gemini_native") return `${base.replace(/\/v\d+(?:beta)?$/, "/v1beta")}/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`;
  return `${base}/${protocol === "responses" ? "responses" : protocol === "anthropic_messages" ? "messages" : "chat/completions"}`;
}
