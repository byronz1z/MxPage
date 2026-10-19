import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AgentHalt, hash, json, terminal, type AgentPlan } from "./contracts";
import { reserveSpendTx } from "./budget";

export const emit = (runId: string, type: string, data: unknown) => prisma.agentEvent.create({ data: { runId, type, data: json(data) } });
export async function stopDesktopRuns(runIds: string[]) {
  if (!Array.isArray(runIds)) return;
  for (const id of runIds.filter(id => typeof id === "string")) {
    const result = await prisma.agentRun.updateMany({ where: { id, status: { notIn: ["COMPLETED", "FAILED", "STOPPED"] } }, data: { status: "STOPPED", error: "已通过桌面全局停止操作终止任务。" } });
    if (result.count) await emit(id, "status", { status: "STOPPED" });
  }
}
export async function recoverAgentRuns(sessionId?: string) {
  await prisma.agentRun.updateMany({ where: { ...(sessionId ? { sessionId } : {}), status: { in: ["PENDING", "RUNNING"] }, OR: [{ leaseUntil: { lt: new Date() } }, { leaseUntil: null }] }, data: { status: "INTERRUPTED", leaseToken: null, leaseUntil: null, error: "服务已重启或连接中断。请重新提供当前浏览器凭据后继续。" } });
}
export async function getAgentSession(id: string) {
  await recoverAgentRuns(id);
  return prisma.agentSession.findUniqueOrThrow({ where: { id }, include: { messages: { orderBy: { createdAt: "asc" } }, runs: { orderBy: { createdAt: "desc" }, take: 30 }, artifacts: { orderBy: { createdAt: "asc" } } } });
}
export async function claimAgentRun(id: string) {
  const token = randomUUID();
  const result = await prisma.agentRun.updateMany({ where: { id, status: { in: ["PENDING", "PAUSED", "INTERRUPTED", "WAITING_INPUT", "WAITING_APPROVAL", "UNCERTAIN"] }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { status: "RUNNING", leaseToken: token, leaseUntil: new Date(Date.now() + 60000), error: null } });
  return result.count ? token : null;
}
export async function checkRun(id: string, token: string) {
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id } });
  if (run.leaseToken !== token || !run.leaseUntil || run.leaseUntil.getTime() < Date.now()) throw new AgentHalt("PAUSED", "执行所有权已失效，请刷新后继续。");
  if (run.status !== "RUNNING") throw new AgentHalt(run.status === "STOPPED" ? "STOPPED" : "PAUSED", "任务已暂停；已发出的请求会保留结果。");
  return run;
}
export async function reserveCall(runId: string, token: string, callId: string, name: string, args: unknown, model = false) {
  return prisma.$transaction(async tx => {
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.leaseToken !== token || run.status !== "RUNNING" || !run.leaseUntil || run.leaseUntil.getTime() < Date.now()) throw new AgentHalt("PAUSED", "任务已暂停。");
    const existing = await tx.agentToolCall.findUnique({ where: { runId_callId: { runId, callId } } });
    if (existing) {
      if (existing.argsHash !== hash(args) || existing.name !== name) throw new Error("Agent: 调用标识与已保存输入冲突。");
      if (existing.status === "COMPLETED") return { existing };
      // Retrying is possible only after the UI explicitly marks this particular call RETRY.
      if (existing.status !== "RETRY") throw new AgentHalt("UNCERTAIN", "上次调用尚未确认结果，请在调用记录中显式处理，避免重复计费或重复操作。");
    }
    if (model ? run.modelCalls >= run.modelLimit : run.toolCalls >= run.toolLimit) throw new AgentHalt("PAUSED", "已达到本轮调用预算。确认追加预算后可继续。");
    const budgetId = model || name.startsWith("mcp_") || name === "search_web" ? await reserveSpendTx(tx, run, name) : undefined;
    await tx.agentRun.update({ where: { id: runId }, data: model ? { modelCalls: { increment: 1 } } : { toolCalls: { increment: 1 } } });
    const call = await tx.agentToolCall.upsert({ where: { runId_callId: { runId, callId } }, create: { runId, callId, name, argsHash: hash(args) }, update: { status: "RUNNING", error: null } });
    return { call, budgetId };
  });
}
export async function completeCall(runId: string, token: string, id: string, output: unknown) {
  // A pause/stop drains in-flight work, but a different owner may never commit it.
  await prisma.$transaction(async tx => {
    const lock = await tx.agentRun.updateMany({ where: { id: runId, leaseToken: token }, data: { updatedAt: new Date() } });
    if (!lock.count) throw new AgentHalt("PAUSED", "执行所有权已改变。");
    await tx.agentToolCall.update({ where: { id }, data: { status: "COMPLETED", output: json(output) } });
  });
}
export async function updatePlan(runId: string, token: string, plan: AgentPlan) {
  const run = await checkRun(runId, token);
  const changed = await prisma.agentRun.updateMany({ where: { id: run.id, leaseToken: token, status: "RUNNING" }, data: { plan: json(plan), approvedHash: null } });
  if (!changed.count) throw new AgentHalt("PAUSED", "任务已暂停。");
  await emit(runId, "plan", plan);
}
export async function finishRun(runId: string, token: string, status: string, error?: string) {
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  const next = terminal.has(run.status) || run.status === "PAUSED" ? run.status : status;
  const result = await prisma.agentRun.updateMany({ where: { id: runId, leaseToken: token }, data: { status: next, error, leaseToken: null, leaseUntil: null } });
  if (result.count) await emit(runId, "status", { status: next, error });
}
export async function reserveGenerations(tx: Prisma.TransactionClient, runId: string, count: number) {
  const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
  const plan = run.plan as unknown as AgentPlan;
  const calls = await tx.agentEvent.findMany({ where: { runId, type: "generation_reserved" } });
  const used = calls.reduce((sum, call) => sum + Number((call.data as { count: number }).count), 0);
  if (used + count > plan.generationCount) throw new AgentHalt("WAITING_APPROVAL", "生成数量超出批准方案，需要确认更新后的方案。");
  await tx.agentEvent.create({ data: { runId, type: "generation_reserved", data: { count } } });
}
