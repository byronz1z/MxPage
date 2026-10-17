import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { assetPublicUrl } from "@/lib/storage/asset-manager";
import { HISTORY_PAGE_SIZE, parseHistoryQuery, type WorkCategory } from "@/lib/utils/project-history";

export async function listProjectHistory(
  query: { category?: string | string[]; page?: string | string[] } = {},
  database: PrismaClient = prisma,
) {
  const requested = parseHistoryQuery(query);
  return database.$transaction(async (db) => {
    const visible: Prisma.ProjectWhereInput = { platform: { not: "__mxpage_system_task__" } };
    const translations = await db.project.findMany({
      where: { ...visible, OR: [
        { id: { startsWith: "translation-" } },
        { modelSnapshot: { path: "$.translationReady", equals: true } },
        { modelSnapshot: { path: "$.workType", equals: "translation" } },
        { detailRuns: { some: { input: { path: "$.mode", equals: "translate" } } } },
        { tasks: { some: { taskType: "TRANSLATE_PAGE" } } },
      ] },
      select: { id: true },
    });
    const translationIds = translations.map(project => project.id);
    // Negating a missing SQLite JSON path excludes ordinary projects too. Exclude IDs instead.
    const filters: Record<WorkCategory, Prisma.ProjectWhereInput> = {
      detail: { AND: [visible, { platform: { not: "xiaohongshu" } }, { id: { notIn: translationIds } }] },
      xiaohongshu: { platform: "xiaohongshu", id: { notIn: translationIds } },
      translation: { ...visible, id: { in: translationIds } },
    };
    const [detail, xiaohongshu] = await Promise.all([
      db.project.count({ where: filters.detail }),
      db.project.count({ where: filters.xiaohongshu }),
    ]);
    const counts = { all: detail + xiaohongshu + translationIds.length, detail, xiaohongshu, translation: translationIds.length };
    const total = counts[requested.category];
    const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
    const page = Math.min(requested.page, totalPages);
    const projects = await db.project.findMany({
      where: requested.category === "all" ? visible : filters[requested.category],
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * HISTORY_PAGE_SIZE,
      take: HISTORY_PAGE_SIZE,
      select: {
        id: true, name: true, platform: true, updatedAt: true,
        assets: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 1, select: { filePath: true } },
        _count: { select: { sections: true } },
      },
    });
    const translated = new Set(translationIds);
    return {
      category: requested.category, page, totalPages, total, pageSize: HISTORY_PAGE_SIZE, counts,
      projects: projects.map(({ assets, _count, ...project }) => ({
        ...project,
        category: (translated.has(project.id) ? "translation" : project.platform === "xiaohongshu" ? "xiaohongshu" : "detail") as WorkCategory,
        sectionCount: _count.sections,
        coverImageUrl: assetPublicUrl(assets[0]),
      })),
    };
  });
}

export type ProjectHistoryPage = Awaited<ReturnType<typeof listProjectHistory>>;
