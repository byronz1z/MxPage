import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { workspacePath } from "./security";
import { saveAgentFile, fileTypes, artifactFile } from "./files";
import type { AgentSettings } from "./contracts";

function docker(args: string[], timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Agent: Docker 操作超时。")); }, timeout);
    const read = (chunk: Buffer) => { if (output.length < 50000) output += chunk.toString(); };
    child.stdout.on("data", read); child.stderr.on("data", read);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Agent: Docker 未安装或尚未启动。")); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error("Agent: Docker 执行失败，请检查镜像、服务和资源限制。")); });
  });
}
export async function sandboxAvailable(settings: AgentSettings) {
  if (!settings.sandboxEnabled) return { available: false, reason: "尚未启用 Docker 沙箱" };
  try { await docker(["info", "--format", "{{.OSType}}"]); return { available: true }; }
  catch { return { available: false, reason: "Docker 未安装、未启动或当前用户无权访问" }; }
}
export async function executeSandbox(sessionId: string, runId: string, language: "python" | "javascript", code: string, settings: AgentSettings, fileIds: string[] = []) {
  if (!settings.sandboxEnabled) throw new Error("Agent: 代码沙箱未启用。");
  const image = language === "python" ? settings.pythonImage : settings.javascriptImage;
  await docker(["image", "inspect", image]); // Never auto-pull an unapproved image.
  const folder = `sandbox/${randomUUID()}`;
  const script = await workspacePath(sessionId, `${folder}/main.${language === "python" ? "py" : "js"}`, true);
  await fs.writeFile(script, code, "utf8");
  await fs.chmod(path.dirname(script), 0o777);
  const inputs = new Set<string>();
  for (const fileId of fileIds) {
    const { filename, artifact } = await artifactFile(sessionId, fileId);
    const name = `${artifact.id}${path.extname(artifact.name)}`;
    await fs.copyFile(filename, await workspacePath(sessionId, `${folder}/${name}`)); inputs.add(name);
  }
  const name = `mxpage-${randomUUID()}`;
  try {
    const output = await docker(["run", "--rm", "--pull=never", "--name", name, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--ulimit=fsize=26214400:26214400", "--cpus=1", "--memory=256m", "--user=65534:65534", "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m", "--mount", `type=bind,src=${path.dirname(script)},dst=/workspace`, "--workdir=/workspace", image, language === "python" ? "python" : "node", path.basename(script)], 60000);
    const artifacts = [];
    for (const file of await fs.readdir(path.dirname(script), { withFileTypes: true })) {
      if (!file.isFile() || file.isSymbolicLink() || file.name === path.basename(script) || inputs.has(file.name) || !fileTypes[path.extname(file.name).slice(1)]) continue;
      const target = await workspacePath(sessionId, `${folder}/${file.name}`);
      if ((await fs.stat(target)).size <= 25 * 1024 * 1024) artifacts.push(await saveAgentFile(sessionId, file.name, await fs.readFile(target), "document", runId));
    }
    return { output, artifacts };
  } finally { await docker(["rm", "-f", name]).catch(() => undefined); }
}
