import fs from "node:fs/promises";
import { prisma } from "@/lib/db/prisma";
import { runWithProviderCredentials } from "@/lib/services/provider-runtime";
import { prepareTextCompatibility } from "@/lib/services/provider-compatibility";
import { AgentHalt, hash, json, messageSchema, planSchema, type AgentSnapshot } from "./contracts";
import { getAgentSession, emit, recoverAgentRuns } from "./store";
import { getAgentSettings } from "./settings";
import { prepareAgentModel } from "./model";
import { workspaceTools, commerceTools } from "./tools";
import { connectMcpTools } from "./mcp";
import { launchAgentRun, type AgentCredentials } from "./runtime";
import { desktopBridgeAvailable, desktopRequest } from "./desktop";
import { sessionRoot, workspacePath } from "./security";

export async function createAgentRun(sessionId: string, raw: unknown, credentials: AgentCredentials) {
  const input = messageSchema.parse(raw);
  const prior = await prisma.agentRun.findUnique({ where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: input.idempotencyKey } } });
  if (prior) { if (hash(prior.input) !== hash(input)) throw new Error("Agent: 同一提交标识不能用于不同消息。"); return prior; }
  const session = await getAgentSession(sessionId);
  if (session.archived) throw new Error("Agent: 请先取消归档后继续此会话。");
  if (session.runs.some(r => !["COMPLETED", "FAILED", "STOPPED"].includes(r.status))) throw new Error("Agent: 请先处理当前任务，或新建会话。");
  if (input.fileIds.some(id => !session.artifacts.some(a => a.id === id))) throw new Error("Agent: 附件不属于此会话。");
  const settings = await getAgentSettings();
  if (settings.moneyBudgetUsd === 0) throw new Error("Agent: 当前费用预算为 0，请先在 Agent 设置中调整预算。");
  const connected = await connectMcpTools(settings, credentials.mcpTokens || {});
  const tools = [...workspaceTools().map(t => t.name), ...connected.tools.map(t => t.name)].filter(name => {
    if (["computer", "desktop_tools", "browser"].includes(name)) return settings.desktopEnabled && desktopBridgeAvailable();
    if (name === "execute_code") return settings.sandboxEnabled;
    if (name === "search_web") return settings.search !== "disabled" && Boolean(credentials.tavilyKey);
    return true;
  });
  await connected.close();
  const snapshot = await runWithProviderCredentials(credentials, () => prepareAgentModel(session.modelId, settings, tools));
  snapshot.mcpCatalogHash = connected.catalogHash;
  if (settings.search === "auto" && snapshot.nativeSearch && !snapshot.tools.includes("search_web")) snapshot.tools.push("search_web");
  if (input.fileIds.some(id => session.artifacts.some(a => a.id === id && a.mimeType.startsWith("image/"))) && !snapshot.vision) throw new Error("Agent: 当前模型不支持图片输入，请为此会话选择视觉模型。");
  const run = await prisma.$transaction(async tx => {
    await tx.agentSession.update({ where: { id: sessionId }, data: { updatedAt: new Date(), ...(session.messages.length === 0 ? { title: input.content.slice(0, 50) } : {}) } });
    const same = await tx.agentRun.findUnique({ where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: input.idempotencyKey } } });
    if (same) { if (hash(same.input) !== hash(input)) throw new Error("Agent: 提交标识冲突。"); return same; }
    if (await tx.agentRun.count({ where: { sessionId, status: { notIn: ["COMPLETED", "FAILED", "STOPPED"] } } })) throw new Error("Agent: 当前会话有未结束任务。");
    const run = await tx.agentRun.create({ data: { sessionId, idempotencyKey: input.idempotencyKey, input: json(input), snapshot: json(snapshot), modelLimit: settings.modelLimit, toolLimit: settings.toolLimit } });
    await tx.agentMessage.create({ data: { sessionId, role: "user", content: input.content + (input.fileIds.length ? `\n\n附件 ID：${input.fileIds.join("、")}` : ""), attachments: input.fileIds, createdAt: run.createdAt } });
    return run;
  });
  launchAgentRun(run.id, credentials);
  return run;
}
export async function controlAgentRun(id: string, action: string, body: Record<string, unknown>, credentials: AgentCredentials) {
  await recoverAgentRuns();
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id } });
  if (["pause", "stop"].includes(action)) {
    if (["COMPLETED", "FAILED", "STOPPED"].includes(run.status)) return run;
    const status = action === "stop" ? "STOPPED" : "PAUSED";
    await prisma.agentRun.update({ where: { id }, data: { status } });
    if (desktopBridgeAvailable()) await desktopRequest("revoke", { runId: id }).catch(() => undefined);
    await emit(id, "status", { status });
    return prisma.agentRun.findUniqueOrThrow({ where: { id } });
  }
  if (["COMPLETED", "FAILED", "STOPPED"].includes(run.status)) throw new Error("Agent: 此任务已结束，请发送新消息。");
  if (run.leaseToken && run.leaseUntil && run.leaseUntil.getTime() > Date.now()) {
    if (action === "approve" && run.approvedHash === body.planHash) return run;
    throw new Error("Agent: 已发出的请求仍在收尾，请稍后继续。");
  }
  const snapshot = run.snapshot as unknown as AgentSnapshot;
  if (!credentials.apiKey) throw new Error("Agent: 继续任务需要当前浏览器的 API Key。");
  if (action === "approve") {
    if (run.status !== "WAITING_APPROVAL") throw new Error("Agent: 当前任务不在等待方案确认。");
    const plan = planSchema.parse(run.plan);
    if (body.planHash !== hash(plan)) throw new Error("Agent: 方案已更新，请刷新后确认最新方案。");
    if (plan.tools.some(name => !snapshot.tools.includes(name))) throw new Error("Agent: 方案工具已超出任务快照。");
    if (plan.tools.some(t => ["computer", "browser"].includes(t)) || plan.tools.some(t => snapshot.settings.mcp.some(s => s.transport === "stdio" && t.startsWith(`mcp_${s.id}_`)))) {
      const grant = await desktopRequest("has_grant", { runId: id, planHash: hash(plan) });
      if (!grant.granted) throw new Error("Agent: 请在桌面工作台确认本机操作范围。");
    }
    if (plan.tools.some(name => commerceTools.includes(name))) {
      const selected = snapshot.provider.models.filter(m => m.isDefaultAnalysis || m.isDefaultPlanning).map(m => m.modelId);
      const protocols = await prepareTextCompatibility(snapshot.provider as any, credentials.apiKey, { textModelIds: selected });
      snapshot.provider.textModelSettings = { ...snapshot.provider.textModelSettings, ...protocols };
    }
    const claimed = await prisma.agentRun.updateMany({ where: { id, status: "WAITING_APPROVAL", updatedAt: run.updatedAt }, data: { approvedHash: hash(plan), snapshot: json(snapshot), mode: "task" } });
    if (!claimed.count) return prisma.agentRun.findUniqueOrThrow({ where: { id } });
    launchAgentRun(id, credentials, { approved: true });
  } else if (["resume", "answer"].includes(action)) {
    if (run.status === "WAITING_APPROVAL") throw new Error("Agent: 必须先确认方案。");
    if (run.status === "UNCERTAIN" && !Array.isArray(body.retryCallIds)) throw new Error("Agent: 请明确选择要重试的未知调用；重试可能重复计费。");
    if (Array.isArray(body.retryCallIds)) {
      const calls = await prisma.agentToolCall.findMany({ where: { runId: id, id: { in: body.retryCallIds.filter((i): i is string => typeof i === "string") }, status: { in: ["RUNNING", "UNCERTAIN", "BLOCKED"] } } });
      if (calls.some(call => ["computer", "browser"].includes(call.name))) throw new Error("Agent: 电脑和浏览器的点击、输入不能重放。请停止此任务，再新建任务重新观察。");
      await prisma.agentToolCall.updateMany({ where: { id: { in: calls.map(c => c.id) } }, data: { status: "RETRY" } });
    }
    if (body.extendBudget === true) await prisma.agentRun.update({ where: { id }, data: { modelLimit: { increment: snapshot.settings.modelLimit }, toolLimit: { increment: snapshot.settings.toolLimit } } });
    if (body.additionalBudgetUsd !== undefined) {
      const amount = body.additionalBudgetUsd;
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 10000) throw new Error("Agent: 追加费用预算必须在 0–10000 USD 之间。");
      if (snapshot.settings.moneyBudgetUsd == null) throw new Error("Agent: 此任务未设置金额预算。");
      await prisma.$transaction(async tx => {
        const current = await tx.agentRun.findUniqueOrThrow({ where: { id } });
        if (current.status === "RUNNING") throw new Error("Agent: 请先暂停任务再追加费用预算。");
        const saved = current.snapshot as unknown as AgentSnapshot;
        saved.settings.moneyBudgetUsd = (saved.settings.moneyBudgetUsd ?? 0) + amount;
        await tx.agentRun.update({ where: { id }, data: { snapshot: json(saved) } });
        await tx.agentEvent.create({ data: { runId: id, type: "budget_extended", data: { amountUsd: amount } } });
      });
    }
    if (body.acknowledgeUnknownCosts === true) {
      const latest = await prisma.agentEvent.findFirst({ where: { runId: id, type: "cost" }, orderBy: { seq: "desc" } });
      await emit(id, "cost_acknowledged", { throughEventId: latest?.seq ?? 0 });
    }
    const answer = typeof body.answer === "string" ? body.answer.trim().slice(0, 10000) : "";
    if (action === "answer") {
      if (!answer) throw new Error("Agent: 请填写补充信息。");
      await prisma.agentMessage.create({ data: { sessionId: run.sessionId, role: "user", content: answer } });
    }
    if ((run.plan as any)?.tools?.some((name: string) => ["computer", "browser"].includes(name)) && run.approvedHash) await desktopRequest("require_observation", { runId: id, planHash: run.approvedHash });
    launchAgentRun(id, credentials, { answer });
  } else throw new Error("Agent: 不支持的任务操作。");
  return prisma.agentRun.findUniqueOrThrow({ where: { id } });
}
export async function deleteAgentSession(id: string) {
  if (await prisma.agentRun.count({ where: { sessionId: id, leaseToken: { not: null }, leaseUntil: { gt: new Date() } } })) throw new Error("Agent: 请先停止任务并等待请求收尾，再删除会话。");
  await workspacePath(id, ".deletion-check"); // Reject parent symlinks before recursive removal.
  const root = sessionRoot(id); // validated absolute child of STORAGE_ROOT/agent
  await prisma.agentSession.delete({ where: { id } });
  await fs.rm(root, { recursive: true, force: true });
}
