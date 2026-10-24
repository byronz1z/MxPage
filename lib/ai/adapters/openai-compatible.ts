import { callText } from "@/lib/ai/text-transport";
import { getRequestProviderCredentials } from "@/lib/services/provider-runtime";
import { textEndpoint, normalizeOpenAiBaseUrl, type TextSettings } from "@/lib/ai/text-protocol";
import { resolveImageModel, resolveImageProtocol, type ImageSettings } from "@/lib/ai/image-protocol";
import { generateEvoLinkImage } from "./evolink-image";
import { z } from "zod";

import type {
  AiMonitorContext,
  ChatMessage,
  ImageEditRequest,
  ImageGenerationRequest,
  ImageGenerationResult,
  ProviderAdapter,
  StructuredRequest,
  TextRequest,
} from "@/lib/ai/provider-client";
import { inferCategory, logApiUsage } from "@/lib/monitor/api-usage";

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

function hasOpenAiVersionSuffix(baseUrl: string) {
  return /\/v\d+(?:beta)?$/i.test(normalizeBaseUrl(baseUrl));
}

function buildOpenAiCompatibleUrls(baseUrl: string, path: string) {
  const normalized = normalizeBaseUrl(baseUrl);
  const urls = [];

  if (!hasOpenAiVersionSuffix(normalized)) {
    urls.push(`${normalized}/v1${path}`);
  }

  urls.push(`${normalized}${path}`);

  return [...new Set(urls)];
}

function baseUrlFromRequestUrl(url: string, path: string) {
  return url.endsWith(path) ? normalizeBaseUrl(url.slice(0, -path.length)) : null;
}

function shouldRetryWithVersionedBase(status: number, body: string) {
  return status === 404 || status === 405 || /not found|no route|cannot\s+(get|post)|unsupported endpoint/i.test(body);
}

function isGeminiImageModel(model: string) {
  return /gemini.*image|nano-banana|banana/i.test(model);
}

function isOpenAiGptImageModel(model: string) {
  return /(?:^|[-_\s])gpt[-_\s]?image(?:[-_\s]?(?:\d+(?:\.\d+)?|mini))?|chatgpt-image/i.test(model);
}

function deriveGoogleBaseUrl(baseUrl: string) {
  const normalized = normalizeBaseUrl(baseUrl);

  if (/\/google(?:\/.*)?$/i.test(normalized)) {
    return normalized.replace(/\/(v1|v1beta)$/i, "");
  }

  if (/\/v1(?:beta)?$/i.test(normalized)) {
    return normalized.replace(/\/v1(?:beta)?$/i, "/google");
  }

  return `${normalized}/google`;
}

function sizeToAspectRatio(size?: string) {
  switch (size) {
    case "3:4":
      return "3:4";
    case "9:16":
      return "9:16";
    case "1024x1536":
      return "2:3";
    case "1536x1024":
      return "3:2";
    case "1024x1024":
      return "1:1";
    default:
      return "9:16";
  }
}

function resolveAspectRatio(input: { aspectRatio?: "1:1" | "3:4" | "9:16"; size?: string }) {
  if (input.aspectRatio) {
    return input.aspectRatio;
  }

  return sizeToAspectRatio(input.size);
}

function resolveOpenAiSize(input: { model?: string; aspectRatio?: "1:1" | "3:4" | "9:16"; size?: string }) {
  if (input.size) {
    return input.size;
  }

  if (input.aspectRatio === "1:1") {
    return "1024x1024";
  }

  // GPT Image 2/2.5 support dimensions divisible by 16; keep the requested ratio.
  // Earlier models retain their supported portrait preset.
  if (/(?:^|\/)gpt-image-2(?:[.-]|$)/i.test(input.model ?? "")) {
    if (input.aspectRatio === "3:4") return "1152x1536";
    if (input.aspectRatio === "9:16") return "864x1536";
  }

  if (input.aspectRatio === "3:4" || input.aspectRatio === "9:16") {
    return "1024x1536";
  }

  return "1024x1536";
}

function dataUrlToInlineData(dataUrl: string) {
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid base64 image data URL.");
  }

  return {
    mimeType: match[1],
    data: match[2],
  };
}

function dataUrlToBlob(dataUrl: string) {
  const inlineData = dataUrlToInlineData(dataUrl);
  return new Blob([Buffer.from(inlineData.data, "base64")], {
    type: inlineData.mimeType,
  });
}

