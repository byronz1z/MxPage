import type { ApiUsageEntry } from "./api-usage";

export type ImageApiStatus = {
  state: "available" | "unavailable" | "unverified" | "unconfigured";
  model: string | null;
  checkedAt: string | null;
  note: string;
  imageVerification: {
    state: "available" | "unavailable" | "unverified" | "unconfigured";
    checkedAt: string | null;
    source: "current-credential" | "legacy-record" | null;
  };
};
const normalize = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
// Older Gemini logs used one category for text, vision and image output.
const legacyGeminiImageOperations = new Set(["v4_image_generation", "generate_section_image", "regenerate_section_image", "translate_section_image", "translate_image", "enhance_section_image", "repaint_section_image"]);

export function resolveImageApiStatus(entries: ApiUsageEntry[], config: {
  model: string | null; baseUrl: string; fingerprint?: string;
}, now = Date.now()): ImageApiStatus {
  const initial: ImageApiStatus = {
    model: config.model, checkedAt: null, state: "unverified", note: "当前服务与凭证尚无连接记录，请在 API 配置中执行探测。",
    imageVerification: { state: config.model ? "unverified" : "unconfigured", checkedAt: null, source: null },
  };
  if (!config.fingerprint || !config.baseUrl.trim()) return {
    ...initial, state: "unconfigured", note: "请先在 API 配置中保存服务地址与凭证。",
    imageVerification: { state: "unconfigured", checkedAt: null, source: null },
  };
  // Provider identity is the URL and credential, not the configuration save time.
  // Recorded verification does not expire; a later relevant call updates it.
  const providerEntries = entries.filter(entry => {
    const timestamp = Date.parse(entry.timestamp);
    return normalize(entry.providerBaseUrl) === normalize(config.baseUrl)
      && Number.isFinite(timestamp) && timestamp <= now;
  }).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const matching = providerEntries.filter(entry => entry.credentialFingerprint === config.fingerprint);
  const isSelectedImage = (entry: ApiUsageEntry) => Boolean(config.model) && entry.model === config.model
    && (["image_generation", "image_edit"].includes(entry.category) || (entry.outputImageCount ?? 0) > 0
      || (entry.category === "google_generate_content" && legacyGeminiImageOperations.has(entry.operation || "")));
  const currentImage = matching.find(isSelectedImage);
  // Older logs can show model history, but must never verify the current credential.
  const latestImage = currentImage ?? providerEntries.find(entry => !entry.credentialFingerprint && isSelectedImage(entry));
  const imageVerification: ImageApiStatus["imageVerification"] = latestImage
    ? { state: latestImage.success ? "available" : "unavailable", checkedAt: latestImage.timestamp, source: currentImage ? "current-credential" : "legacy-record" }
    : initial.imageVerification;
  // Input/model-specific 4xx errors do not invalidate an established service connection.
  const latest = matching.find(entry => entry.success || entry.operation === "provider_connection_probe"
    || entry.category === "models" || entry.statusCode === 0 || [401, 403, 429].includes(entry.statusCode) || entry.statusCode >= 500);
  if (!latest) return { ...initial, imageVerification };
  return {
    model: config.model, checkedAt: latest.timestamp, state: latest.success ? "available" : "unavailable",
    imageVerification,
    note: latest.success ? "当前服务与凭证最近连接成功。状态依据探测或调用记录；图像模型验证单独记录，不随时间失效。" : "最近的服务连接或调用异常，请在 API 监控中查看原因。图像模型验证记录单独保留。",
  };
}
