import { textSettings, normalizeOpenAiBaseUrl, type ResolvedTextSettings } from "@/lib/ai/text-protocol";
import { prepareTextCompatibility } from "./provider-compatibility";
import { resolveImageProtocol, evoLinkImageContract, type ImageProtocol, type ImageModelSettings } from "@/lib/ai/image-protocol";
import { prepareImageCompatibility, rememberImageCompatibility } from "./image-compatibility";
import { prisma } from "@/lib/db/prisma";
import { OpenAICompatibleAdapter } from "@/lib/ai/adapters/openai-compatible";
import { normalizeDetectedModels } from "@/lib/ai/capability-detector";
import { recommendDefaultModels } from "@/lib/ai/model-matcher";
import { encryptSecret } from "@/lib/utils/crypto";
import { getRequestProviderCredentials, resolveEffectiveBaseUrl } from "@/lib/services/provider-runtime";
import type {
  CapabilityMap,
  ModelDetectionResult,
  ModelRoleMap,
  ProviderConnectionInput,
} from "@/types/domain";

type RuntimeProviderModel = {
  id: string;
  providerConfigId: string;
  modelId: string;
  label: string;
  capabilities: Record<string, unknown>;
  roles: Record<string, unknown>;
  quality: string | null;
  latency: string | null;
  cost: string | null;
  isAvailable: boolean;
  isDefaultAnalysis: boolean;
  isDefaultPlanning: boolean;
  isDefaultHeroImage: boolean;
  isDefaultDetailImage: boolean;
  isDefaultImageEdit: boolean;
  createdAt: Date;
  updatedAt: Date;
  endpointSupport: {
    imageGeneration: string;
    imageEdit: string;
    note: string | null;
  };
};

type ProviderAdapterContext = {
  provider: {
    id: string;
    name: string;
    baseUrl: string;
    apiKeyEncrypted: string;
    textProtocol: string;
    structuredOutputMode: string;
    textModelSettings?: Record<string, ResolvedTextSettings>;
    imageProtocol?: ImageProtocol;
    imageModelSettings?: Record<string, ImageModelSettings>;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    models: RuntimeProviderModel[];
  };
  apiKey: string;
  adapter: OpenAICompatibleAdapter;
};

type ProviderModelSnapshot = {
  modelId: string;
  label: string;
  capabilities: Record<string, unknown>;
  roles: Record<string, unknown>;
  quality?: string | null;
  latency?: string | null;
  cost?: string | null;
  isAvailable: boolean;
  endpointSupport?: {
    imageGeneration: string;
    imageEdit: string;
    note?: string | null;
  };
};

function readEndpointSupport(capabilities: Record<string, unknown> | null | undefined) {
  return {
    imageGeneration: (capabilities?.__imageGenerationStatus as string | undefined) ?? "unknown",
    imageEdit: (capabilities?.__imageEditStatus as string | undefined) ?? "unknown",
    note: (capabilities?.__probeNote as string | undefined) ?? null,
  };
}

function hydrateProviderModels<T extends { capabilities: any }>(models: T[]) {
  return models.map((model) => ({
    ...model,
    endpointSupport: readEndpointSupport(model.capabilities as Record<string, unknown> | undefined),
  }));
}

const PASSIVE_IMAGE_CAPABILITY_NOTE =
  "Passive capability detection only; no real image endpoint probe is called during model discovery.";

function enrichModelEndpointSupport(models: ProviderModelSnapshot[]) {
  return models.map((model) => {
    const capabilities = { ...(model.capabilities as Record<string, unknown>) };
    delete capabilities.real_image_gen;
    delete capabilities.real_image_edit;

    const hasImageGeneration = Boolean(capabilities.image_gen);
    const hasImageEdit = Boolean(capabilities.image_edit);
    const endpointSupport = {
      imageGeneration: hasImageGeneration ? ("unknown" as const) : ("not_applicable" as const),
      imageEdit: hasImageEdit ? ("unknown" as const) : ("not_applicable" as const),
      note: hasImageGeneration || hasImageEdit ? PASSIVE_IMAGE_CAPABILITY_NOTE : null,
    };

    capabilities.__imageGenerationStatus = endpointSupport.imageGeneration;
    capabilities.__imageEditStatus = endpointSupport.imageEdit;
    capabilities.__probeNote = endpointSupport.note;

    return {
      ...model,
      capabilities: capabilities as CapabilityMap,
      roles: { ...model.roles } as ModelRoleMap,
      endpointSupport,
    };
  }) satisfies ModelDetectionResult[];
}