function extractTextContent(payload: unknown) {
  const message = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;

  if (typeof message === "string") {
    return message;
  }

  if (Array.isArray(message)) {
    return message
      .map((entry) =>
        typeof entry === "object" && entry && "text" in entry ? String(entry.text ?? "") : "",
      )
      .join("\n")
      .trim();
  }

  return "";
}

function parseJsonBlock(raw: string) {
  const direct = raw.trim();
  if (direct.startsWith("{") || direct.startsWith("[")) {
    return direct;
  }

  const fencedMatch = direct.match(/```json([\s\S]*?)```/i) || direct.match(/```([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = direct.indexOf("{");
  const lastBrace = direct.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return direct.slice(firstBrace, lastBrace + 1);
  }

  return direct;
}

function tryParseJsonBody(body: RequestInit["body"]) {
  if (typeof body !== "string") {
    return null;
  }

  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tryReadBodyModel(body: RequestInit["body"]) {
  const jsonPayload = tryParseJsonBody(body);
  if (typeof jsonPayload?.model === "string") {
    return jsonPayload.model;
  }

  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const model = body.get("model");
    return typeof model === "string" ? model : null;
  }

  return null;
}

function inferModelFromEndpoint(url: string, bodyPayload?: Record<string, unknown> | null) {
  if (typeof bodyPayload?.model === "string") {
    return bodyPayload.model;
  }

  const match = url.match(/\/models\/([^:\/]+):generateContent/i);
  return match?.[1] ?? null;
}

function readMonitorContext(input?: AiMonitorContext) {
  return {
    projectId: input?.projectId ?? null,
    sectionId: input?.sectionId ?? null,
    runId: input?.runId ?? null,
    operation: input?.operation ?? null,
  };
}

function tryParseStructuredPayload<T>(raw: string, schema: z.ZodType<T>) {
  const parsedJson = JSON.parse(parseJsonBlock(raw));
  return schema.parse(parsedJson);
}

function isUnsupportedTemperatureError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /temperature/i.test(error.message) && /unsupported|does not support|only the default|unsupported_value/i.test(error.message);
}

function omitTemperature<T extends Record<string, unknown>>(body: T) {
  const { temperature: _temperature, ...rest } = body;
  return rest;
}

function shouldOmitTemperatureForModel(model: string) {
  return /^gpt-5/i.test(model);
}

function withOptionalTemperature<T extends Record<string, unknown>>(model: string, body: T, temperature: number) {
  return shouldOmitTemperatureForModel(model) ? body : { ...body, temperature };
}

function buildMessages(input: TextRequest | StructuredRequest<unknown>): ChatMessage[] {
  const content: ChatMessage["content"] =
    input.images?.length
      ? [
          { type: "text", text: input.userPrompt },
          ...input.images.map((url) => ({
            type: "image_url" as const,
            image_url: { url },
          })),
        ]
      : input.userPrompt;

  const messages: ChatMessage[] = [];
  if (input.systemPrompt) {
    messages.push({ role: "system", content: input.systemPrompt });
  }
  messages.push({ role: "user", content });
  return messages;
}

function extractImageResult(payload: {
  data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
}): ImageGenerationResult {
  const result = payload.data?.[0];
  if (!result) {
    throw new Error("Image generation returned no data.");
  }

  return {
    url: result.url ?? null,
    b64Json: result.b64_json ?? null,
    revisedPrompt: result.revised_prompt ?? null,
  };
}

function extractGoogleImageResult(payload: any): ImageGenerationResult {
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];

  for (const part of parts) {
    const inlineData = part?.inlineData ?? part?.inline_data ?? null;
    if (inlineData?.data) {
      return {
        url: null,
        b64Json: String(inlineData.data),
        revisedPrompt: typeof part?.text === "string" ? part.text : null,
      };
    }
  }

  throw new Error("Google image generation returned no inline image data.");
}

function toImageRefs(images: string[]) {
  return images.map((imageUrl) => ({
    image_url: imageUrl,
  }));
}

function toMaskRef(mask: string) {
  return {
    image_url: mask,
  };
}

function classifyProbeResult(status: number, body: string) {
  if (/model.+does not exist|does not exist|invalid_value.+model|param.+model|unsupported model/i.test(body)) {
    return "unavailable" as const;
  }
  if (/no available endpoint|not found|404/i.test(body) || status === 404) {
    return "unavailable" as const;
  }
  if (status === 429 || /限流|rate limit/i.test(body)) {
    return "rate_limited" as const;
  }
  if (/invalid value.+size|supported values|images\[0\]|unknown parameter|invalid type|aspectratio/i.test(body)) {
    return "available" as const;
  }
  if (status === 401 || status === 403) {
    return "unknown" as const;
  }
  if (status === 400 || status === 200) {
    return "available" as const;
  }
  return "unknown" as const;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  private preferredBaseUrl: string | null = null;

  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly settings: TextSettings & ImageSettings = {}) {}

  private buildRequestUrls(path: string) {
    const urls = buildOpenAiCompatibleUrls(this.baseUrl, path);
    if (!this.preferredBaseUrl) {
      return urls;
    }

    const preferredUrl = `${this.preferredBaseUrl}${path}`;
    return [preferredUrl, ...urls.filter((url) => url !== preferredUrl)];
  }

  private rememberCompatibleBaseUrl(url: string, path: string, response: { ok: boolean; status: number; body: string }) {
    if (!response.ok && shouldRetryWithVersionedBase(response.status, response.body)) {
      return;
    }

    this.preferredBaseUrl = baseUrlFromRequestUrl(url, path) ?? this.preferredBaseUrl;
  }

  private async fetchRaw(
    url: string,
    init?: RequestInit,
    extraHeaders?: Record<string, string>,
    timeoutMs = 15000,
    monitor?: AiMonitorContext,
    options?: {
      suppressUsageLog?: boolean;
      protocol?: string;
      skipModelDispatch?: boolean;
      model?: string;
    },
  ) {
    const costReservation = init?.method === "POST" && !options?.skipModelDispatch ? await getRequestProviderCredentials().agentBeforeDispatch?.() : undefined;
    const controller = new AbortController();
    const externalSignal = init?.signal;
    const abortFromExternalSignal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) {
      abortFromExternalSignal();
    } else {
      externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
    }
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    const method = init?.method ?? "GET";
    const bodyPayload = tryParseJsonBody(init?.body);
    const model = options?.model ?? tryReadBodyModel(init?.body) ?? inferModelFromEndpoint(url, bodyPayload);
    const category = inferCategory(url, bodyPayload);
    const requestBytes = typeof init?.body === "string" ? Buffer.byteLength(init.body) : 0;

    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          ...(typeof FormData !== "undefined" && init?.body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
          ...(["api.anthropic.com", "generativelanguage.googleapis.com"].includes(new URL(url).hostname) ? {} : { Authorization: `Bearer ${this.apiKey}` }),
          ...(extraHeaders ?? {}),
          ...(init?.headers ?? {}),
        },
        cache: "no-store",
        signal: controller.signal,
      });

      const body = await response.text();
      if (costReservation) await getRequestProviderCredentials().agentAfterDispatch?.(costReservation, { model, category, requestBody: init?.body, responseBody: body, statusCode: response.status, success: response.ok });
      const upstreamModel = tryParseJsonBody(body)?.model;
      if (!options?.suppressUsageLog) {
        await logApiUsage({
          providerBaseUrl: normalizeBaseUrl(this.baseUrl),
          endpoint: url,
          method,
          model,
          protocol: options?.protocol,
          upstreamModel: typeof upstreamModel === "string" ? upstreamModel : undefined,
          ...readMonitorContext(monitor),
          category,
          statusCode: response.status,
          durationMs: Date.now() - startedAt,
          success: response.ok,
          requestBytes,
          responseBytes: Buffer.byteLength(body),
          responseBody: body,
          requestBody: init?.body,
          errorMessage: response.ok ? null : body.slice(0, 1000),
        });
      }
      return {
        ok: response.ok,
        status: response.status,
        body,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (costReservation) await getRequestProviderCredentials().agentAfterDispatch?.(costReservation, { model, responseBody: "", statusCode: 0, success: false });
      if (!options?.suppressUsageLog) {
        await logApiUsage({
          providerBaseUrl: normalizeBaseUrl(this.baseUrl),
          endpoint: url,
          method,
          model,
          protocol: options?.protocol,
          ...readMonitorContext(monitor),
          category,
          statusCode: 0,
          durationMs: Date.now() - startedAt,
          success: false,
          requestBytes,
          responseBytes: 0,
          responseBody: "",
          requestBody: init?.body,
          errorMessage: error instanceof Error ? error.message : "Unknown request failure",
        });
      }

      if ((error as Error)?.name === "AbortError") {
        if (externalSignal?.aborted) {
          throw new Error("Task canceled.");
        }
        throw new Error(`Provider request timed out after ${timeoutMs}ms: ${url}`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    }
  }

  private async requestRaw(
    path: string,
    init?: RequestInit,
    timeoutMs?: number,
    monitor?: AiMonitorContext,
    options?: {
      suppressUsageLog?: boolean;
      singleAttempt?: boolean;
    },
  ) {
    const urls = this.buildRequestUrls(path);
    if (urls.length === 1 || options?.suppressUsageLog || options?.singleAttempt) {
      const response = await this.fetchRaw(urls[0], init, undefined, timeoutMs, monitor, options);
      this.rememberCompatibleBaseUrl(urls[0], path, response);
      return response;
    }

    const startedAt = Date.now();
    const method = init?.method ?? "GET";
    const bodyPayload = tryParseJsonBody(init?.body);
    const requestBytes = typeof init?.body === "string" ? Buffer.byteLength(init.body) : 0;
    const collapsedAttempts: Array<{
      endpoint: string;
      statusCode: number;
      success: boolean;
      errorMessage: string | null;
    }> = [];
    let lastResponse: Awaited<ReturnType<typeof this.fetchRaw>> | null = null;
    let lastUrl = urls[0];
    let lastError: unknown = null;

    for (const url of urls) {
      try {
        const response = await this.fetchRaw(
          url,
          init,
          undefined,
          timeoutMs,
          monitor,
          {
            ...options,
            suppressUsageLog: true,
          },
        );
        lastResponse = response;
        lastUrl = url;
        collapsedAttempts.push({
          endpoint: url,
          statusCode: response.status,
          success: response.ok,
          errorMessage: response.ok ? null : response.body.slice(0, 1000),
        });

        this.rememberCompatibleBaseUrl(url, path, response);

        if (response.ok || !shouldRetryWithVersionedBase(response.status, response.body)) {
          break;
        }
      } catch (error) {
        lastError = error;
        lastUrl = url;
        collapsedAttempts.push({
          endpoint: url,
          statusCode: 0,
          success: false,
          errorMessage: error instanceof Error ? error.message : "Unknown request failure",
        });
        break;
      }
    }

    const finalResponse =
      lastError && (!lastResponse || shouldRetryWithVersionedBase(lastResponse.status, lastResponse.body))
        ? {
            ok: false,
            status: 0,
            body: lastError instanceof Error ? lastError.message : "Unknown request failure",
            durationMs: Date.now() - startedAt,
          }
        : lastResponse ?? {
        ok: false,
        status: 0,
        body: "",
        durationMs: Date.now() - startedAt,
      };
    const retrySummary =
      collapsedAttempts.length > 1
        ? collapsedAttempts
            .filter((item) => !item.success)
            .map((item) => `${item.endpoint} -> ${item.statusCode}: ${item.errorMessage ?? "Unknown error"}`)
            .join(" | ")
        : null;

    await logApiUsage({
      providerBaseUrl: normalizeBaseUrl(this.baseUrl),
      endpoint: urls[0],
      finalEndpoint: lastUrl,
      method,
      model: tryReadBodyModel(init?.body) ?? inferModelFromEndpoint(lastUrl, bodyPayload),
      ...readMonitorContext(monitor),
      category: inferCategory(lastUrl, bodyPayload),
      statusCode: finalResponse.status,
      durationMs: Date.now() - startedAt,
      success: finalResponse.ok,
      requestBytes,
      responseBytes: Buffer.byteLength(finalResponse.body),
      responseBody: finalResponse.body,
      requestBody: init?.body,
      attemptCount: collapsedAttempts.length,
      retrySummary,
      collapsedAttempts,
      errorMessage: finalResponse.ok
        ? null
        : finalResponse.body.slice(0, 1000) ||
          (lastError instanceof Error ? lastError.message : "Unknown request failure"),
    });

    if (!lastResponse && lastError) {
      if ((lastError as Error)?.name === "AbortError") {
        throw new Error(`Provider request timed out after ${timeoutMs ?? 15000}ms: ${lastUrl}`);
      }
      throw lastError;
    }

    return finalResponse;
  }

  private async requestJson<T>(
    path: string,
    init?: RequestInit,
    timeoutMs?: number,
    monitor?: AiMonitorContext,
    options?: { suppressUsageLog?: boolean },
  ) {
    const response = await this.requestRaw(path, init, timeoutMs, monitor, options);

    if (!response.ok) {
      throw new Error(`Provider request failed (${response.status}): ${response.body}`);
    }

    return JSON.parse(response.body) as T;
  }

  private async requestGoogleJson<T>(
    path: string,
    body: unknown,
    timeoutMs = 45000,
    monitor?: AiMonitorContext,
    signal?: AbortSignal,
    native = false,
  ) {
    const base = deriveGoogleBaseUrl(this.baseUrl);
    // Native Gemini image generation uses one endpoint and never resends on failure.
    const version = /\/v1$/i.test(normalizeBaseUrl(this.baseUrl)) ? "v1" : "v1beta";
    const attempts = [native ? `${normalizeOpenAiBaseUrl(this.baseUrl).replace(/\/v\d+(?:beta)?$/, "/v1beta")}${path}` : `${base}/${version}${path}`];
    const collapsedAttempts: Array<{
      endpoint: string;
      statusCode: number;
      success: boolean;
      errorMessage: string | null;
    }> = [];
    let finalSuccess: {
      body: string;
      url: string;
      status: number;
      durationMs: number;
    } | null = null;

    for (const url of attempts) {
      try {
        const response = await this.fetchRaw(
          url,
          {
            method: "POST",
            body: JSON.stringify(body),
            signal,
          },
          {
            "x-goog-api-key": this.apiKey,
          },
          timeoutMs,
          monitor,
          {
            suppressUsageLog: true,
          },
        );

        collapsedAttempts.push({
          endpoint: url,
          statusCode: response.status,
          success: response.ok,
          errorMessage: response.ok ? null : response.body.slice(0, 1000),
        });

        if (response.ok) {
          finalSuccess = {
            body: response.body,
            url,
            status: response.status,
            durationMs: response.durationMs,
          };
          break;
        }
      } catch (error) {
        collapsedAttempts.push({
          endpoint: url,
          statusCode: 0,
          success: false,
          errorMessage: error instanceof Error ? error.message : "Unknown Google protocol error",
        });
      }
    }

    const requestBody = JSON.stringify(body);
    const model = typeof (body as Record<string, unknown>)?.model === "string" ? String((body as Record<string, unknown>).model) : inferModelFromEndpoint(path);
    const retrySummary =
      collapsedAttempts.length > 1
        ? collapsedAttempts
            .filter((item) => !item.success)
            .map((item) => `${item.statusCode} ${item.endpoint}`)
            .join(" | ")
        : null;

    if (finalSuccess) {
      await logApiUsage({
        providerBaseUrl: normalizeBaseUrl(this.baseUrl),
        endpoint: finalSuccess.url,
        finalEndpoint: finalSuccess.url,
        method: "POST",
        protocol: native ? "gemini_native" : "gemini_proxy",
        model,
        ...readMonitorContext(monitor),
        category: inferCategory(finalSuccess.url, typeof body === "object" ? (body as Record<string, unknown>) : null),
        statusCode: finalSuccess.status,
        durationMs: collapsedAttempts.reduce((sum, item, index) => sum + (index === collapsedAttempts.length - 1 ? finalSuccess.durationMs : 0), 0) || finalSuccess.durationMs,
        success: true,
        requestBytes: Buffer.byteLength(requestBody),
        responseBytes: Buffer.byteLength(finalSuccess.body),
        responseBody: finalSuccess.body,
        attemptCount: collapsedAttempts.length,
        retrySummary,
        collapsedAttempts,
        errorMessage: null,
      });

      return JSON.parse(finalSuccess.body) as T;
    }

    const errorSummary = collapsedAttempts
      .map((item) => `${item.endpoint} -> ${item.statusCode}: ${item.errorMessage ?? "Unknown error"}`)
      .join(" | ");

    await logApiUsage({
      providerBaseUrl: normalizeBaseUrl(this.baseUrl),
      endpoint: attempts[attempts.length - 1] ?? `${base}/v1${path}`,
      finalEndpoint: attempts[attempts.length - 1] ?? `${base}/v1${path}`,
      method: "POST",
      protocol: native ? "gemini_native" : "gemini_proxy",
      model,
      ...readMonitorContext(monitor),
      category: inferCategory(`${base}/v1${path}`, typeof body === "object" ? (body as Record<string, unknown>) : null),
      statusCode: collapsedAttempts[collapsedAttempts.length - 1]?.statusCode ?? 0,
      durationMs: 0,
      success: false,
      requestBytes: Buffer.byteLength(requestBody),
      responseBytes: 0,
      responseBody: errorSummary,
      attemptCount: collapsedAttempts.length,
      retrySummary,
      collapsedAttempts,
      errorMessage: errorSummary,
    });

    throw new Error(`Google protocol request failed: ${errorSummary}`);
  }

  private async probeGeminiImageSupport(model: string) {
    const tinyTransparentPixel =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9pW4xQAAAABJRU5ErkJggg==";

    const generationBody = {
      contents: [
        {
          role: "user",
          parts: [{ text: "Generate a simple colored square." }],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        candidateCount: 1,
        imageConfig: {
          aspectRatio: "1:1",
        },
      },
    };

    const editBody = {
      contents: [
        {
          role: "user",
          parts: [
            { text: "Edit this image slightly and keep the same subject." },
            { inlineData: dataUrlToInlineData(tinyTransparentPixel) },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        candidateCount: 1,
        imageConfig: {
          aspectRatio: "1:1",
        },
      },
    };

    const generationProbe = await this.fetchRaw(
      `${deriveGoogleBaseUrl(this.baseUrl)}/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        body: JSON.stringify(generationBody),
      },
      {
        "x-goog-api-key": this.apiKey,
      },
      5000,
      undefined,
      {
        suppressUsageLog: true,
      },
    );

    const editProbe = await this.fetchRaw(
      `${deriveGoogleBaseUrl(this.baseUrl)}/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        body: JSON.stringify(editBody),
      },
      {
        "x-goog-api-key": this.apiKey,
      },
      5000,
      undefined,
      {
        suppressUsageLog: true,
      },
    );

    return {
      imageGeneration: classifyProbeResult(generationProbe.status, generationProbe.body),
      imageEdit: classifyProbeResult(editProbe.status, editProbe.body),
      note: [generationProbe.body, editProbe.body].filter(Boolean).join(" | ").slice(0, 1000),
    };
  }

  private async probeOpenAiGptImageSupport(model: string) {
    const tinyTransparentPixel =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9pW4xQAAAABJRU5ErkJggg==";

    const generationProbe = await this.requestRaw(
      "/images/generations",
      {
        method: "POST",
        body: JSON.stringify({
          model,
          prompt: "probe",
          size: "1024x1024",
        }),
      },
      5000,
      undefined,
      {
        suppressUsageLog: true,
      },
    );

    let editProbe;
    try {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", "probe");
      form.append("size", "1024x1024");
      form.append("image", dataUrlToBlob(tinyTransparentPixel), "probe.png");

      editProbe = await this.requestRaw(
        "/images/edits",
        {
          method: "POST",
          body: form,
        },
        5000,
        undefined,
        {
          suppressUsageLog: true,
        },
      );
    } catch (error) {
      editProbe = {
        status: 0,
        body: error instanceof Error ? error.message : "Unknown multipart image edit probe error",
      };
    }

    return {
      imageGeneration: classifyProbeResult(generationProbe.status, generationProbe.body),
      imageEdit: classifyProbeResult(editProbe.status, editProbe.body),
      note: [generationProbe.body, editProbe.body].filter(Boolean).join(" | ").slice(0, 1000),
    };
  }

  async probeImageEndpointSupport(model: string) {
    return {
      imageGeneration: "unknown" as const,
      imageEdit: "unknown" as const,
      note: `已跳过 ${model} 的真实图像接口探测，避免在校验/发现阶段消耗图像额度。`,
    };
  }

  async testConnection() {
    await this.listModels();
    return {
      ok: true,
      providerLabel: normalizeBaseUrl(this.baseUrl),
    };
  }

  async listModels() {
    // Read-only discovery may try another documented endpoint after 404/405.
    // Auth errors, timeouts and accepted responses never trigger a fallback.
    // Only the selected protocol's credentials are sent: mixing Anthropic/Gemini
    // headers into an OpenAI-compatible request makes gateways switch their
    // catalogue (and sometimes rewrite model IDs), so protocol stays explicit.
    const configured = this.settings.textProtocol;
    const host = new URL(this.baseUrl).hostname;
    const protocol = configured && configured !== "auto"
      ? configured
      : host === "api.anthropic.com" ? "anthropic_messages"
        : host === "generativelanguage.googleapis.com" ? "gemini_native" : configured;
    const headers: Record<string, string> = protocol === "anthropic_messages"
      ? { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" }
      : protocol === "gemini_native"
        ? { "x-goog-api-key": this.apiKey }
        : { Authorization: `Bearer ${this.apiKey}` };
    const nativeUrl = `${normalizeOpenAiBaseUrl(this.baseUrl).replace(/\/v\d+(?:beta)?$/, "/v1beta")}/models`;
    const nativeOrigin = new URL(this.baseUrl).hostname === "generativelanguage.googleapis.com";
    let response = nativeOrigin ? await this.fetchRaw(nativeUrl, { method: "GET", headers }) : await this.requestRaw("/models", { method: "GET", headers });
    if (!nativeOrigin && [404, 405].includes(response.status)) response = await this.fetchRaw(nativeUrl, { method: "GET", headers });
    if (!response.ok) throw Object.assign(new Error(`Provider model discovery failed (${response.status})`), {
      status: response.status,
      ...([401, 403].includes(response.status) ? { code: "PROVIDER_DISCOVERY_AUTH_ERROR" } : {}),
    });
    const payload = JSON.parse(response.body);
    const items: Array<Record<string, any>> = payload.data ?? payload.models;
    if (!Array.isArray(items)) throw new Error("模型列表格式无法识别，请检查服务地址。");
    if (items.some(item => typeof (item.id ?? item.name) !== "string" || !(item.id ?? item.name))) throw new Error("模型列表包含无效 ID。");
    return items.map((item) => ({
      id: String(item.id ?? item.name),
      label: item.label ?? item.displayName ?? item.name ?? item.id,
      type: typeof item.type === "string" ? item.type : typeof item.category === "string" ? item.category : null,
      category: typeof item.category === "string" ? item.category : typeof item.type === "string" ? item.type : null,
      // Recognized advertised endpoints only. Never accept arbitrary endpoint URLs.
      imageProtocol: (item.supported_endpoint_types?.includes("image-generation") || item.supported_endpoints?.includes("/images/generations")) ? "openai_images" as const
        : item.supported_endpoints?.includes("generateContent") && (item.output_modalities?.includes("image") || item.type === "image") ? "gemini_native" as const : undefined,
      modalities: Array.isArray(item.modalities)
        ? item.modalities.filter((entry): entry is string => typeof entry === "string")
        : Array.isArray(item.capabilities)
          ? item.capabilities.filter((entry): entry is string => typeof entry === "string")
          : item.supportedGenerationMethods?.includes("generateContent") ? ["text", "vision"] : undefined,
    }));
  }

  async generateText(input: TextRequest) {
    const result = await callText({ ...this.settings, apiKey: this.apiKey, baseUrl: this.baseUrl,
      model: input.model, system: input.systemPrompt || "", input: input.userPrompt, images: input.images,
      timeoutMs: input.timeoutMs ?? 60000, signal: input.signal, monitor: input.monitor, suppressUsageLog: input.suppressUsageLog });
    return { text: result.text };
  }
  async generateStructured<T>(input: StructuredRequest<T>) {
    const result = await callText({ ...this.settings, apiKey: this.apiKey, baseUrl: this.baseUrl,
      model: input.model, system: input.systemPrompt || "", input: input.userPrompt, images: input.images, schema: input.schema,
      timeoutMs: input.timeoutMs ?? 60000, signal: input.signal, monitor: input.monitor, suppressUsageLog: input.suppressUsageLog });
    return { parsed: result.parsed as T, raw: result.text };
  }

  private async generateGeminiImageWithGoogleProtocol(input: {
    model: string;
    prompt: string;
    referenceImages?: string[];
    baseImage?: string | null;
    size?: string;
    aspectRatio?: "1:1" | "3:4" | "9:16";
    monitor?: AiMonitorContext;
    signal?: AbortSignal;
  }, native = false) {
    const imageParts = [input.baseImage ?? null, ...(input.referenceImages ?? [])]
      .filter(Boolean)
      .map((item) => ({ inlineData: dataUrlToInlineData(item as string) }));

    const payload = await this.requestGoogleJson<any>(`/models/${encodeURIComponent(input.model.replace(/^models\//, ""))}:generateContent`, {
      contents: [
        {
          role: "user",
          parts: [{ text: input.prompt }, ...imageParts],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        candidateCount: 1,
        imageConfig: {
          aspectRatio: resolveAspectRatio(input),
        },
      },
    }, 90000, input.monitor, input.signal, native);

    return extractGoogleImageResult(payload);
  }

  // The caller owns retries; never repeat an uncertain paid request or switch models.
  async generateImageOnce(input: ImageGenerationRequest & { mask?: string }): Promise<ImageGenerationResult> {
    const route = resolveImageModel(this.baseUrl, input.model, this.settings);
    if (input.upstreamTask?.protocol === "evolink_tasks") route.protocol = "evolink_tasks";
    const success = async (result: ImageGenerationResult) => { await this.settings.onImageSuccess?.(input.model, route); return result; };
    if (route.protocol === "gemini_native" || route.protocol === "gemini_proxy") {
      if (input.mask) throw new Error("当前 Gemini 图像接口不支持蒙版编辑。");
      await input.beforeSubmit?.();
      return success(await this.generateGeminiImageWithGoogleProtocol(input, route.protocol === "gemini_native"));
    }
    if (route.protocol === "evolink_tasks") {
      // Never send credentials to the file host for an unverified/forwarding origin.
      if (resolveImageProtocol(this.baseUrl) !== "evolink_tasks") throw new Error("异步图像协议与服务地址不匹配，请切回任务原服务。");
      return success(await generateEvoLinkImage(input, (url, init, timeoutMs) => this.fetchRaw(url, init, undefined, timeoutMs, input.monitor, {
        protocol: "evolink_tasks", model: new URL(url).origin === "https://files-api.evolink.ai" ? undefined : input.model, skipModelDispatch: new URL(url).origin === "https://files-api.evolink.ai",
      }), route.contract));
    }
    if (input.upstreamTask) throw new Error("此任务需要原异步图像协议，请切回任务原服务后继续。");
    const form = new FormData();
    if (input.mask) form.append("mask", dataUrlToBlob(input.mask), "mask.png");
    form.append("quality", input.quality ?? "auto");
    form.append("model", input.model);
    form.append("prompt", input.prompt);
    form.append("size", resolveOpenAiSize(input));
    if (input.background && input.background !== "auto") form.append("background", input.background);
    if (input.outputFormat) form.append("output_format", input.outputFormat);
    if (typeof input.outputCompression === "number" && input.outputFormat !== "png") form.append("output_compression", String(input.outputCompression));
    if (input.moderation) form.append("moderation", input.moderation);
    const images = input.referenceImages ?? [];
    images.forEach((image, index) => form.append(images.length > 1 ? "image[]" : "image", dataUrlToBlob(image), `reference-${index}.png`));
    const path = `/images/${images.length ? "edits" : "generations"}`;
    const request = images.length
      ? { method: "POST", body: form, signal: input.signal }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: input.model, prompt: input.prompt, quality: input.quality ?? "auto", size: resolveOpenAiSize(input), n: 1, ...(input.background && input.background !== "auto" ? { background: input.background } : {}), ...(input.outputFormat ? { output_format: input.outputFormat } : {}), ...(typeof input.outputCompression === "number" && input.outputFormat !== "png" ? { output_compression: input.outputCompression } : {}), ...(input.moderation ? { moderation: input.moderation } : {}) }),
          signal: input.signal,
        };
    await input.beforeSubmit?.();
    const response = await this.requestRaw(path, request, input.timeoutMs ?? 180000, input.monitor, { singleAttempt: true });
    if (!response.ok) throw Object.assign(new Error(response.status === 404 || response.status === 405
      ? `图像接口 ${path} 不可用（${response.status}），请检查服务地址与图像协议。已暂停后续图片请求。`
      : `Image request failed (${response.status}): ${response.body.slice(0, 1000)}`), { status: response.status, code: [404, 405].includes(response.status) ? "IMAGE_ENDPOINT_UNAVAILABLE" : "IMAGE_REQUEST_FAILED" });
    return success(extractImageResult(JSON.parse(response.body)));
  }

  async generateImage(input: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return this.generateImageOnce(input);
  }
  async editImage(input: ImageEditRequest): Promise<ImageGenerationResult> {
    return this.generateImageOnce({ ...input, referenceImages: [input.image, ...(input.referenceImages || [])] });
  }
}
