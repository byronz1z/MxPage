import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/utils/env";
import { json, settingsSchema } from "./contracts";

export async function getAgentSettings() {
  const saved = await prisma.agentSetting.findUnique({ where: { id: "default" } });
  return settingsSchema.parse(saved?.value ?? {});
}
export async function saveAgentSettings(value: unknown) {
  const settings = settingsSchema.parse(value);
  if (new Set(settings.mcp.map(m => m.id)).size !== settings.mcp.length) throw new Error("Agent: MCP 标识不能重复。");
  for (const service of settings.mcp) {
    if (service.transport === "http") {
      const url = new URL(service.url);
      if (url.protocol !== "https:" || url.username || url.password || url.search) throw new Error("Agent: 远程 MCP 需要无凭据、无查询参数的 HTTPS 地址。密钥只由浏览器传入。");
    } else if (service.enabled && (env.APP_RUNTIME !== "desktop" || !path.isAbsolute(service.command))) throw new Error("Agent: 本地 MCP 仅支持桌面版中明确配置的绝对可执行文件路径。");
  }
  await prisma.agentSetting.upsert({ where: { id: "default" }, create: { id: "default", value: json(settings) }, update: { value: json(settings) } });
  return settings;
}
export async function installedSkills() {
  const root = path.resolve(env.STORAGE_ROOT, "agent-skills");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const result: Array<{ id: string; instructions: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.name)) continue;
    const target = path.join(root, entry.name, "SKILL.md");
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 32000) continue;
    result.push({ id: entry.name, instructions: await fs.readFile(target, "utf8") });
  }
  return result;
}
