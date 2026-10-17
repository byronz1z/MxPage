import { z } from "zod";
import { DEFAULT_USD_TO_CNY } from "./currency";

// Standard USD / 1M tokens, checked against OpenAI model docs on 2026-10-16.
export const BILLING_VERSION = "2026-10-16-v1";
const rate = z.number().finite().min(0).max(100000);
export const billingRulesSchema = z.object({
  usdToCny: z.number().finite().positive("人民币换算汇率必须大于 0").max(1000).default(DEFAULT_USD_TO_CNY),
  luna: z.object({ input: rate, cachedInput: rate, cacheWrite: rate, output: rate }),
  image: z.object({ textInput: rate, imageInput: rate, output: rate }),
  fallback: z.object({ quality: z.enum(["low", "medium", "high"]), size: z.enum(["1024x1024", "1024x1536", "1536x1024"]), imageInputTokens: z.number().int().min(1).max(50000) }),
});
export type BillingRules = z.infer<typeof billingRulesSchema>;
export const defaultBillingRules: BillingRules = {
  usdToCny: DEFAULT_USD_TO_CNY,
  luna: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  image: { textInput: 5, imageInput: 8, output: 30 },
  fallback: { quality: "low", size: "1024x1024", imageInputTokens: 1024 },
};
export const imageOutputTokenTable: Record<"image25" | "image2", Record<string, number>> = {
  image25: { low: 196, medium: 439, high: 1756, xhigh: 3122, max: 7024 },
  image2: { low: 200, medium: 1767, high: 7033 },
};
export function billingFamily(model?: string | null) {
  const id = (model || "").toLowerCase().replace(/[-_\s]/g, "");
  if (/^gpt6luna(?:$|20\d{6}$)/.test(id)) return "luna";
  if (/^gptimage2\.5(?:flare|sunburst)(?:$|20\d{6}$)/.test(id)) return "image25";
  if (/^gptimage2(?:$|20\d{6}$)/.test(id)) return "image2";
  return null;
}
export function nonnegative(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
export function readProviderCostUsd(payload: any) {
  const explicit = nonnegative(payload?.cost_usd) ?? nonnegative(payload?.usage?.cost_usd);
  if (explicit !== null) return explicit;
  for (const value of [payload, payload?.usage]) {
    const currency = value?.currency ?? payload?.currency;
    if (currency && String(currency).toUpperCase() !== "USD") continue;
    const cost = nonnegative(value?.cost) ?? nonnegative(value?.total_cost);
    if (cost !== null) return cost;
  }
  return null;
}
export type BillingUsage = {
  input: number | null; output: number | null; total: number | null;
  cached: number | null; cacheWrite: number | null;
  textInput: number | null; imageInput: number | null;
};
export function readBillingUsage(payload: any): BillingUsage {
  const usage = payload?.usage ?? payload?.usageMetadata ?? payload?.usage_metadata;
  const details = usage?.input_tokens_details ?? usage?.prompt_tokens_details;
  const textInput = nonnegative(details?.text_tokens), imageInput = nonnegative(details?.image_tokens);
  const input = nonnegative(usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.promptTokenCount ?? usage?.inputTokenCount)
    ?? (textInput !== null && imageInput !== null ? textInput + imageInput : null);
  const output = nonnegative(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.candidatesTokenCount ?? usage?.outputTokenCount);
  return {
    input, output,
    total: nonnegative(usage?.total_tokens ?? usage?.totalTokenCount) ?? (input !== null || output !== null ? (input || 0) + (output || 0) : null),
    cached: nonnegative(details?.cached_tokens ?? usage?.cached_input_tokens),
    cacheWrite: nonnegative(details?.cache_creation_tokens ?? usage?.cache_creation_input_tokens),
    textInput, imageInput,
  };
}
export type BillingRequest = { textTokens?: number; inputImages?: number; quality?: string; size?: string; imageCount?: number; serviceTier?: string };
// Lightweight fallback only; never tokenize base64, image URLs or raw response bytes as text.
export function approximateTextTokens(text: string) {
  const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}
export function readBillingRequest(body: unknown): BillingRequest {
  if (!body) return {};
  if (typeof body === "string") { try { return readBillingRequest(JSON.parse(body)); } catch { return {}; } }
  if (typeof FormData !== "undefined" && body instanceof FormData) return {
    textTokens: approximateTextTokens(String(body.get("prompt") || "")),
    inputImages: body.getAll("image").length + body.getAll("image[]").length,
    quality: String(body.get("quality") || "auto"), size: String(body.get("size") || "auto"), imageCount: nonnegative(body.get("n")) ?? 1,
  };
  const value = body as any;
  let text = typeof value.prompt === "string" ? value.prompt : "";
  let inputImages = 0;
  for (const message of value.messages || []) {
    if (typeof message.content === "string") text += message.content;
    else if (Array.isArray(message.content)) for (const part of message.content) {
      if (typeof part.text === "string") text += part.text;
      if (part.type === "image_url" || part.type === "input_image") inputImages++;
    }
  }
  if (value.response_format) text += JSON.stringify(value.response_format);
  return { textTokens: approximateTextTokens(text), inputImages, quality: value.quality, size: value.size, imageCount: nonnegative(value.n) ?? 1, serviceTier: value.service_tier };
}
export function estimateImageOutputTokens(family: "image25" | "image2", quality: string, size: string) {
  const [width, height] = size.split("x").map(Number);
  const base = imageOutputTokenTable[family][quality];
  if (!base || !(width > 0 && height > 0)) return null;
  // Area scaling is an approximation, not the provider's exact image tokenizer.
  return Math.round(base * width * height / (1024 * 1024));
}
export type BillingRecord = {
  source: "provider" | "tokens" | "approximation" | "unknown";
  costUsd: number | null;
  ruleVersion: string;
  notes: string[];
  rates?: Record<string, number>;
  tokens?: Record<string, number>;
};
export const billingSourceLabels = { provider: "接口金额", tokens: "用量估算", approximation: "粗估", unknown: "未计价" };
export function calculateBilling(entry: {
  model: string | null; success: boolean; category: string; actualCostUsd?: number | null;
  promptTokens?: number | null; completionTokens?: number | null; requestBytes?: number; responseBytes?: number;
  billingUsage?: BillingUsage; billingRequest?: BillingRequest; outputTextTokens?: number; outputImageCount?: number;
}, rules: BillingRules = defaultBillingRules): BillingRecord {
  const result: BillingRecord = { source: "unknown", costUsd: null, ruleVersion: BILLING_VERSION, notes: [] };
  const actual = nonnegative(entry.actualCostUsd);
  if (actual !== null) return { ...result, source: "provider", costUsd: actual, notes: ["使用接口返回的美元金额，不叠加估算；cost / total_cost 未注明币种时按 USD 记录。"] };
  const family = billingFamily(entry.model);
  if (!family) return { ...result, notes: ["该模型尚未配置计费规则。"] };
  const usage = entry.billingUsage ?? { ...readBillingUsage(null), input: entry.promptTokens ?? null, output: entry.completionTokens ?? null };
  const hasUsage = usage.input !== null || usage.output !== null;
  if (!entry.success && !hasUsage) return { ...result, notes: ["失败或中断且未返回用量，是否计费未知，未计入总额。"] };
  let approximate = false;
  const assume = (note: string) => { approximate = true; result.notes.push(note); };
  const request = entry.billingRequest || {};
  let input = usage.input;
  if (input === null) {
    input = request.textTokens ?? Math.ceil((entry.requestBytes || 0) / 3);
    assume(request.textTokens === undefined ? "历史记录缺少输入用量，按请求字节粗估；未记录的系统提示和图片输入可能遗漏。" : "未返回输入用量，按文本长度及每张参考图的默认 token 粗估。");
  }
  let output = usage.output;
  if (family === "luna") {
    if (!["chat", "structured"].includes(entry.category)) return { ...result, notes: ["此接口类型未配置 Luna 估算。"] };
    if (usage.input === null) input += (request.inputImages || 0) * rules.fallback.imageInputTokens;
    if (output === null) { output = entry.outputTextTokens ?? Math.ceil((entry.responseBytes || 0) / 3); assume("未返回输出用量，按文本长度粗估，不含不可见推理 token。"); }
    if (!hasUsage && input + output === 0) return { ...result, notes: ["缺少 token 或文本长度，无法估算。"] };
    const cached = Math.min(input, usage.cached || 0), write = Math.min(input - cached, usage.cacheWrite || 0);
    const long = input > 272000;
    const tier = request.serviceTier;
    const factor = tier === "flex" || tier === "batch" ? 0.5 : tier === "priority" || tier === "fast" ? 2 : 1;
    const rates = { input: rules.luna.input * (long ? 2 : 1) * factor, cachedInput: rules.luna.cachedInput * (long ? 2 : 1) * factor, cacheWrite: rules.luna.cacheWrite * (long ? 2 : 1) * factor, output: rules.luna.output * (long ? 1.5 : 1) * factor };
    result.costUsd = ((input - cached - write) * rates.input + cached * rates.cachedInput + write * rates.cacheWrite + output * rates.output) / 1e6;
    result.rates = rates; result.tokens = { input, cached, cacheWrite: write, output };
    if (long) result.notes.push("输入超过 272K，已应用长上下文倍率。");
    result.notes.push(`处理档位：${tier || "standard（默认）"}；不含工具调用及地区附加费。`);
  } else {
    if (!["image_edit", "image_generation"].includes(entry.category)) return { ...result, notes: ["仅对直接 Images API 估算，复合接口需单独拆分用量。"] };
    let imageInput = usage.imageInput, textInput = usage.textInput;
    if (imageInput === null || textInput === null) {
      const count = request.inputImages ?? (entry.category === "image_edit" ? 1 : 0);
      if (imageInput === null) imageInput = usage.input !== null && textInput !== null ? Math.max(0, input - textInput) : Math.min(usage.input !== null ? input : Infinity, count * rules.fallback.imageInputTokens);
      if (textInput === null) textInput = usage.input !== null ? Math.max(0, input - imageInput) : input;
      if (count > 0 && usage.imageInput === null) assume(`缺少图片输入用量，按 ${count} 张 × ${rules.fallback.imageInputTokens} tokens 粗估（不超过接口输入总量）。`);
    }
    if (output === null) {
      const quality = request.quality && request.quality !== "auto" ? request.quality : rules.fallback.quality;
      const size = request.size && /^\d+x\d+$/.test(request.size) ? request.size : rules.fallback.size;
      const perImage = estimateImageOutputTokens(family, quality, size);
      if (perImage === null) return { ...result, notes: ["画质或尺寸无对应估算规则。"] };
      const count = entry.outputImageCount ?? request.imageCount ?? 1;
      output = perImage * count;
      assume(`图像输出按 ${quality} / ${size} / ${count} 张的基准 token × 像素面积粗估；auto 或缺失参数采用默认值。`);
    }
    result.rates = { ...rules.image };
    result.tokens = { textInput, imageInput, output };
    result.costUsd = (textInput * rules.image.textInput + imageInput * rules.image.imageInput + output * rules.image.output) / 1e6;
    result.notes.push("直接 Images API 不计算输入缓存折扣；不含额外流式预览图片费用。");
  }
  result.source = approximate ? "approximation" : "tokens";
  result.notes.push("按保存的单价估算，代理实收可能不同。");
  return result;
}