async function replaceProviderModels(
  providerConfigId: string,
  models: Awaited<ReturnType<typeof discoverProviderModels>>["models"],
  defaults: {
    analysisModelId?: string | null;
    planningModelId?: string | null;
    heroImageModelId?: string | null;
    detailImageModelId?: string | null;
    imageEditModelId?: string | null;
  },
) {
  await prisma.$transaction(async tx => {
  const existing = await tx.modelProfile.findMany({ where: { providerConfigId } });
  await tx.modelProfile.deleteMany({
    where: { providerConfigId },
  });

  await tx.modelProfile.createMany({
    data: models.map((model) => ({
      providerConfigId,
      modelId: model.modelId,
      label: model.label,
      capabilities: { ...model.capabilities, ...Object.fromEntries(Object.entries((existing.find(m => m.modelId === model.modelId)?.capabilities || {}) as Record<string, any>).filter(([key]) => ["__textCompatibility", "__imageCompatibility", "__agentTools", "__agentNativeSearch"].includes(key))) },
      roles: model.roles,
      quality: model.quality,
      latency: model.latency,
      cost: model.cost,
      isAvailable: model.isAvailable,
      isDefaultAnalysis: defaults.analysisModelId === model.modelId,
      isDefaultPlanning: defaults.planningModelId === model.modelId,
      isDefaultHeroImage: defaults.heroImageModelId === model.modelId,
      isDefaultDetailImage: defaults.detailImageModelId === model.modelId,
      isDefaultImageEdit: defaults.imageEditModelId === model.modelId,
    })),
  });
  });
}

export async function testProviderConnection(input: ProviderConnectionInput) {
  const adapter = new OpenAICompatibleAdapter(resolveEffectiveBaseUrl(input.baseUrl), input.apiKey);
  return adapter.testConnection();
}

export async function resolveProviderConnectionInput(
  input: Omit<ProviderConnectionInput, "apiKey"> & { apiKey?: string | null; id?: string | null },
): Promise<ProviderConnectionInput> {
  const runtimeCredentials = getRequestProviderCredentials();
  const baseUrl = resolveEffectiveBaseUrl(input.baseUrl || runtimeCredentials.baseUrl);
  const headerKeyMatches = !runtimeCredentials.baseUrl || normalizeOpenAiBaseUrl(resolveEffectiveBaseUrl(runtimeCredentials.baseUrl)) === normalizeOpenAiBaseUrl(baseUrl);
  const apiKey = input.apiKey?.trim() || (headerKeyMatches ? runtimeCredentials.apiKey?.trim() : "") || "";

  if (!apiKey) {
    throw Object.assign(new Error("API Key is not configured for this service in this browser."), { code: "PROVIDER_CREDENTIALS_MISSING" });
  }

  if (!baseUrl) {
    throw new Error("Provider baseURL is not configured. Set it in the UI or LOCK_BASE_URL.");
  }

  return {
    name: input.name,
    baseUrl,
    apiKey,
  };
}

export async function discoverProviderModels(input: ProviderConnectionInput) {
  const baseUrl = resolveEffectiveBaseUrl(input.baseUrl);
  const adapter = new OpenAICompatibleAdapter(baseUrl, input.apiKey);
  const models = await adapter.listModels();
  const normalized = enrichModelEndpointSupport(normalizeDetectedModels(models)).map(model => {
    const contract = resolveImageProtocol(baseUrl) === "evolink_tasks" ? evoLinkImageContract(model.modelId) : undefined;
    if (!contract) return model;
    const generic = !model.modelId.startsWith("mj-") && !model.modelId.endsWith("-layerize") && contract.required.every(key => ["model", "prompt", "image_urls"].includes(key));
    const capabilities = { ...model.capabilities, text: false, vision: false, structured_output: false, image_gen: generic && !contract.required.includes("image_urls"), image_edit: generic && Boolean(contract.properties.image_urls) };
    return { ...model, capabilities, roles: { ...model.roles, analysis: false, planning: false, hero_image: capabilities.image_gen, detail_image: capabilities.image_gen, image_edit: capabilities.image_edit } };
  });
  return {
    models: normalized,
    recommendations: recommendDefaultModels(normalized),
  };
}

