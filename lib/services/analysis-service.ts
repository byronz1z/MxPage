import { selectModel } from "@/lib/ai/model-selection";
import { Prisma } from "@prisma/client";

import { buildProductAnalysisPrompt } from "@/lib/ai/prompts";
import { productAnalysisOutputSchema } from "@/lib/ai/schemas/product-analysis";
import { prisma } from "@/lib/db/prisma";
import { patchProjectModelSnapshot } from "@/lib/services/project-model-snapshot-service";
import { getProviderAdapter } from "@/lib/services/provider-service";
import { completeTask, createTask, failTask, findRecentRunningTask } from "@/lib/services/task-service";
import { readStorageFile } from "@/lib/storage/asset-manager";

const MAX_ANALYSIS_IMAGES = 10;

function pickAnalysisModel(provider: Awaited<ReturnType<typeof getProviderAdapter>>["provider"], preferredModelId?: string | null) {
  return selectModel(provider.models, "analysis", preferredModelId);
}

async function assetToDataUrl(asset: { filePath: string; mimeType: string | null }) {
  const buffer = await readStorageFile(asset.filePath);
  const mimeType = asset.mimeType ?? "image/png";
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function normalizeAnalysisProviderError(error: unknown): never {
  const detail = error instanceof Error ? error.message : "Unknown analysis error";

  if (/monthly spending limit|spending limit|billing|quota|insufficient_quota/i.test(detail)) {
    throw new Error("当前 API Key 的分析额度已用尽。请前往代理商控制台提高或移除月度限额，或更换可用的 API Key。");
  }

  if (/429|rate limit|限流/i.test(detail)) {
    throw new Error("当前分析请求触发了限流。请稍后重试，或降低调用频率。");
  }

  if (/invalid token|unauthorized|forbidden/i.test(detail)) {
    throw new Error("当前 Provider 鉴权失败。请检查 baseURL、API Key 或代理商权限配置。");
  }

  if (/timed out|aborterror|network error|fetch failed/i.test(detail)) {
    throw new Error("当前 Provider 请求超时或网络异常，请稍后重试。");
  }

  throw error instanceof Error ? error : new Error(detail);
}

export async function analyzeProject(projectId: string, preferredModelId?: string | null) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { assets: { orderBy: { sortOrder: "asc" } } },
  });

  if (!project) {
    throw new Error("Project not found.");
  }

  const { provider, adapter } = await getProviderAdapter(undefined, undefined, { textModelIds: preferredModelId ? [preferredModelId] : undefined });
  const model = pickAnalysisModel({ ...provider, models: provider.models }, preferredModelId);

  if (!model) {
    throw new Error("No analysis model available.");
  }

  const existingTask = await findRecentRunningTask({
    projectId,
    taskType: "ANALYZE",
    maxAgeMinutes: 10,
  });
  if (existingTask) {
    throw new Error("当前商品分析仍在进行中，请等待这一轮完成后再试。");
  }

  const task = await createTask({
    projectId,
    taskType: "ANALYZE",
    inputPayload: { model },
  });

  try {
    const imageUrls = await Promise.all(
      project.assets.slice(0, MAX_ANALYSIS_IMAGES).map((asset) => assetToDataUrl(asset)),
    );
    const prompt = buildProductAnalysisPrompt(project.assets);

    let parsedResult: Prisma.JsonObject;
    let rawResult: Prisma.JsonObject;

    try {
      const structured = await adapter.generateStructured({
        model,
        systemPrompt: "Return one strict JSON object only. No markdown.",
        userPrompt: prompt,
        schema: productAnalysisOutputSchema,
        images: imageUrls,
        monitor: {
          projectId,
          operation: "project_analysis",
        },
      });

      parsedResult = structured.parsed as Prisma.JsonObject;
      rawResult = {
        mode: "structured",
        model,
        raw: structured.raw,
      };
    } catch (error) {
      normalizeAnalysisProviderError(error);
    }

    const saved = await prisma.productAnalysis.upsert({
      where: { projectId },
      update: {
        rawResult,
        normalizedResult: parsedResult,
      },
      create: {
        projectId,
        rawResult,
        normalizedResult: parsedResult,
      },
    });

    await prisma.project.update({
      where: { id: projectId },
      data: {
        status: "ANALYZED",
      },
    });
    await patchProjectModelSnapshot(projectId, {
      analysisModelId: model,
      providerConfigId: provider.id,
    });

    await completeTask(task.id, saved.normalizedResult);
    return saved;
  } catch (error) {
    await failTask(task.id, error instanceof Error ? error.message : "Analysis failed");
    throw error;
  }
}

export async function updateAnalysis(projectId: string, normalizedResult: unknown) {
  const jsonValue = normalizedResult as Prisma.InputJsonValue;
  return prisma.productAnalysis.upsert({
    where: { projectId },
    update: { normalizedResult: jsonValue },
    create: {
      projectId,
      rawResult: jsonValue,
      normalizedResult: jsonValue,
    },
  });
}
