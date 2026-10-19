import { randomUUID } from "node:crypto";
import type { AgentRun, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { calculateBilling, readBillingRequest, readBillingUsage, readProviderCostUsd } from "@/lib/monitor/billing";
import { getBillingRules } from "@/lib/monitor/billing-settings";
import { AgentHalt, type AgentSnapshot } from "./contracts";

type Cost = { reservationId: string; amount: number; source: "reserved" | "provider" | "estimated" | "unknown"; label: string };
const budgetPause = (message: string) => Object.assign(new AgentHalt("PAUSED", message), { code: "LOCAL_BUDGET_PAUSED", dispatched: false });
export function summarizeBudget(events: { seq: number; type: string; data: any }[]) {
  const charges = new Map<string, Cost & { eventId: number }>();
  let acknowledged = 0;
  for (const event of events) {
    if (event.type === "cost_acknowledged") acknowledged = Math.max(acknowledged, Number(event.data.throughEventId) || 0);
    if (event.type === "cost" && event.data?.reservationId) charges.set(event.data.reservationId, { ...event.data, eventId: event.seq });
  }
  const all = [...charges.values()];
  const sum = (source: Cost["source"]) => all.filter(c => c.source === source).reduce((v, c) => v + c.amount, 0);
  return { total: all.reduce((v, c) => v + c.amount, 0), actual: sum("provider"), estimated: sum("estimated"), reserved: sum("reserved"), unknownReserve: sum("unknown"), unknown: all.filter(c => c.source === "unknown").length, unacknowledged: all.some(c => c.source === "unknown" && c.eventId > acknowledged), lastEventId: Math.max(0, ...events.map(e => e.seq)) };
}
export async function reserveSpendTx(tx: Prisma.TransactionClient, run: AgentRun, label: string) {
  const settings = (run.snapshot as unknown as AgentSnapshot).settings;
  const events = await tx.agentEvent.findMany({ where: { runId: run.id, type: { in: ["cost", "cost_acknowledged"] } }, orderBy: { seq: "asc" } });
  const budget = summarizeBudget(events);
  const cap = settings.moneyBudgetUsd;
  const amount = settings.requestReserveUsd ?? 1;
  if (cap != null) {
    if (settings.pauseOnUnknownCost !== false && budget.unacknowledged) throw budgetPause("存在费用未知的请求，已暂停新调用。请先核对服务账单，再明确确认继续。");
    if (budget.total + amount > cap + 1e-9) throw budgetPause("费用预算不足以预留下一次请求，已暂停新调用；已发出的请求继续保存结果。");
  }
  const reservationId = randomUUID();
  await tx.agentEvent.create({ data: { runId: run.id, type: "cost", data: { reservationId, amount, label, source: "reserved" } } });
  return reservationId;
}
export async function reserveSpend(runId: string, token: string, label: string) {
  return prisma.$transaction(async tx => {
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.leaseToken !== token || run.status !== "RUNNING" || !run.leaseUntil || run.leaseUntil.getTime() < Date.now()) throw new AgentHalt("PAUSED", "任务已暂停，不能发送新请求。");
    return reserveSpendTx(tx, run, label);
  });
}
export type CostResponse = { model?: string | null; category?: string; responseBody: string; requestBody?: unknown; statusCode: number; success: boolean };
export async function settleSpend(runId: string, token: string, reservationId: string | void, response?: CostResponse) {
  if (!reservationId) return;
  let cost: number | null = null, source: Cost["source"] = "unknown";
  if (response) {
    let body: any; try { body = JSON.parse(response.responseBody); } catch { /* Stream/unknown result stays reserved. */ }
    if (body && response.success) {
      const billing = calculateBilling({ model: response.model ?? null, success: response.success, category: response.category ?? "chat", actualCostUsd: readProviderCostUsd(body), billingUsage: readBillingUsage(body), billingRequest: readBillingRequest(response.requestBody) }, await getBillingRules());
      cost = billing.costUsd; source = cost == null ? "unknown" : billing.source === "provider" ? "provider" : "estimated";
    } else if ([400, 401, 403, 404, 405, 422, 429].includes(response.statusCode)) { cost = 0; source = "estimated"; }
  }
  await prisma.$transaction(async tx => {
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.leaseToken !== token) return; // stop/pause drains; a different owner cannot commit.
    const events = await tx.agentEvent.findMany({ where: { runId, type: "cost" }, orderBy: { seq: "desc" } });
    const previous = events.find(event => (event.data as any)?.reservationId === reservationId)?.data as Cost | undefined;
    if (!previous || previous.source !== "reserved") return;
    await tx.agentEvent.create({ data: { runId, type: "cost", data: { ...previous, amount: cost ?? previous.amount, source } } });
  });
}
