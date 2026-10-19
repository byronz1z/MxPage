import { HERO_MAX, DETAIL_MAX } from "@/lib/utils/image-counts";
import { createHash } from "crypto";

import { prisma } from "@/lib/db/prisma";
import { assertNoDetailRun } from "@/lib/detail-runs/lock";
import { patchProjectModelSnapshot } from "@/lib/services/project-model-snapshot-service";
import { assetPublicUrl, deleteAssetRecord } from "@/lib/storage/asset-manager";
import { visibleProjectsWhere } from "./project-visibility";
import { isTrashed, trashProject } from "./recycle-bin";
import { thumbnailUrl } from "@/lib/utils/thumbnail";

function readPreviewConfig(snapshot: unknown) {
  const data = (snapshot as Record<string, unknown> | null) ?? {};
  const previewConfig = (data.previewConfig as Record<string, unknown> | null) ?? {};

  return {
    heroImageCount: Math.min(HERO_MAX, Math.max(0, Number(previewConfig.heroImageCount ?? 4))),
    detailSectionCount: Math.min(DETAIL_MAX, Math.max(0, Number(previewConfig.detailSectionCount ?? 6))),
  };
}

async function deleteAssetIfUnreferenced(assetId: string | null | undefined) {
  if (!assetId) {
    return;
  }

  const versionRefCount = await prisma.sectionVersion.count({
    where: { imageAssetId: assetId },
  });
  const currentRefCount = await prisma.pageSection.count({
    where: { currentImageAssetId: assetId },
  });

  if (versionRefCount === 0 && currentRefCount === 0) {
    await deleteAssetRecord(assetId);
  }
}

async function normalizeSectionOrder(projectId: string) {
  const sections = await prisma.pageSection.findMany({
    where: { projectId },
    orderBy: { order: "asc" },
    select: { id: true },
  });

  await prisma.$transaction(
    sections.map((section, index) =>
      prisma.pageSection.update({
        where: { id: section.id },
        data: { order: index },
      }),
    ),
  );
}

async function pruneProjectToPreviewConfig(projectId: string, snapshot: unknown) {
  const previewConfig = readPreviewConfig(snapshot);
  const sections = await prisma.pageSection.findMany({
    where: { projectId },
    orderBy: { order: "asc" },
    include: {
      versions: {
        orderBy: { versionNumber: "desc" },
        include: {
          imageAsset: true,
        },
      },
      generatedAssets: true,
    },
  });

  const removableSections = [
    ...sections.filter((section) => section.type === "HERO").slice(previewConfig.heroImageCount),
    ...sections.filter((section) => section.type !== "HERO").slice(previewConfig.detailSectionCount),
  ];

  for (const section of removableSections) {
    const assetIds = [
      ...new Set(
        [
          section.currentImageAssetId,
          ...section.versions.map((version) => version.imageAssetId),
          ...section.generatedAssets.map((asset) => asset.id),
        ].filter(Boolean),
      ),
    ] as string[];

    await prisma.pageSection.delete({
      where: { id: section.id },
    });

    for (const assetId of assetIds) {
      await deleteAssetIfUnreferenced(assetId);
    }
  }

  if (removableSections.length > 0) {
    await normalizeSectionOrder(projectId);
  }
}

export async function listProjects() {
  const projects = await prisma.project.findMany({
    where: await visibleProjectsWhere(prisma),
    orderBy: { updatedAt: "desc" },
    include: {
      assets: {
        orderBy: { sortOrder: "asc" },
        take: 1,
      },
      sections: { orderBy: [{ order: "asc" }, { id: "asc" }], include: { currentImageAsset: { select: { id: true, filePath: true } } } },
    },
  });

  return projects.map((project) => ({
    ...project,
    coverImageUrl: assetPublicUrl(project.sections.find(section => section.currentImageAsset)?.currentImageAsset ?? project.assets[0]),
    coverThumbnailUrl: thumbnailUrl(project.sections.find(section => section.currentImageAsset)?.currentImageAsset ?? project.assets[0]),
    sectionCount: project.sections.length,
  }));
}

export async function createProject(input: {
  name: string;
  platform: string;
  style: string;
  description?: string | null;
  translationUpload?: { batchId: string; groupIndex: number };
}) {
  if (input.translationUpload) {
    const { translationUpload, ...data } = input;
    const id = `translation-upload-${createHash("sha256").update(`${translationUpload.batchId}:${translationUpload.groupIndex}`).digest("hex").slice(0, 32)}`;
    const fingerprint = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    const project = await prisma.project.upsert({ where: { id }, create: { ...data, id, modelSnapshot: { workType: "translation", translationBatchId: translationUpload.batchId, uploadFingerprint: fingerprint } }, update: {} });
    if ((project.modelSnapshot as { uploadFingerprint?: string })?.uploadFingerprint !== fingerprint) throw new Error("同一上传标识不能用于不同项目，请重新提交。");
    return project;
  }
  return prisma.project.create({
    data: input,
  });
}

export async function getProjectDetail(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      assets: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      analysis: true,
      sections: {
        orderBy: { order: "asc" },
        include: {
          currentImageAsset: true,
          versions: {
            orderBy: { versionNumber: "desc" },
            include: {
              imageAsset: true,
            },
          },
        },
      },
      tasks: {
        orderBy: { createdAt: "desc" },
        take: 20,
      },
    },
  });

  if (!project || isTrashed(project.modelSnapshot)) {
    return null;
  }

  return {
    ...project,
    assets: project.assets.map((asset) => ({
      ...asset,
      url: assetPublicUrl(asset),
    })),
    sections: project.sections.map((section) => ({
      ...section,
      imageUrl: assetPublicUrl(section.currentImageAsset),
      versions: section.versions.map((version) => ({
        ...version,
        imageUrl: assetPublicUrl(version.imageAsset),
      })),
    })),
  };
}

export async function updateProject(projectId: string, input: Record<string, unknown>) {
  await assertNoDetailRun(projectId);
  const { modelSnapshot, ...projectPatch } = input;
  if (Object.keys(projectPatch).length > 0) {
    await prisma.project.update({
      where: { id: projectId },
      data: projectPatch,
    });
  }

  if ("modelSnapshot" in input) {
    const updated = await patchProjectModelSnapshot(projectId, modelSnapshot);
    await pruneProjectToPreviewConfig(projectId, updated?.modelSnapshot);
  }

  return getProjectDetail(projectId);
}

export async function deleteProject(projectId: string) {
  return trashProject(projectId);
}
