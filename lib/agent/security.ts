import fs from "node:fs/promises";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { env } from "@/lib/utils/env";
import { AgentHalt, hash, type AgentPlan } from "./contracts";

export function sessionRoot(sessionId: string) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(sessionId)) throw new Error("Agent: 会话标识无效。");
  return path.resolve(env.STORAGE_ROOT, "agent", sessionId);
}
export async function workspacePath(sessionId: string, relative: string, create = false) {
  const root = sessionRoot(sessionId);
  if (!relative || relative.includes("\\") || relative.includes(":") || relative.includes("\0") || path.isAbsolute(relative)) throw new Error("Agent: 文件路径无效。");
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error("Agent: 文件路径超出会话目录。");
  // Reject symlinks/junctions at every component, including the workspace parents.
  const absolute = path.parse(root).root;
  let current = absolute;
  for (const segment of path.relative(absolute, target).split(path.sep)) {
    current = path.join(current, segment);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Agent: 会话路径不能经过符号链接。"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (create) await fs.mkdir(path.dirname(target), { recursive: true });
  return target;
}
export function assertApproved(plan: AgentPlan | null, approvedHash: string | null, toolName: string) {
  if (!plan || hash(plan) !== approvedHash || !plan.tools.includes(toolName)) {
    throw new AgentHalt("WAITING_APPROVAL", "此工具不在已批准方案内，请更新方案并确认。");
  }
}
export function assertResource(plan: AgentPlan, kind: "fileIds" | "projectIds", id: string, createdIds: string[] = []) {
  if (!plan[kind].includes(id) && !createdIds.includes(id)) throw new AgentHalt("WAITING_APPROVAL", "资源超出已批准范围，请更新方案并确认。");
}
function privateAddress(ip: string) {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return true;
    return v === "::" || v === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(v);
  }
  const p = ip.split(".").map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
    (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}
export async function publicUrl(input: string) {
  const url = new URL(input);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new Error("Agent: 只允许读取公开 HTTP(S) 网页。");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw new Error("Agent: 禁止访问本机、内网和云元数据地址。");
  return { url, addresses };
}
