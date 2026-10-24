"use client";
import { imageCapabilities } from "@/lib/ai/image-capabilities";
import { normalizeOpenAiBaseUrl } from "@/lib/ai/text-protocol";
import { ImageCapabilitySummary } from "./image-capability-controls";

import { Select } from "@/components/ui/select";


import { useEffect, useMemo, useState, useRef } from "react";
import { toast } from "sonner";
import { AlertTriangle, ChevronsUpDown, CopyPlus, History, ImagePlus, Loader2, LockKeyhole, PlugZap, ScanEye, TextCursorInput, Trash2, WandSparkles, type LucideIcon } from "lucide-react";

import { CLIENT_PROVIDER_STORAGE_KEY } from "@/components/layout/provider-credential-fetch-bridge";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type ProviderModelRecord = {
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
  isDefaultAnalysis: boolean;
  isDefaultPlanning: boolean;
  isDefaultHeroImage: boolean;
  isDefaultDetailImage: boolean;
  isDefaultImageEdit: boolean;
};

type ProviderRecord = {
  textProtocol?: string;
  structuredOutputMode?: string;
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  maskedApiKey?: string;
  isActive: boolean;
  updatedAt: string | Date;
  models: ProviderModelRecord[];
};

type RuntimeConfig = {
  baseUrlLocked: boolean;
  lockedBaseUrl: string | null;
};

interface ProviderSettingsProps {
  initialProviders: ProviderRecord[];
  runtimeConfig?: RuntimeConfig;
}

type DefaultAssignments = {
  analysisModelId: string;
  planningModelId: string;
  heroImageModelId: string;
  detailImageModelId: string;
  imageEditModelId: string;
};

type ModelTypeKey = "text" | "vision" | "image_gen" | "image_edit";
type GenericModelRecord = ProviderModelRecord | Record<string, any>;

const modelTypeFields: Array<{
  key: ModelTypeKey;
  label: string;
  icon: LucideIcon;
  panelClassName: string;
  labelClassName: string;
  badgeClassName: string;
}> = [
  {
    key: "text", label: "文本生成模型", icon: TextCursorInput,
    panelClassName: "border-blue-200 bg-blue-50/60 dark:border-blue-400/30 dark:bg-blue-400/5",
    labelClassName: "text-blue-800 dark:text-blue-200",
    badgeClassName: "border-blue-200 bg-blue-100/70 text-blue-800 dark:border-blue-400/25 dark:bg-blue-400/10 dark:text-blue-200",
  },
  {
    key: "vision", label: "图像识别模型", icon: ScanEye,
    panelClassName: "border-violet-200 bg-violet-50/60 dark:border-violet-400/30 dark:bg-violet-400/5",
    labelClassName: "text-violet-800 dark:text-violet-200",
    badgeClassName: "border-violet-200 bg-violet-100/70 text-violet-800 dark:border-violet-400/25 dark:bg-violet-400/10 dark:text-violet-200",
  },
  {
    key: "image_gen", label: "图像生成模型", icon: ImagePlus,
    panelClassName: "border-amber-200 bg-amber-50/60 dark:border-amber-400/30 dark:bg-amber-400/5",
    labelClassName: "text-amber-800 dark:text-amber-200",
    badgeClassName: "border-amber-200 bg-amber-100/70 text-amber-800 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200",
  },
  {
    key: "image_edit", label: "图像编辑模型", icon: WandSparkles,
    panelClassName: "border-teal-200 bg-teal-50/60 dark:border-teal-400/30 dark:bg-teal-400/5",
    labelClassName: "text-teal-800 dark:text-teal-200",
    badgeClassName: "border-teal-200 bg-teal-100/70 text-teal-800 dark:border-teal-400/25 dark:bg-teal-400/10 dark:text-teal-200",
  },
];

const preferredGptTextModelIds = [
  "gpt-6-luna",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1",
];

function normalizeModelId(modelId: string) {
  return modelId.toLowerCase().replace(/[^a-z0-9.]+/g, "");
}

function getModelText(model: GenericModelRecord) {
  return `${model.modelId ?? ""} ${model.label ?? ""}`.toLowerCase();
}

function isUtilityModel(model: GenericModelRecord) {
  return /(embedding|embed|rerank|ranker|moderation|whisper|tts|speech|transcrib|audio|sora|video)/.test(getModelText(model));
}