export async function saveProviderConfig(
  input: ProviderConnectionInput & {
    id?: string | null;
    isActive?: boolean;
    discoveredModels?: ProviderModelSnapshot[];
    defaultAssignments?: {
      analysisModelId?: string | null;
      planningModelId?: string | null;
      heroImageModelId?: string | null;
      detailImageModelId?: string | null;
      imageEditModelId?: string | null;
    };
  },
) {
  const baseUrl = resolveEffectiveBaseUrl(input.baseUrl);
  const discoveredModels = input.discoveredModels?.length
    ? enrichModelEndpointSupport(input.discoveredModels)
    : (await discoverProviderModels({ ...input, baseUrl })).models;
  const discovered = {
    models: discoveredModels,
    recommendations: recommendDefaultModels(discoveredModels),
  };
  const nextIsActive = input.isActive ?? true;

  if (nextIsActive) {
    await prisma.providerConfig.updateMany({
      data: { isActive: false },
    });
  }

  const provider = input.id
    ? await prisma.providerConfig.update({
        where: { id: input.id },
        data: {
          ...textSettings(input),
          name: input.name,
          baseUrl,
          apiKeyEncrypted: encryptSecret(""),
          isActive: nextIsActive,
        },
      })
    : await prisma.providerConfig.create({
        data: {
          ...textSettings(input),
          name: input.name,
          baseUrl,
          apiKeyEncrypted: encryptSecret(""),
          isActive: nextIsActive,
        },
      });

  const defaults = {
    ...discovered.recommendations,
    ...(input.defaultAssignments ?? {}),
  };

  await replaceProviderModels(provider.id, discovered.models, defaults);
  return provider.id;
}

export async function getAllProviderConfigs() {
  const providers = await prisma.providerConfig.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      models: {
        orderBy: { modelId: "asc" },
      },
    },
  });

  return providers.map((provider) => {
    const effectiveBaseUrl = resolveEffectiveBaseUrl(provider.baseUrl);
    return {
      ...provider,
      baseUrl: effectiveBaseUrl,
      apiKey: "",
      maskedApiKey: "",
      models: hydrateProviderModels(provider.models) as RuntimeProviderModel[],
    };
  });
}

export async function getActiveProviderConfig() {
  const provider = await prisma.providerConfig.findFirst({
    where: { isActive: true },
    include: {
      models: {
        orderBy: { modelId: "asc" },
      },
    },
  });

  if (!provider) return null;

  const effectiveBaseUrl = resolveEffectiveBaseUrl(provider.baseUrl);
  return {
    ...provider,
    baseUrl: effectiveBaseUrl,
    apiKey: "",
    maskedApiKey: "",
    models: hydrateProviderModels(provider.models) as RuntimeProviderModel[],
  };
}

export async function activateProviderConfig(providerId: string) {
  const provider = await prisma.providerConfig.findUnique({
    where: { id: providerId },
  });

  if (!provider) {
    throw new Error("未找到要切换的历史服务配置。");
  }

  await prisma.$transaction([
    prisma.providerConfig.updateMany({
      data: { isActive: false },
    }),
    prisma.providerConfig.update({
      where: { id: providerId },
      data: { isActive: true },
    }),
  ]);

  return getAllProviderConfigs();
}

export async function deleteProviderConfig(providerId: string) {
  const provider = await prisma.providerConfig.findUnique({
    where: { id: providerId },
  });

  if (!provider) {
    throw new Error("未找到要删除的历史服务配置。");
  }

  await prisma.$transaction(async (tx) => {
    await tx.providerConfig.delete({
      where: { id: providerId },
    });

    if (!provider.isActive) {
      return;
    }

    const fallbackProvider = await tx.providerConfig.findFirst({
      orderBy: { updatedAt: "desc" },
    });

    await tx.providerConfig.updateMany({
      data: { isActive: false },
    });

    if (fallbackProvider) {
      await tx.providerConfig.update({
        where: { id: fallbackProvider.id },
        data: { isActive: true },
      });
    }
  });

  return getAllProviderConfigs();
}

