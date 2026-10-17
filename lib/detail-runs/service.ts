import { prisma } from "@/lib/db/prisma";
import type { RequestProviderCredentials } from "@/lib/services/provider-runtime";
import { createV4DetailRun, controlV4DetailRun, getV4DetailRun } from "./service-v4";

const ACTIVE = ["PENDING", "RUNNING", "WAITING_INPUT"];

export async function recoverInterruptedRuns(projectId: string) {
  await prisma.detailRun.updateMany({ where: { projectId, status: { in: ["PENDING", "RUNNING"] }, OR: [{ leaseUntil: { lt: new Date() } }, { leaseUntil: null }] }, data: { status: "INTERRUPTED", stage: "运行已中断，可继续", leaseToken: null, leaseUntil: null } });
}

export async function assertProjectIdle(projectId: string) {
  await recoverInterruptedRuns(projectId);
  if (await prisma.detailRun.findFirst({ where: { projectId, status: { in: ACTIVE } } })) throw new Error("当前项目有未结束的任务，请先完成或停止它。");
}

export async function getDetailRun(projectId: string, runId?: string) {
  return getV4DetailRun(projectId, runId);
}

export async function createDetailRun(projectId: string, raw: unknown, credentials: RequestProviderCredentials) {
  return createV4DetailRun(projectId, raw, credentials);
}

export async function controlDetailRun(projectId: string, runId: string, action: "answers" | "suggestions" | "resume" | "cancel", raw: unknown, credentials: RequestProviderCredentials) {
  const run = await prisma.detailRun.findUnique({ where: { id: runId }, select: { checkpoint: true } });
  if ((run?.checkpoint as { workflowVersion?: number } | null)?.workflowVersion !== 4) throw new Error("该历史任务不支持继续执行，请重新创建任务。");
  return controlV4DetailRun(projectId, runId, action, raw, credentials);
}
