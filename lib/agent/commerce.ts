import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { prisma } from "@/lib/db/prisma";
import { artifactFile } from "./files";
import { assertResource } from "./security";
import { reserveGenerations, emit, checkRun } from "./store";
import { json, type AgentPlan } from "./contracts";
import { saveUploadAsset } from "@/lib/storage/asset-manager";
import { createDetailRun, getDetailRun, controlDetailRun } from "@/lib/detail-runs/service";
import { getRequestProviderCredentials } from "@/lib/services/provider-runtime";

export async function createAgentProject(sessionId: string, runId: string, callId: string, input: { name: string; description: string; fileIds: string[] }, plan: AgentPlan) {
  const id = `agent-${createHash("sha256").update(`${runId}:${callId}`).digest("hex").slice(0, 32)}`;
  for (const fileId of input.fileIds) assertResource(plan, "fileIds", fileId);
  const project = await prisma.project.upsert({ where: { id }, create: { id, name: input.name, description: input.description, platform: "通用电商", style: "自然清晰" }, update: {} });
  for (const [i, fileId] of input.fileIds.entries()) {
    const { filename, artifact } = await artifactFile(sessionId, fileId);
    if (!artifact.mimeType.startsWith("image/")) throw new Error("Agent: 商品参考文件必须是图片。");
    await saveUploadAsset({ projectId: id, fileName: artifact.name, mimeType: artifact.mimeType, fileBuffer: await fs.readFile(filename), type: i === 0 ? "MAIN" : "ANGLE", isMain: i === 0, sortOrder: i, uploadKey: fileId });
  }
  await prisma.agentArtifact.upsert({ where: { id: `project-${id}` }, create: { id: `project-${id}`, sessionId, runId, kind: "project", name: project.name, mimeType: "application/x-mxpage-project", url: `/projects/${id}/editor` }, update: {} });
  return { projectId: id, name: project.name, url: `/projects/${id}/editor` };
}
export async function assertAgentProject(sessionId: string, plan: AgentPlan, projectId: string) {
  const own = await prisma.agentArtifact.findMany({ where: { sessionId, kind: "project" } });
  assertResource(plan, "projectIds", projectId, own.map(a => a.id.replace(/^project-/, "")));
}
export async function runAgentCreation(sessionId: string, runId: string, token: string, callId: string, input: { projectId: string; mode: "create" | "xhs" | "edit" | "regenerate" | "translate"; sectionId?: string; instruction: string; heroCount: number; detailCount: number }, plan: AgentPlan) {
  await assertAgentProject(sessionId, plan, input.projectId);
  const count = ["edit", "regenerate", "translate"].includes(input.mode) ? 1 : input.heroCount + input.detailCount;
  await prisma.$transaction(tx => reserveGenerations(tx, runId, count));
  const credentials = getRequestProviderCredentials();
  const created = await createDetailRun(input.projectId, { ...input, idempotencyKey: `agent-${runId}-${callId}`.slice(0, 100) }, credentials);
  await emit(runId, "creation", { projectId: input.projectId, run: created });
  return waitAgentCreation(runId, token, input.projectId, created);
}
export async function waitAgentCreation(runId: string, token: string, projectId: string, created: unknown) {
  const credentials = getRequestProviderCredentials();
  // Existing V4 owns its paid-request ledger. Never replay it via a second Agent call.
  let detail: any = created;
  while (["PENDING", "RUNNING"].includes(detail.status)) {
    try { await checkRun(runId, token); }
    catch {
      await controlDetailRun(projectId, detail.id, "cancel", {}, credentials);
      return { projectId, detailRunId: detail.id, status: "STOPPED", url: `/projects/${projectId}/editor` };
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    detail = await getDetailRun(projectId, detail.id);
  }
  await prisma.agentEvent.create({ data: { runId, type: "creation", data: json({ projectId, detailRunId: detail.id, status: detail.status }) } });
  return { projectId, detailRunId: detail.id, status: detail.status, questions: detail.checkpoint?.questions, url: `/projects/${projectId}/editor`, note: detail.status === "WAITING_INPUT" ? "需要用户补充商品信息，请展示问题并等待用户回答。" : undefined };
}