function isTextGenerationModel(model: GenericModelRecord) {
  return (
    !isUtilityModel(model) &&
    (Boolean(model.capabilities?.text) ||
      /(^|[-_])o[1345](?:[-_]|$)|gpt|chat|instruct|completion|responses|reasoner|qwen|glm|deepseek|kimi|claude|llama|mistral|moonshot/.test(
        getModelText(model),
      ))
  );
}

function isVisionModel(model: GenericModelRecord) {
  return Boolean(model.capabilities?.vision) || /(vision|vl|4o|omni|multimodal|gpt-4\.1|gpt-5|qwen-vl|qvq|pixtral|visual)/.test(getModelText(model));
}

function isImageGenerationModel(model: GenericModelRecord) {
  return Boolean(model.capabilities?.image_gen) || /(gpt[-_\s]?image|chatgpt-image|dall[-_ ]?e|image|imagen|flux|recraft|seedream|jimeng|midjourney|ideogram|cogview)/.test(getModelText(model));
}

function isImageEditModel(model: GenericModelRecord) {
  return Boolean(model.capabilities?.image_edit) || /(gpt[-_\s]?image|chatgpt-image|edit|inpaint|mask|retouch|erase|remove.?background)/.test(getModelText(model));
}

function isImageProductionModel(model: GenericModelRecord) {
  return isImageGenerationModel(model) || isImageEditModel(model);
}

function uniqueModels(models: GenericModelRecord[]) {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = String(model.modelId ?? model.label ?? "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isPreferredGptTextModel(model: GenericModelRecord) {
  const normalized = normalizeModelId(String(model.modelId ?? model.label ?? ""));
  return preferredGptTextModelIds.map(normalizeModelId).includes(normalized);
}

function isPreferredGptImage2(model: GenericModelRecord) {
  if (["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"].includes(String(model.modelId))) return true;
  const modelId = String(model.modelId ?? model.label ?? "");
  const normalized = normalizeModelId(modelId);
  return normalized === "gptimage2" || /^gpt[-_\s]?image[-_\s]?2(?:[-_\s]|$)/i.test(modelId);
}

function canUseForModelType(model: GenericModelRecord, typeKey: ModelTypeKey) {
  if (typeKey === "text") return isTextGenerationModel(model) && !isImageProductionModel(model);
  if (typeKey === "vision") return isVisionModel(model) && !isImageProductionModel(model);
  if (typeKey === "image_gen") return isImageGenerationModel(model);
  return isImageEditModel(model);
}

function scoreModelForType(model: GenericModelRecord, typeKey: ModelTypeKey) {
  let score = 0;
  const text = getModelText(model);
  if ((typeKey === "text" || typeKey === "vision") && model.modelId === "gpt-6-luna") score += 1000;
  if ((typeKey === "image_gen" || typeKey === "image_edit") && model.modelId === "gpt-image-2.5-flare") score += 1000;
  if ((typeKey === "image_gen" || typeKey === "image_edit") && model.modelId === "gpt-image-2.5-sunburst") score += 900;
  if ((typeKey === "text" || typeKey === "vision") && isPreferredGptTextModel(model)) score += 100;
  if ((typeKey === "image_gen" || typeKey === "image_edit") && isPreferredGptImage2(model)) score += 100;
  if (/gpt/i.test(text)) score += 20;
  if (/(mini|nano|lite|turbo|flash)/i.test(text)) score += 8;
  if (/(preview|experimental|beta|test|deprecated|legacy)/i.test(text)) score -= 10;
  if (/gpt[-_\s]?5\.5|pro|max|ultra/i.test(text) && (typeKey === "text" || typeKey === "vision")) score -= 20;
  return score;
}

function getModelsForType(models: GenericModelRecord[], typeKey: ModelTypeKey) {
  return uniqueModels(models.filter((model) => canUseForModelType(model, typeKey))).sort((left, right) => {
    const diff = scoreModelForType(right, typeKey) - scoreModelForType(left, typeKey);
    if (diff !== 0) return diff;
    return String(left.modelId ?? left.label).localeCompare(String(right.modelId ?? right.label));
  });
}

function buildDefaults(provider: ProviderRecord | null): DefaultAssignments {
  return {
    analysisModelId: provider?.models.find((item) => item.isDefaultAnalysis)?.modelId ?? "",
    planningModelId: provider?.models.find((item) => item.isDefaultPlanning)?.modelId ?? "",
    heroImageModelId: provider?.models.find((item) => item.isDefaultHeroImage)?.modelId ?? "",
    detailImageModelId: provider?.models.find((item) => item.isDefaultDetailImage)?.modelId ?? "",
    imageEditModelId: provider?.models.find((item) => item.isDefaultImageEdit)?.modelId ?? "",
  };
}

function getTypeDefaultValue(defaults: DefaultAssignments, typeKey: ModelTypeKey) {
  if (typeKey === "text") return defaults.planningModelId;
  if (typeKey === "vision") return defaults.analysisModelId;
  if (typeKey === "image_gen") return defaults.heroImageModelId || defaults.detailImageModelId;
  return defaults.imageEditModelId;
}

function setTypeDefaultValue(defaults: DefaultAssignments, typeKey: ModelTypeKey, modelId: string): DefaultAssignments {
  if (typeKey === "text") return { ...defaults, planningModelId: modelId };
  if (typeKey === "vision") return { ...defaults, analysisModelId: modelId };
  if (typeKey === "image_gen") return { ...defaults, heroImageModelId: modelId, detailImageModelId: modelId };
  return { ...defaults, imageEditModelId: modelId };
}

function pickModel(models: GenericModelRecord[], predicates: Array<(model: GenericModelRecord) => boolean>) {
  for (const predicate of predicates) {
    const matched = models.find(predicate);
    if (matched?.modelId) return String(matched.modelId);
  }
  return "";
}

function buildRecommendedDefaults(models: GenericModelRecord[]): DefaultAssignments {
  const visionModels = getModelsForType(models, "vision");
  const textModels = getModelsForType(models, "text");
  const imageGenerationModels = getModelsForType(models, "image_gen");
  const imageEditModels = getModelsForType(models, "image_edit");
  const textDefault = pickModel(textModels, [isPreferredGptTextModel, (model) => /gpt/i.test(getModelText(model)), () => true]);
  const visionDefault = pickModel(visionModels, [isPreferredGptTextModel, (model) => /gpt/i.test(getModelText(model)), () => true]);
  const imageDefault = pickModel(imageGenerationModels, [isPreferredGptImage2, (model) => /gpt[-_\s]?image/i.test(getModelText(model)), () => true]);
  const editDefault = pickModel(imageEditModels, [isPreferredGptImage2, (model) => /gpt[-_\s]?image/i.test(getModelText(model)), () => true]);
  return {
    analysisModelId: visionDefault || textDefault,
    planningModelId: textDefault,
    heroImageModelId: imageDefault,
    detailImageModelId: imageDefault,
    imageEditModelId: editDefault || imageDefault,
  };
}

function formatTimeLabel(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function readStoredCredentials() {
  if (typeof window === "undefined") return { apiKey: "", baseUrl: "" };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CLIENT_PROVIDER_STORAGE_KEY) || "{}") as { apiKey?: string; baseUrl?: string };
    return {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "",
    };
  } catch {
    return { apiKey: "", baseUrl: "" };
  }
}

