import { z } from "zod";
import { callText } from "./text-transport";
import { nativePathPrefix, textProtocolOrder, type ResolvedTextSettings, type TextProtocol } from "./text-protocol";

const probeImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAMUlEQVRIie3QMQ0AAAjAMPybBgm7+FoDSzb7bASKRcmiZFGyKFmULEoWJYuSRel90QGLVfSmL9cHVAAAAABJRU5ErkJggg==";

// Only definitive rejections can advance a lightweight probe. Never use this
// negotiation loop for business requests or after an uncertain/accepted response.
function rejectionKind(error: unknown): "endpoint" | "format" | "stream" | undefined {
  const e = error as { status?: number; code?: string; param?: string; message?: string };
  if (![400, 404, 405, 422, 501].includes(e.status || 0)) return;
  const message = `${e.code || ""} ${e.message || ""}`.toLowerCase();
  if (/model_not_found|model.*(?:not found|does not exist|not available)|模型.*(?:不存在|不可用)/.test(message)) return;
  if (e.status === 404 || e.status === 405) return "endpoint";
  const unsupported = /unsupported|not supported|does not support|not implemented|unknown (?:parameter|field)|unrecognized|supported values|不支持/.test(message);
  if (!unsupported) return;
  if (/stream/.test(`${e.param || ""} ${message}`)) return "stream";
  if (/response_format|text\.format|json_schema|json_object|structured.output|output_config|responseJsonSchema|responseSchema|responseMimeType/i.test(`${e.param || ""} ${message}`)) return "format";
  if (/\bresponses\b|chat[\s_/]completions|\bmessages\b|generatecontent/.test(message)) return "endpoint";
}

export async function detectTextCompatibility(input: { baseUrl: string; apiKey: string; model: string; vision?: boolean }): Promise<ResolvedTextSettings> {
  const protocols = textProtocolOrder(input.baseUrl);
  const settingsFor = (protocol: TextProtocol): ResolvedTextSettings => {
    const prefix = nativePathPrefix(input.baseUrl, protocol);
    return { textProtocol: protocol, structuredOutputMode: "json_schema", ...(prefix ? { nativePathPrefix: prefix } : {}) };
  };
  let settings = settingsFor(protocols[0]);
  const signal = AbortSignal.timeout(45000);
  // Bounded lightweight checks only. Existing cached configurations bypass this.
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await callText({
        ...input, ...settings, signal, timeoutMs: 15000, maxOutputTokens: 128,
        system: "This is a connection test. Return only the requested JSON object.",
        input: 'Return {"status":"OK"}.', schema: z.object({ status: z.literal("OK") }),
        images: input.vision ? [probeImage] : undefined,
        monitor: { operation: "provider_connection_probe" },
      });
      return settings;
    } catch (error) {
      const kind = rejectionKind(error);
      if (kind === "stream" && settings.textProtocol === "responses" && settings.responsesStream !== false) {
        settings = { ...settings, responsesStream: false };
      } else if (kind === "format" && settings.structuredOutputMode !== "prompt_json") {
        settings = { ...settings, structuredOutputMode: settings.structuredOutputMode === "json_schema" && ["responses", "chat_completions"].includes(settings.textProtocol) ? "json_object" : "prompt_json" };
      } else if ((kind === "endpoint" || kind === "format") && settings.textProtocol !== protocols.at(-1)) {
        settings = settingsFor(protocols[protocols.indexOf(settings.textProtocol) + 1]);
      } else throw error;
    }
  }
  throw new Error("自动连接检查未找到可用的接口格式，请确认服务端已开放文本接口。");
}