export type ProviderSnapshot = Pick<ProviderAdapterContext["provider"], "id" | "baseUrl" | "models" | "textProtocol" | "structuredOutputMode" | "textModelSettings" | "imageProtocol" | "imageModelSettings">;
export function snapshotProvider(provider: ProviderAdapterContext["provider"]): ProviderSnapshot {
  return { id: provider.id, baseUrl: provider.baseUrl, models: provider.models, ...textSettings(provider), imageProtocol: provider.imageProtocol ?? resolveImageProtocol(provider.baseUrl), ...(provider.imageModelSettings ? { imageModelSettings: provider.imageModelSettings } : {}) };
}
export async function getProviderAdapter(providerId?: string, snapshot?: ProviderSnapshot, options: { forceCompatibilityCheck?: boolean; textModelIds?: string[]; legacyTextProtocol?: boolean } = {}): Promise<ProviderAdapterContext> {
  snapshot ??= getRequestProviderCredentials().providerSnapshot;
  providerId = snapshot?.id || providerId;
  const saved =
    (providerId
      ? await prisma.providerConfig.findUnique({
          where: { id: providerId },
          include: { models: true },
        })
      : await prisma.providerConfig.findFirst({
          where: { isActive: true },
          include: { models: true },
        })) ?? null;

  if (!saved) {
    throw new Error("No active provider config found.");
  }

  const runtimeCredentials = getRequestProviderCredentials();
  const provider = snapshot ? { ...saved, ...snapshot } : saved;
  const apiKey = runtimeCredentials.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw Object.assign(new Error("API Key is not configured in this browser. Configure it in Provider settings first."), { code: "PROVIDER_CREDENTIALS_MISSING" });
  }
  const baseUrl = snapshot ? snapshot.baseUrl : resolveEffectiveBaseUrl(runtimeCredentials.baseUrl ?? provider.baseUrl);
  if (snapshot && runtimeCredentials.baseUrl && resolveEffectiveBaseUrl(runtimeCredentials.baseUrl) !== snapshot.baseUrl) {
    throw new Error("此任务属于原模型服务，请切回原服务后继续，或创建新任务。");
  }
  const runtimeModels = hydrateProviderModels<{ capabilities: any }>(provider.models) as unknown as RuntimeProviderModel[];
  const runtimeProvider = { ...provider, baseUrl, models: runtimeModels, textModelSettings: snapshot?.textModelSettings, imageModelSettings: snapshot ? snapshot.imageModelSettings : await prepareImageCompatibility({ ...provider, baseUrl }, apiKey) };
  if (!snapshot && (options.legacyTextProtocol || runtimeCredentials.legacyTextProtocol)) {
    runtimeProvider.textProtocol = "chat_completions";
    runtimeProvider.structuredOutputMode = "json_schema";
  } else if (!snapshot && (provider.textProtocol === "auto" || options.forceCompatibilityCheck)) {
    runtimeProvider.textModelSettings = await prepareTextCompatibility(runtimeProvider, apiKey, options);
    runtimeProvider.textProtocol = "auto";
    if (options.forceCompatibilityCheck && provider.textProtocol !== "auto" && Object.keys(runtimeProvider.textModelSettings).length) {
      await prisma.providerConfig.update({ where: { id: provider.id }, data: { textProtocol: "auto" } });
    }
  }

  return {
    provider: runtimeProvider,
    apiKey,
    adapter: new OpenAICompatibleAdapter(baseUrl, apiKey, { ...textSettings(runtimeProvider), imageProtocol: snapshot?.imageProtocol ?? resolveImageProtocol(baseUrl), imageModelSettings: runtimeProvider.imageModelSettings, legacyImageRouting: Boolean(snapshot && !snapshot.imageModelSettings), onImageSuccess: (model, settings) => rememberImageCompatibility(runtimeProvider, apiKey, model, settings).catch(() => undefined) }),
  };
}
