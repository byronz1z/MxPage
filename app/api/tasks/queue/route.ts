import { prisma } from "@/lib/db/prisma";
import { buildTaskQueue, taskShouldShow } from "@/lib/tasks/queue";
import { handleRouteError, ok } from "@/lib/utils/route";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const history = new URL(request.url).searchParams.get("history") === "1";
    const since = new Date(Date.now() - 7 * 86_400_000);
    const include = { project: { select: { name: true, platform: true } } };
    const [activeTasks, recentTasks, activeRuns, recentRuns] = await Promise.all([
      prisma.generationTask.findMany({ where: { status: { in: ["PENDING", "RUNNING"] } }, include, orderBy: { createdAt: "desc" } }),
      prisma.generationTask.findMany({ where: { status: { notIn: ["PENDING", "RUNNING"] }, ...(!history ? { updatedAt: { gte: since } } : {}) }, include, orderBy: { createdAt: "desc" }, take: history ? 200 : 40 }),
      prisma.detailRun.findMany({ where: { status: { in: ["PENDING", "RUNNING", "WAITING_INPUT", "WAITING_PROMPTS"] } }, include, orderBy: { createdAt: "desc" } }),
      prisma.detailRun.findMany({ where: { status: { notIn: ["PENDING", "RUNNING", "WAITING_INPUT", "WAITING_PROMPTS"] }, ...(!history ? { updatedAt: { gte: since } } : {}) }, include, orderBy: { createdAt: "desc" }, take: history ? 200 : 40 }),
    ]);
    const items = buildTaskQueue([...activeTasks, ...recentTasks], [...activeRuns, ...recentRuns]);
    return ok(history ? items.sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 200) : items.filter(taskShouldShow));
  } catch (error) { return handleRouteError(error); }
}
