import type { Prisma } from "@prisma/client";

// Legacy translation uploads remain available to comparison and batch recovery.
// Hide only source-only uploads that have an existing, prepared result project.
export async function visibleProjectsWhere(db: Pick<Prisma.TransactionClient, "project">): Promise<Prisma.ProjectWhereInput> {
  const trash = await db.project.findMany({ where: { modelSnapshot: { path: "$.trashedAt", string_starts_with: "" } }, select: { id: true, modelSnapshot: true } });
  const results = await db.project.findMany({
    where: { modelSnapshot: { path: "$.translationReady", equals: true } },
    select: { id: true, modelSnapshot: true },
  });
  const sourceIds = results.flatMap(result => {
    const sourceId = (result.modelSnapshot as { translationSourceProjectId?: unknown } | null)?.translationSourceProjectId;
    return typeof sourceId === "string" && sourceId !== result.id ? [sourceId] : [];
  });
  const duplicates = sourceIds.length ? await db.project.findMany({
    where: {
      id: { in: [...new Set(sourceIds)] },
      modelSnapshot: { path: "$.workType", equals: "translation" },
      sections: { none: {} },
      tasks: { none: {} },
      detailRuns: { none: {} },
      assets: { none: { type: { in: ["GENERATED", "EXPORTED"] } } },
    },
    select: { id: true },
  }) : [];
  return { platform: { not: "__mxpage_system_task__" }, id: { notIn: [...duplicates.map(project => project.id), ...trash.filter(project => typeof (project.modelSnapshot as { trashedAt?: unknown })?.trashedAt === "string").map(project => project.id)] } };
}
