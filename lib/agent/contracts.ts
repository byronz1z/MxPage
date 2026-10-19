import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProviderSnapshot } from "@/lib/services/provider-service";
import type { TextProtocol, NativePathPrefix } from "@/lib/ai/text-protocol";

export const planSchema = z.object({
  goal: z.string().min(1).max(2000),
  steps: z.array(z.string().min(1).max(1000)).min(1).max(20),
  tools: z.array(z.string().min(1).max(150)).max(60),
  fileIds: z.array(z.string()).max(50),
  projectIds: z.array(z.string()).max(20),
  applications: z.array(z.string().max(250)).max(10),
  directories: z.array(z.string().max(1000)).max(10),
  generationCount: z.number().int().min(0).max(30).describe("批准的图像生成数量上限；仅聊天或导出文档时为 0，不计文档数量"),
  estimatedCost: z.string().max(500),
  permissions: z.array(z.string().max(500)).max(20),
});
export type AgentPlan = z.infer<typeof planSchema>;
export const settingsSchema = z.object({
  modelLimit: z.number().int().min(1).max(200).default(30),
  toolLimit: z.number().int().min(1).max(1000).default(100),
  moneyBudgetUsd: z.number().finite().min(0).max(10000).nullable().default(null),
  requestReserveUsd: z.number().finite().positive().max(1000).default(1),
  pauseOnUnknownCost: z.boolean().default(true),
  search: z.enum(["auto", "tavily", "disabled"]).default("auto"),
  sandboxEnabled: z.boolean().default(false),
  // Images are installed by the user; the Agent cannot pull or choose a different image.
  pythonImage: z.string().regex(/^[a-zA-Z0-9._/:@-]+$/).default("python:3.12-slim"),
  javascriptImage: z.string().regex(/^[a-zA-Z0-9._/:@-]+$/).default("node:24-slim"),
  desktopEnabled: z.boolean().default(false),
  mcp: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    transport: z.enum(["http", "stdio"]),
    url: z.string().max(2000).default(""),
    command: z.string().max(1000).default(""),
    args: z.array(z.string().max(1000)).max(30).default([]),
    enabled: z.boolean().default(false),
  })).max(12).default([]),
  skills: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).max(20).default([]),
});
export type AgentSettings = z.infer<typeof settingsSchema>;
export type AgentSnapshot = {
  version: 1; provider: ProviderSnapshot; modelId: string; protocol: TextProtocol;
  nativePathPrefix?: NativePathPrefix;
  streaming: boolean; vision: boolean; nativeSearch?: boolean; tools: string[]; mcpCatalogHash?: string; settings: AgentSettings;
};
export const messageSchema = z.object({
  content: z.string().trim().min(1).max(30000),
  fileIds: z.array(z.string().max(100)).max(20).default([]),
  idempotencyKey: z.string().min(8).max(120),
});
export const json = (value: unknown) => JSON.parse(JSON.stringify(value));
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const terminal = new Set(["COMPLETED", "FAILED", "STOPPED"]);
export class AgentHalt extends Error {
  constructor(public status: "PAUSED" | "WAITING_INPUT" | "UNCERTAIN" | "STOPPED" | "WAITING_APPROVAL", message: string) { super(message); }
}
// Never persist provider error bodies, request headers, SDK tracing or model reasoning.
export function publicError(error: unknown) {
  if (error instanceof AgentHalt) return error.message;
  if (error instanceof Error && error.message.startsWith("Agent: ")) return error.message.slice(7);
  const code = Number((error as { status?: number })?.status);
  return code === 401 || code === 403 ? "模型或工具鉴权失败，请检查当前浏览器的凭据。" :
    code === 404 ? "所选模型或接口不存在，请检查服务配置。" :
    "执行未完成，已保留检查点。请检查模型、工具连接和权限后再继续；未知结果不会自动重试。";
}
