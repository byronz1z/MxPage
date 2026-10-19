import { prisma } from "@/lib/db/prisma";
import { detectTextCompatibility } from "@/lib/ai/text-compatibility";
import { normalizeOpenAiBaseUrl, textProtocols, type ResolvedTextSettings } from "@/lib/ai/text-protocol";
import { providerCredentialFingerprint } from "./provider-runtime";

type Model = {
  id: string; modelId: string; isAvailable: boolean; capabilities: unknown;
  isDefaultPlanning: boolean; isDefaultAnalysis: boolean;
};
type Profile = ResolvedTextSettings & { baseUrl: string; credentialFingerprint: string; vision: boolean };
const pending = new Map<string, Promise<ResolvedTextSettings>>();

export async function prepareTextCompatibility(
  provider: { baseUrl: string; models: Model[] }, apiKey: string,
  options: { forceCompatibilityCheck?: boolean; textModelIds?: string[] } = {},
) {
  const baseUrl = normalizeOpenAiBaseUrl(provider.baseUrl);
  const credentialFingerprint = providerCredentialFingerprint(apiKey)!;
  const resolved: Record<string, ResolvedTextSettings> = {};
  for (const model of provider.models) {
    const required = options.textModelIds ? options.textModelIds.includes(model.modelId) : model.isDefaultPlanning || model.isDefaultAnalysis;
    if (!model.isAvailable || !required) continue;
    const capabilities = model.capabilities as Record<string, unknown>;
    if (!capabilities.text) continue;
    const vision = Boolean(capabilities.vision);
    const cached = capabilities.__textCompatibility as Profile | undefined;
    if (!options.forceCompatibilityCheck && cached?.baseUrl === baseUrl && cached.credentialFingerprint === credentialFingerprint && cached.vision === vision
      && textProtocols.includes(cached.textProtocol) && ["json_schema", "json_object", "prompt_json"].includes(cached.structuredOutputMode)) {
      resolved[model.modelId] = { textProtocol: cached.textProtocol, structuredOutputMode: cached.structuredOutputMode, ...(cached.responsesStream === false ? { responsesStream: false } : {}), ...(cached.nativePathPrefix ? { nativePathPrefix: cached.nativePathPrefix } : {}) };
      continue;
    }
    const key = JSON.stringify([model.id, baseUrl, credentialFingerprint, vision]);
    let check = pending.get(key);
    if (!check) {
      check = (async () => {
        const settings = await detectTextCompatibility({ baseUrl, apiKey, model: model.modelId, vision });
        // Merge with the latest capability record; never overwrite model defaults.
        await prisma.$transaction(async tx => {
          const current = await tx.modelProfile.findUnique({ where: { id: model.id } });
          if (current) await tx.modelProfile.update({ where: { id: model.id }, data: { capabilities: {
            ...(current.capabilities as Record<string, any>),
            __textCompatibility: { ...settings, baseUrl, credentialFingerprint, vision },
          } } });
        });
        return settings;
      })().finally(() => pending.delete(key));
      pending.set(key, check);
    }
    resolved[model.modelId] = await check;
  }
  return resolved;
}
