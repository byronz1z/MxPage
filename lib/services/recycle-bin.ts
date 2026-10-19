import { prisma } from "@/lib/db/prisma";
import { patchProjectModelSnapshot } from "./project-model-snapshot-service";
import { assertNoDetailRun, withAssetUploadLock } from "@/lib/detail-runs/lock";

export function isTrashed(snapshot: unknown) { return typeof (snapshot as { trashedAt?: unknown } | null)?.trashedAt === "string"; }
export async function listTrash() {
  const projects = await prisma.project.findMany({ select: { id: true, name: true, modelSnapshot: true, updatedAt: true }, orderBy: { updatedAt: "desc" } });
  return projects.filter(project => isTrashed(project.modelSnapshot)).map(({ modelSnapshot, ...project }) => ({ ...project, trashedAt: (modelSnapshot as { trashedAt: string }).trashedAt }));
}
export async function trashProject(id: string) {
  return withAssetUploadLock(id, async () => {
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project || isTrashed(project.modelSnapshot)) return project;
    if (project.platform === "__mxpage_system_task__") throw new Error("系统任务不能移入回收站。");
    await assertNoDetailRun(id);
    const pending = await prisma.generationTask.findFirst({ where: { projectId: id, status: { in: ["PENDING", "RUNNING"] } } });
    const batches = await prisma.generationTask.findMany({ where: { taskType: "BATCH_CREATE", status: { in: ["PENDING", "RUNNING"] } }, select: { inputPayload: true, outputPayload: true } });
    if (pending || batches.some(batch => {
      const input = batch.inputPayload as { projectIds?: string[] } | null;
      const output = batch.outputPayload as { items?: Array<{ projectId: string; sourceProjectId?: string }> } | null;
      return input?.projectIds?.includes(id) || output?.items?.some(item => item.projectId === id || item.sourceProjectId === id);
    })) throw new Error("作品仍有关联任务，请先停止并等待任务结束后移入回收站。");
    return patchProjectModelSnapshot(id, { trashedAt: new Date().toISOString() });
  });
}
export async function restoreTrash(id: string) {
  return withAssetUploadLock(id, async () => {
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) throw new Error("Project not found.");
    if (!isTrashed(project.modelSnapshot)) return project;
    return patchProjectModelSnapshot(id, { trashedAt: null });
  });
}