function writeStoredCredentials(values: { apiKey: string; baseUrl: string }) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    CLIENT_PROVIDER_STORAGE_KEY,
    JSON.stringify({ apiKey: values.apiKey.trim(), baseUrl: values.baseUrl.trim() }),
  );
}

export function ProviderSettings({ initialProviders, runtimeConfig }: ProviderSettingsProps) {
  const lockedBaseUrl = runtimeConfig?.lockedBaseUrl ?? "";
  const baseUrlLocked = Boolean(runtimeConfig?.baseUrlLocked && lockedBaseUrl);
  const [providers, setProviders] = useState(initialProviders);
  const activeProvider = useMemo(() => providers.find((item) => item.isActive) ?? providers[0] ?? null, [providers]);
  const [selectedProviderId, setSelectedProviderId] = useState(activeProvider?.id ?? "");
  const selectedProvider = useMemo(
    () => providers.find((item) => item.id === selectedProviderId) ?? activeProvider,
    [providers, selectedProviderId, activeProvider],
  );
  const [loading, setLoading] = useState<null | "configure" | "refreshModels" | "saveAsNew" | "activate" | "delete">(null);
  const [probe, setProbe] = useState<{ status: "running" | "success" | "error"; message: string; endpoint?: string } | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState("");
  const [models, setModels] = useState<Array<GenericModelRecord>>(selectedProvider?.models ?? []);
  const [defaults, setDefaults] = useState<DefaultAssignments>(buildDefaults(selectedProvider ?? null));
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingSaves = useRef<Record<string, number>>({});
  const savedProviders = useRef<Record<string, ProviderRecord>>({});
  const [saveStatus, setSaveStatus] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    id: selectedProvider?.id ?? "",
    name: selectedProvider?.name ?? "默认 GPT 模型服务",
    baseUrl: lockedBaseUrl || selectedProvider?.baseUrl || "https://api.openai.com/v1",
    apiKey: "",
    textProtocol: selectedProvider?.textProtocol ?? "auto",
  });

  useEffect(() => {
    const stored = readStoredCredentials();
    const nextProvider = selectedProvider ?? null;
    if (nextProvider && pendingSaves.current[nextProvider.id]) return;
    if (nextProvider) savedProviders.current[nextProvider.id] = nextProvider;
    setModels(nextProvider?.models ?? []);
    setDefaults(buildDefaults(nextProvider));
    const baseUrl = lockedBaseUrl || nextProvider?.baseUrl || stored.baseUrl || "https://api.openai.com/v1";
    setForm({
      id: nextProvider?.id ?? "",
      name: nextProvider?.name ?? "默认 GPT 模型服务",
      baseUrl,
      apiKey: normalizeOpenAiBaseUrl(stored.baseUrl) === normalizeOpenAiBaseUrl(baseUrl) ? stored.apiKey : "",
      textProtocol: nextProvider?.textProtocol ?? "auto",
    });
  }, [selectedProvider, lockedBaseUrl]);

  type ProviderSubmitValues = ReturnType<typeof currentSubmitValues>;

  const capabilityGroups = useMemo(
    () =>
      modelTypeFields
        .map((field) => ({
          ...field,
          models: getModelsForType(models, field.key),
        }))
        .filter((group) => group.models.length > 0),
    [models],
  );

  function saveSettings(patch: Partial<DefaultAssignments>) {
    const provider = selectedProvider;
    setProbe(null);
    if (!provider || form.baseUrl.replace(/\/+$/, "") !== provider.baseUrl.replace(/\/+$/, "")) {
      setSaveStatus(current => ({ ...current, [provider?.id || ""]: "尚未保存，请先探测并保存服务" }));
      return;
    }
    const id = provider.id;
    savedProviders.current[id] ??= provider;
    pendingSaves.current[id] = (pendingSaves.current[id] || 0) + 1;
    setSaveStatus(current => ({ ...current, [id]: "保存中…" }));
    saveQueue.current = saveQueue.current.then(async () => {
      let failed = false;
      try {
        const response = await fetch(`/api/providers/${encodeURIComponent(id)}/defaults`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error?.message || "模型设置保存失败");
        savedProviders.current[id] = payload.data;
        window.dispatchEvent(new Event("mxpage:provider-updated"));
      } catch (error) {
        failed = true;
        toast.error(error instanceof Error ? error.message : "模型设置保存失败");
      } finally {
        pendingSaves.current[id]--;
        if (!pendingSaves.current[id]) {
          // Publish only the final response, so older saves cannot overwrite a newer selection.
          setProviders(current => current.map(item => item.id === id ? { ...savedProviders.current[id] } : item));
          setSaveStatus(current => ({ ...current, [id]: failed ? "保存失败，已恢复上次保存值" : "已保存；新任务生效" }));
        }
      }
    });
  }
  function changeDefault(type: ModelTypeKey, value: string) {
    const patch = type === "text" ? { planningModelId: value } : type === "vision" ? { analysisModelId: value } : type === "image_gen" ? { heroImageModelId: value, detailImageModelId: value } : { imageEditModelId: value };
    setDefaults(current => ({ ...current, ...patch }));
    saveSettings(patch);
  }
  function updateForm(patch: Partial<typeof form>) {
    setProbe(null);
    setForm((current) => ({ ...current, ...patch,
      ...(patch.baseUrl !== undefined && normalizeOpenAiBaseUrl(patch.baseUrl) !== normalizeOpenAiBaseUrl(current.baseUrl) ? { apiKey: "" } : {}),
    }));
  }

  function currentSubmitValues() {
    return {
      id: form.id || undefined,
      name: form.name.trim() || "默认 GPT 模型服务",
      baseUrl: baseUrlLocked ? lockedBaseUrl : form.baseUrl.trim(),
      apiKey: form.apiKey.trim(),
      textProtocol: form.textProtocol,
      isActive: true,
    };
  }

  function hydrateFromProviderPayload(data: any, nextSelectedId?: string | null) {
    window.dispatchEvent(new Event("mxpage:provider-updated"));
    const nextProviders: ProviderRecord[] = Array.isArray(data) ? data : data?.providers ?? [];
    setProviders(nextProviders);
    const fallbackId = nextSelectedId ?? nextProviders.find((item) => item.isActive)?.id ?? nextProviders[0]?.id ?? "";
    setSelectedProviderId(fallbackId);
  }

  async function handleActivateProvider(providerId: string) {
    setLoading("activate");
    try {
      const response = await fetch("/api/providers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId }),
      });
      const payload = await response.json();
      if (!payload.success) throw new Error(payload.error?.message ?? "切换历史服务失败");
      const nextProvider = providers.find(provider => provider.id === providerId);
      const stored = readStoredCredentials();
      const baseUrl = lockedBaseUrl || nextProvider?.baseUrl || "";
      if (normalizeOpenAiBaseUrl(stored.baseUrl) !== normalizeOpenAiBaseUrl(baseUrl)) {
        writeStoredCredentials({ baseUrl, apiKey: "" });
      }
      hydrateFromProviderPayload(payload.data, providerId);
      toast.success("已切换为当前服务");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换历史服务失败");
    } finally {
      setLoading(null);
    }
  }

  async function handleDeleteProvider() {
    if (!deleteTargetId) return;

    setLoading("delete");
    try {
      const response = await fetch(`/api/providers?id=${encodeURIComponent(deleteTargetId)}`, {
        method: "DELETE",
      });
      const payload = await response.json();
      if (!payload.success) throw new Error(payload.error?.message ?? "删除历史服务失败");
      hydrateFromProviderPayload(payload.data);
      setDeleteTargetId("");
      toast.success("已删除历史服务快照");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除历史服务失败");
    } finally {
      setLoading(null);
    }
  }

  async function discoverProviderModels(values: ProviderSubmitValues) {
    const response = await fetch("/api/providers/discover-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error?.message ?? "模型发现失败");

    const discoveredModels = payload.data.models ?? [];
    const recommendedDefaults = payload.data.recommendations ?? buildRecommendedDefaults(discoveredModels);
    return { discoveredModels, recommendedDefaults };
  }

  async function persistProviderConfig(values: ProviderSubmitValues, overwriteExisting: boolean, discoveredModels = models, recommendedDefaults = defaults) {
    const response = await fetch("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...values,
        id: overwriteExisting ? values.id : undefined,
        defaultAssignments: recommendedDefaults,
        discoveredModels,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error?.message ?? "配置保存失败");

    const savedProviderId = payload.data?.savedProviderId ?? values.id ?? "";
    // Failed discovery/saves must not replace the credentials used by other tasks.
    if (values.isActive) writeStoredCredentials({ apiKey: values.apiKey, baseUrl: values.baseUrl });
    hydrateFromProviderPayload(payload.data, savedProviderId);
  }

  async function handleOneClickConfigure(verifyConnection = true) {
    setLoading(verifyConnection ? "configure" : "refreshModels");
    await saveQueue.current;
    setProbe({ status: "running", message: "正在连接服务并探测模型…" });
    let saved = false;
    let endpoint: string | undefined;
    try {
      const values = !verifyConnection && selectedProvider && !selectedProvider.isActive
        ? { ...currentSubmitValues(), isActive: false }
        : currentSubmitValues();
      const { discoveredModels, recommendedDefaults } = await discoverProviderModels(values);
      // Refresh the catalogue without replacing the user's explicit choices.
      const sameService = values.baseUrl.replace(/\/+$/, "") === selectedProvider?.baseUrl.replace(/\/+$/, "");
      const nextDefaults = { ...recommendedDefaults };
      if (sameService) for (const key of Object.keys(defaults) as Array<keyof DefaultAssignments>) {
        if (defaults[key] && discoveredModels.some((model: GenericModelRecord) => model.modelId === defaults[key])) nextDefaults[key] = defaults[key];
      }
      setProbe({ status: "running", message: `已发现 ${discoveredModels.length} 个模型，正在保存配置…` });
      await persistProviderConfig(values, true, discoveredModels, nextDefaults);
      saved = true;
      if (!verifyConnection) {
        const imageCount = getModelsForType(discoveredModels, "image_gen").length;
        setProbe({ status: "success", message: `模型列表已刷新并保存：共 ${discoveredModels.length} 个，图像生成 ${imageCount} 个。未发送文本、识图或生图请求。` });
        toast.success("模型列表已刷新，未调用模型");
        return;
      }
      setProbe({ status: "running", message: "配置已保存，正在自动检查文本与识图模型的兼容性…" });
      const response = await fetch("/api/providers/agent-compatibility", { method: "POST" });
      const payload = await response.json().catch(() => { throw new Error(`本地检测接口返回异常响应（HTTP ${response.status}），请刷新页面后重试。`); });
      endpoint = payload.data?.endpoint || payload.error?.details?.endpoint;
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || "模型连接检测失败");
      setProbe({ status: "success", message: `探测通过：已发现 ${discoveredModels.length} 个模型并保存配置；已自动完成兼容检查。`, endpoint });
      window.dispatchEvent(new Event("mxpage:provider-updated"));
      toast.success("探测通过，配置已保存");
    } catch (error) {
      const message = `${saved ? "配置已保存，但模型连接检测未通过：" : verifyConnection ? "探测或保存失败：" : "模型列表刷新或保存失败："}${error instanceof Error ? error.message : "请稍后重试"}`;
      setProbe({ status: "error", message, endpoint });
      toast.error(message);
    } finally {
      setLoading(null);
    }
  }

  async function saveProviderAsNew() {
    setLoading("saveAsNew");
    await saveQueue.current;
    try {
      const values = currentSubmitValues();
      await persistProviderConfig(values, false);
      toast.success("已另存为新服务，API Key 仅保存在本地浏览器");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "配置保存失败");
    } finally {
      setLoading(null);
    }
  }
  function handleAutoFillDefaults() {
    const next = buildRecommendedDefaults(models);
    setDefaults(next);
    saveSettings(next);
    toast.success("已按 GPT 优先和模型能力自动填充默认模型");
  }

  const deleteTargetProvider = providers.find((provider) => provider.id === deleteTargetId) ?? null;

  return (
    <>
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>模型服务连接</CardTitle>
          <CardDescription>API Key 只保存在当前浏览器。本地保存后，请求时临时传给后端，不写入服务器配置。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {baseUrlLocked ? (
            <div className="flex items-start gap-3 rounded-3xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
              <LockKeyhole className="mt-0.5 h-4 w-4" />
              <div>
                <p className="font-medium">当前平台已锁定专属 API 服务通道</p>
                <p className="mt-1 text-xs opacity-80">前端填写的 baseURL 会被后端忽略，所有模型请求统一走部署方配置的 LOCK_BASE_URL。</p>
              </div>
            </div>
          ) : null}

          <div className="space-y-3 rounded-3xl border border-border bg-muted/40 p-4">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-medium">历史服务快照</h3>
            </div>
            <div className="flex flex-col gap-3 md:flex-row">
              <div className="flex-1 space-y-2">
                <Label htmlFor="provider-history">历史服务</Label>
                <div className="relative">
                  <Select
                    id="provider-history"
                    value={selectedProviderId}
                    disabled={loading !== null}
                    onValueChange={(value) => { setProbe(null); setSelectedProviderId(value); }}
                  >
                    {providers.length === 0 ? <option value="">暂无已保存服务</option> : null}
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name} / {provider.baseUrl}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <div className="flex items-end gap-2">
                <Button type="button" variant={selectedProvider?.isActive ? "secondary" : "default"} onClick={() => selectedProviderId && handleActivateProvider(selectedProviderId)} disabled={!selectedProviderId || selectedProvider?.isActive || loading !== null}>
                  {loading === "activate" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {selectedProvider?.isActive ? "当前使用中" : "切换为当前服务"}
                </Button>
              </div>
            </div>
            {selectedProvider ? (
              <div className="rounded-2xl border border-border bg-background p-4 dark:bg-black/20">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{selectedProvider.name}</p>
                      {selectedProvider.isActive ? <Badge variant="success">当前服务</Badge> : null}
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{selectedProvider.baseUrl}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Key：仅保存在当前浏览器</p>
                    <p className="mt-1 text-xs text-muted-foreground">最近更新：{formatTimeLabel(selectedProvider.updatedAt)}</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:text-rose-300 dark:hover:bg-rose-500/10 dark:hover:text-rose-200"
                    onClick={() => setDeleteTargetId(selectedProvider.id)}
                    disabled={loading !== null}
                    title="删除历史服务快照"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    删除
                  </Button>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">首次使用时，请填写 API Key 并发现模型。</div>
            )}
          </div>

          <div className="space-y-2 text-sm text-muted-foreground">
            <p>优先使用官方接口，自动适配兼容服务。切换模型后，首次使用时自动检查连接。</p>
            <p role="status">{saveStatus[selectedProvider?.id || ""] || "模型选择自动保存；已有任务沿用原设置。"}</p>
            {selectedProvider && <ImageCapabilitySummary models={selectedProvider.models.filter(model => [defaults.heroImageModelId, defaults.detailImageModelId, defaults.imageEditModelId].includes(model.modelId)).map(model => imageCapabilities(selectedProvider.baseUrl, model))}/>}
          </div>
          <form autoComplete="off" className="grid gap-4 md:grid-cols-2" onSubmit={(event) => event.preventDefault()}>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="provider-name">服务名称</Label>
              <Input id="provider-name" disabled={loading !== null} autoComplete="off" value={form.name} onChange={(event) => updateForm({ name: event.target.value })} placeholder="默认 GPT 模型服务" />
            </div>
            {!baseUrlLocked ? (
              <div className="space-y-2 md:col-span-2">
              <Label htmlFor="provider-base-url">baseURL</Label>
                <Input id="provider-base-url" disabled={loading !== null} inputMode="url" autoComplete="off" autoCapitalize="none" value={form.baseUrl} onChange={(event) => updateForm({ baseUrl: event.target.value })} placeholder="https://your-provider.example/v1" />
              </div>
            ) : null}
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="provider-text-protocol">接口协议</Label>
              <select
                id="provider-text-protocol"
                disabled={loading !== null}
                value={form.textProtocol}
                onChange={(event) => updateForm({ textProtocol: event.target.value })}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="auto">自动检测（默认，兼容旧配置）</option>
                <option value="chat_completions">OpenAI 兼容 · Chat Completions</option>
                <option value="responses">OpenAI 兼容 · Responses</option>
                <option value="anthropic_messages">Anthropic Messages</option>
                <option value="gemini_native">Gemini Native</option>
              </select>
              <p className="text-xs text-muted-foreground">
                选定协议后，模型发现与调用只使用该协议，不再自动切换，也不会按其他协议的鉴权头取目录。第三方 OpenAI 兼容中转请选「Chat Completions」。
              </p>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="provider-api-key">API Key</Label>
              <Input id="provider-api-key" disabled={loading !== null} type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => updateForm({ apiKey: event.target.value })} placeholder="请输入当前浏览器使用的 API Key" />
              <p className="text-xs text-muted-foreground">API Key 仅在配置保存成功后写入当前浏览器，不会保存到服务器数据库。更换服务地址后需重新填写该服务的密钥。</p>
            </div>
          </form>

          <div className="space-y-3 rounded-3xl border border-border bg-muted/35 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">一键配置模型服务</p>
                <p className="text-xs leading-6 text-muted-foreground">
                  一次完成模型发现、配置保存和自动兼容检查。连接检查使用少量文本/识图 token，不生成图片。
                </p>
              </div>
              <Button type="button" onClick={() => handleOneClickConfigure()} disabled={loading !== null || !form.apiKey.trim()} className="h-11 shrink-0 gap-2 px-5">
                {loading === "configure" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
                {loading === "configure" ? "正在探测…" : "探测并保存"}
              </Button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button type="button" variant="outline" onClick={() => handleOneClickConfigure(false)} disabled={loading !== null || !form.apiKey.trim()}>
                {loading === "refreshModels" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {loading === "refreshModels" ? "正在读取列表…" : "仅刷新模型列表"}
              </Button>
              <p className="text-xs leading-6 text-muted-foreground">只读取并保存当前密钥返回的目录，不调用模型。服务商价格页的模型不一定出现在当前密钥的目录中；若缺少模型，请核对密钥权限、分组及服务商目录。</p>
            </div>
            {probe && <div role="status" aria-live="polite" className={cn("space-y-1 rounded-xl border p-3 text-sm", probe.status === "error" ? "border-destructive/30 text-destructive" : probe.status === "success" ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
              <p>{probe.message}</p>
              {probe.endpoint && <p className="break-all text-xs text-muted-foreground">请求地址：{probe.endpoint}</p>}
            </div>}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3">
              <p className="text-xs text-muted-foreground">需要保留当前历史服务时，可先一键配置确认模型，再另存为新服务。</p>
              <Button type="button" variant="outline" onClick={saveProviderAsNew} disabled={loading !== null || models.length === 0 || !form.apiKey.trim()}>
                {loading === "saveAsNew" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CopyPlus className="mr-2 h-4 w-4" />}
                另存为新服务
              </Button>
            </div>
          </div>

          {models.length > 0 ? (
            <div className="space-y-4 rounded-3xl bg-muted/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">默认模型类型分配</h3>
                  <Badge>{models.length} 个模型</Badge>
                </div>
                <Button type="button" variant="outline" size="sm" disabled={loading !== null} onClick={() => { setProbe(null); handleAutoFillDefaults(); }}>按 GPT 优先自动填充</Button>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                {modelTypeFields.map((field) => {
                  const options = getModelsForType(models, field.key);
                  const selectedValue = getTypeDefaultValue(defaults, field.key);
                  const Icon = field.icon;
                  return (
                    <div key={field.key} className={cn("min-w-0 space-y-3 rounded-2xl border p-4", field.panelClassName)}>
                      <Label htmlFor={`default-model-${field.key}`} className={cn("flex items-center gap-2", field.labelClassName)}>
                        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                        {field.label}
                      </Label>
                      <Select id={`default-model-${field.key}`} aria-label={field.label} value={selectedValue} disabled={loading !== null || options.length === 0} onValueChange={(value) => { changeDefault(field.key, value); }}>
                        <option value="">{options.length === 0 ? "暂无此类型模型" : "未选择"}</option>
                        {options.map((model) => (
                          <option key={`${field.key}-${model.modelId}`} value={model.modelId}>{model.label}</option>
                        ))}
                      </Select>
                      {field.key === "image_gen" && defaults.heroImageModelId !== defaults.detailImageModelId && (
                        <div className="space-y-2 text-xs leading-5">
                          <p>当前主图模型：{defaults.heroImageModelId || "未选择"}；详情图模型：{defaults.detailImageModelId || "未选择"}。此服务保留了不同的默认值。</p>
                          <Button type="button" size="sm" variant="outline" disabled={loading !== null || !selectedValue} onClick={() => changeDefault("image_gen", selectedValue)}>主图和详情图统一使用所选模型</Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>模型能力分组</CardTitle>
          <CardDescription>按功能类型聚合模型。默认排序优先 GPT 文本模型和 GPT Image 系列。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {models.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-border p-6 text-sm text-muted-foreground">先发现模型，系统会按能力类型展示可用模型。</div>
          ) : (
            <div className="grid gap-4">
              {capabilityGroups.map((group) => {
                const visibleModels = group.models.slice(0, 18);
                const hiddenCount = Math.max(0, group.models.length - visibleModels.length);
                const Icon = group.icon;
                return (
                  <div key={group.key} className={cn("min-w-0 rounded-3xl border p-4", group.panelClassName)}>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className={cn("flex items-center gap-2 font-medium", group.labelClassName)}>
                        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                        {group.label}
                      </h3>
                      <Badge variant="outline" className={group.badgeClassName}>{group.models.length} 个模型</Badge>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {visibleModels.map((model) => (
                        <Badge key={`${group.key}-${model.modelId}`} variant="outline" className={cn("max-w-full truncate", group.badgeClassName)}>{model.label}</Badge>
                      ))}
                      {hiddenCount > 0 ? <Badge className={group.badgeClassName}>+ {hiddenCount} 个</Badge> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
    <ConfirmDialog
      open={Boolean(deleteTargetProvider)}
      title="删除历史服务快照？"
      description={
        deleteTargetProvider
          ? `将删除「${deleteTargetProvider.name}」及其模型快照记录。删除当前服务后，系统会自动切换到剩余最近更新的服务。`
          : undefined
      }
      confirmText="删除快照"
      destructive
      loading={loading === "delete"}
      icon={<AlertTriangle className="h-5 w-5" />}
      onCancel={() => {
        if (loading !== "delete") setDeleteTargetId("");
      }}
      onConfirm={handleDeleteProvider}
    />
    </>
  );
}
