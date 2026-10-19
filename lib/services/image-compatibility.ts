import { prisma } from "@/lib/db/prisma";
import { listApiUsageEntries } from "@/lib/monitor/api-usage";
import { resolveImageModel, type ImageModelSettings } from "@/lib/ai/image-protocol";
import { normalizeOpenAiBaseUrl } from "@/lib/ai/text-protocol";
import { providerCredentialFingerprint } from "./provider-runtime";

type Provider = { id: string; baseUrl: string; models: { modelId: string; capabilities: unknown }[] };
export async function prepareImageCompatibility(provider: Provider, apiKey: string) {
  const baseUrl = normalizeOpenAiBaseUrl(provider.baseUrl), fingerprint = providerCredentialFingerprint(apiKey);
  const profiles: Record<string, ImageModelSettings> = {};
  // Preserve routes already used successfully before per-model profiles existed.
  let history: Awaited<ReturnType<typeof listApiUsageEntries>> | undefined;
  for (const model of provider.models) {
    const caps = model.capabilities as Record<string, any>;
    if (!caps.image_gen && !caps.image_edit) continue;
    const cached = caps.__imageCompatibility;
    if (cached?.baseUrl === baseUrl && cached.credentialFingerprint === fingerprint && ["openai_images", "evolink_tasks", "gemini_native", "gemini_proxy"].includes(cached.settings?.protocol)) {
      profiles[model.modelId] = cached.settings; continue;
    }
    history ??= await listApiUsageEntries(1000).catch(() => []);
    const previous = history.find(entry => entry.success && entry.model === model.modelId && entry.method === "POST" && entry.credentialFingerprint === fingerprint && normalizeOpenAiBaseUrl(entry.providerBaseUrl) === baseUrl && /\/images\/(generations|edits)|:generateContent/.test(entry.endpoint) && !/probe/.test(entry.operation || ""));
    if (previous) {
      const endpoint = previous.finalEndpoint || previous.endpoint;
      const protocol = previous.protocol === "evolink_tasks" ? "evolink_tasks" : endpoint.includes(":generateContent") ? endpoint.includes("/google/") ? "gemini_proxy" : "gemini_native" : "openai_images";
      profiles[model.modelId] = { ...resolveImageModel(provider.baseUrl, model.modelId), protocol };
    } else profiles[model.modelId] = ["openai_images", "gemini_native"].includes(caps.__imageProtocolHint)
      ? { protocol: caps.__imageProtocolHint } : resolveImageModel(provider.baseUrl, model.modelId);
  }
  return profiles;
}
export async function rememberImageCompatibility(provider: Pick<Provider, "id" | "baseUrl">, apiKey: string, modelId: string, settings: ImageModelSettings) {
  await prisma.$transaction(async tx => {
    const row = await tx.modelProfile.findUnique({ where: { providerConfigId_modelId: { providerConfigId: provider.id, modelId } } });
    if (row) await tx.modelProfile.update({ where: { id: row.id }, data: { capabilities: {
      ...row.capabilities as Record<string, any>,
      __imageCompatibility: { baseUrl: normalizeOpenAiBaseUrl(provider.baseUrl), credentialFingerprint: providerCredentialFingerprint(apiKey), settings, verifiedAt: new Date().toISOString() },
    } as any } });
  });
}
