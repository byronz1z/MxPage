import { resolveImageModel } from "./image-protocol";
import { normalizeOpenAiBaseUrl } from "./text-protocol";

export type ImageCapabilities = {
  modelId: string; label: string; evidence: "documented" | "inferred"; routeVerified: boolean; verifiedAt?: string; source?: string;
  qualities: string[]; backgrounds: string[]; formats: string[]; sizes: string[] | null;
  maxReferences: number | null; mask: boolean | null; compression: boolean; moderation: boolean;
};
export function imageCapabilities(baseUrl: string, model: { modelId: string; label?: string; capabilities?: Record<string, any> }): ImageCapabilities {
  const cache = model.capabilities?.__imageCompatibility;
  const current = cache?.baseUrl === normalizeOpenAiBaseUrl(baseUrl);
  const settings = current ? cache.settings : resolveImageModel(baseUrl, model.modelId);
  // A previously working Images route can override a vendor's current catalog.
  const props = settings.protocol === "evolink_tasks" ? settings.contract?.properties : undefined;
  const values = (key: string, fallback: string[]): string[] => props?.[key] ? (props[key].enum?.map(String) ?? fallback) : fallback;
  const quality = values("quality", []);
  const qualities = props ? !props.quality ? [] : quality.length && quality.every((v: string) => /^\d+(?:\.\d+)?K$/.test(v)) ? ["low", "medium", "high"] : quality : ["low", "medium", "high", "xhigh", "max"];
  return {
    modelId: model.modelId, label: model.label || model.modelId, evidence: props ? "documented" : "inferred", routeVerified: Boolean(current), verifiedAt: current ? cache.verifiedAt : undefined, source: props ? settings.contract?.source : undefined,
    qualities: ["auto", ...qualities.filter((v: string) => v !== "auto")], backgrounds: ["auto", ...values("background", props ? [] : ["opaque", "transparent"]).filter(v => v !== "auto")],
    formats: values("output_format", props ? ["png"] : ["png", "jpeg", "webp"]), sizes: props ? props.size?.enum?.map(String) ?? (props.size?.pattern ? null : ["auto"]) : null,
    maxReferences: props ? props.image_urls ? props.image_urls.maxItems ?? null : 0 : null, mask: props ? Boolean(props.mask_url) : null, compression: !props, moderation: !props,
  };
}
export function commonImageOptions(models: ImageCapabilities[], key: "qualities" | "backgrounds" | "formats") {
  return models.reduce<string[] | undefined>((result, model) => result ? result.filter(v => model[key].includes(v)) : model[key], undefined);
}
