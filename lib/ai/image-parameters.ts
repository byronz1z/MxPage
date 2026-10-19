import type { ImageGenerationRequest } from "./provider-client";
import { evoLinkImageContract, type ImageContract } from "./image-protocol";

// Factual parameter contracts from the linked official OpenAPI pages, bundled at
// build time. Never discover image compatibility by making paid image probes.
export function evoLinkImageParameters(input: ImageGenerationRequest & { mask?: string }, contract: ImageContract | undefined = evoLinkImageContract(input.model)) {
  if (!contract) throw new Error("该模型尚无已验证的图像接口描述，请刷新服务模型列表或提供服务文档。");
  const props = contract.properties;
  if (input.model.startsWith("mj-") || input.model.endsWith("-layerize") || contract.required.some(key => !["model", "prompt", "image_urls"].includes(key))) throw new Error("此模型是批量或专用图像操作，当前单图工作流无法提供其必需参数，请选择通用生成/编辑模型。");
  const refs = input.referenceImages?.length || 0;
  if (refs && !props.image_urls) throw new Error("此模型仅支持文生图，不能接收参考图，请选择支持图片输入的模型。");
  if (refs < (props.image_urls?.minItems ?? (contract.required.includes("image_urls") ? 1 : 0))) throw new Error("此模型需要参考图。");
  if (refs > (props.image_urls?.maxItems ?? 16)) throw new Error(`此模型最多支持 ${props.image_urls?.maxItems ?? 16} 张参考图。`);
  if (input.mask && (!refs || !props.mask_url)) throw new Error("此模型不支持当前蒙版编辑，请选择支持蒙版的模型。");
  if (input.moderation === "low" || (input.outputFormat !== "png" && input.outputCompression !== undefined && input.outputCompression !== 100) || input.partialImages) throw new Error("此图像接口不支持所选审核、压缩或预览参数，请使用默认设置。");
  const body: Record<string, unknown> = { model: input.model };
  if (props.prompt) {
    if (props.prompt.maxLength && input.prompt.length > props.prompt.maxLength) throw new Error(`此模型提示词不能超过 ${props.prompt.maxLength} 个字符。`);
    body.prompt = input.prompt;
  }
  if (props.n) body.n = 1;
  if (props.size) {
    let size = input.size && input.size !== "auto" ? input.size : input.aspectRatio || "auto";
    // Ratio-only controls are mapped to documented sizes; never invent a size.
    if (size.includes(":") && props.size.pattern) {
      size = ({ "1:1": "1024x1024", "3:4": "768x1024", "9:16": "576x1024" } as Record<string, string>)[size] || size;
    }
    if (size === "auto" && props.size.enum && !props.size.enum.includes(size)) size = String(props.size.default ?? props.size.enum[0]);
    if (props.size.enum && !props.size.enum.includes(size)) {
      const ratio = size.match(/^(\d+(?:\.\d+)?)(:|x)(\d+(?:\.\d+)?)$/);
      const choices = props.size.enum.filter((s): s is string => typeof s === "string" && /^\d+:\d+$/.test(s));
      if (ratio && choices.length && !input.size) size = choices.sort((a, b) => {
        const distance = (s: string) => { const [w, h] = s.split(":").map(Number); return Math.abs(w / h - Number(ratio[1]) / Number(ratio[3])); };
        return distance(a) - distance(b);
      })[0];
      else throw new Error(`此模型不支持尺寸 ${size}。`);
    }
    if (props.size.pattern && size !== "auto" && !new RegExp(props.size.pattern).test(size)) throw new Error("此模型需要像素尺寸。");
    if (size !== "auto" || props.size.default === "auto" || props.size.enum?.includes("auto")) body.size = size;
  }
  if (input.quality && input.quality !== "auto" && props.quality) {
    const values = props.quality.enum;
    if (!values || values.includes(input.quality)) body.quality = input.quality;
    else if (values.every(v => typeof v === "string" && /^\d+(?:\.\d+)?K$/.test(v))) {
      const tiers = [...values].sort((a, b) => parseFloat(String(a)) - parseFloat(String(b)));
      body.quality = tiers[input.quality === "low" ? 0 : input.quality === "medium" ? Math.floor((tiers.length - 1) / 2) : tiers.length - 1];
    } else throw new Error(`此模型不支持质量档位 ${input.quality}。`);
  }
  for (const [key, value, defaultValue] of [["background", input.background, "auto"], ["output_format", input.outputFormat, "png"]] as const) {
    if (!value || value === "auto") continue;
    if (!props[key]) { if (value !== defaultValue) throw new Error(`此模型不支持 ${key} 参数。`); continue; }
    if (props[key].enum && !props[key].enum.includes(value)) throw new Error(`此模型不支持 ${key}=${value}。`);
    body[key] = value;
  }
  return body;
}
