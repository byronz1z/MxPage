import fs from "node:fs/promises";
import { createReadStream, constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { env } from "@/lib/utils/env";
import { prisma } from "@/lib/db/prisma";

// Node 24's online SQLite backup also captures WAL data. No live database copying.
const { DatabaseSync, backup } = require("node:sqlite");
type FileEntry = { path: string; sha256: string; bytes: number };
type Manifest = { version: 1; id: string; createdAt: string; database: FileEntry; files: FileEntry[]; projects: number };
const runtime = globalThis as typeof globalThis & { dataBackupBusy?: boolean };
const tables = ["Project", "ProductAnalysis", "PageSection", "ProductAsset", "SectionVersion", "GenerationTask", "DetailRun"];
const agentTables = ["AgentSession", "AgentMessage", "AgentRun", "AgentEvent", "AgentToolCall", "AgentArtifact", "AgentCheckpoint", "AgentCheckpointWrite"];
function hasAgentTables(db: any, schema = "main") { return Boolean(db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name='AgentSession'`).get()); }
function assetPaths(db: any) {
  return [...db.prepare('SELECT filePath FROM ProductAsset').all(), ...(hasAgentTables(db) ? db.prepare('SELECT filePath FROM AgentArtifact WHERE filePath IS NOT NULL').all() : [])] as Array<{ filePath: string }>;
}

export function dataPaths() {
  const raw = env.DATABASE_URL.replace(/^file:/, "");
  const database = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve("prisma", raw);
  const storage = path.resolve(env.STORAGE_ROOT);
  const backups = path.join(path.dirname(storage), `${path.basename(storage)}-backups`);
  if (backups.startsWith(storage + path.sep)) throw new Error("备份目录必须位于素材目录之外。");
  return { database, storage, backups };
}
function inside(root: string, relative: string) {
  if (!relative || relative.includes("\\") || relative.includes(":")) throw new Error("备份文件路径无效。");
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error("备份文件路径越界。");
  return target;
}
async function checkedPath(root: string, relative: string) {
  const target = inside(root, relative);
  try { if ((await fs.lstat(root)).isSymbolicLink()) throw new Error("数据目录不能是符号链接。"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let current = path.resolve(root);
  for (const part of path.relative(current, target).split(path.sep)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("备份或素材目录不能包含符号链接。"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return target;
}
async function digest(file: string) {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest("hex"), bytes };
}
async function exclusive<T>(work: () => Promise<T>) {
  if (runtime.dataBackupBusy) throw new Error("备份或恢复正在进行，请稍后再试。");
  runtime.dataBackupBusy = true;
  try { return await work(); } finally { runtime.dataBackupBusy = false; }
}
async function snapshot() {
  const roots = dataPaths();
  const id = randomUUID(); const folder = inside(roots.backups, id);
  await fs.mkdir(roots.backups, { recursive: true });
  await fs.mkdir(folder);
  try {
  const snapshotFile = path.join(folder, "database.db");
  const db = new DatabaseSync(roots.database, { readOnly: true });
  try { await backup(db, snapshotFile); } finally { db.close(); }
  const saved = new DatabaseSync(snapshotFile, { readOnly: true });
  let paths: string[], projects: number;
  try {
    paths = [...new Set<string>(assetPaths(saved).map(asset => asset.filePath.replaceAll("\\", "/")))];
    projects = saved.prepare("SELECT count(*) AS count FROM Project WHERE platform != '__mxpage_system_task__'").get().count;
  } finally { saved.close(); }
  const files: FileEntry[] = [];
  for (const relative of paths) {
    const source = await checkedPath(roots.storage, relative);
    const destination = inside(path.join(folder, "files"), relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    files.push({ path: relative, ...await digest(destination) });
  }
  const manifest: Manifest = { version: 1, id, createdAt: new Date().toISOString(), projects, database: { path: "database.db", ...await digest(snapshotFile) }, files };
  // Only a completely copied snapshot appears in the backup list.
  await fs.writeFile(path.join(folder, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  return manifest;
  } catch (error) {
    // This random directory was exclusively created by this attempt, never an existing backup.
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
export const createDataBackup = () => exclusive(snapshot);

async function loadBackup(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("备份标识无效。");
  const folder = await checkedPath(dataPaths().backups, id);
  const manifest: Manifest = JSON.parse(await fs.readFile(await checkedPath(folder, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || manifest.id !== id || manifest.database.path !== "database.db" || !Array.isArray(manifest.files)) throw new Error("不支持的备份格式。");
  return { folder, manifest };
}
async function verifyBackup(id: string) {
  const result = await loadBackup(id);
  for (const entry of [result.manifest.database, ...result.manifest.files]) {
    const root = entry === result.manifest.database ? result.folder : path.join(result.folder, "files");
    const file = await checkedPath(root, entry.path);
    const actual = await digest(file);
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) throw new Error(`备份校验失败：${entry.path}`);
  }
  const db = new DatabaseSync(path.join(result.folder, "database.db"), { readOnly: true });
  try {
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("备份数据库完整性校验失败。");
    const available = new Set(result.manifest.files.map(file => file.path));
    if (assetPaths(db).some(asset => !available.has(asset.filePath.replaceAll("\\", "/")))) throw new Error("备份缺少原图、Agent 文件或结果文件。");
  } finally { db.close(); }
  return result;
}
export async function dataOverview() {
  const roots = dataPaths(); const backups: Array<{ id: string; createdAt: string; projects: number; files: number }> = [];
  await fs.mkdir(roots.backups, { recursive: true });
  for (const entry of await fs.readdir(roots.backups, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try { const { manifest } = await loadBackup(entry.name); backups.push({ id: manifest.id, createdAt: manifest.createdAt, projects: manifest.projects, files: manifest.files.length }); }
    catch { /* Incomplete snapshots are not advertised as recoverable. */ }
  }
  return { database: roots.database, storage: roots.storage, backupDirectory: roots.backups, projects: await prisma.project.count({ where: { platform: { not: "__mxpage_system_task__" } } }), assets: await prisma.productAsset.count(), backups: backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}
export async function previewDataRestore(id: string) {
  const { folder, manifest } = await verifyBackup(id);
  const db = new DatabaseSync(path.join(folder, "database.db"), { readOnly: true });
  try {
    const saved: Array<{ id: string; name: string }> = db.prepare("SELECT id,name FROM Project WHERE platform != '__mxpage_system_task__'").all();
    const current = new Set((await prisma.project.findMany({ select: { id: true } })).map(project => project.id));
    return { id, createdAt: manifest.createdAt, missing: saved.filter(project => !current.has(project.id)), preserved: saved.filter(project => current.has(project.id)).length, files: manifest.files.length };
  } finally { db.close(); }
}
export async function restoreDataBackup(id: string) {
  return exclusive(async () => {
    const { folder, manifest } = await verifyBackup(id);
    if (await prisma.generationTask.count({ where: { status: { in: ["PENDING", "RUNNING"] } } }) || await prisma.detailRun.count({ where: { status: { in: ["PENDING", "RUNNING"] } } }) || await prisma.agentRun.count({ where: { OR: [{ status: { in: ["PENDING", "RUNNING"] } }, { leaseUntil: { gt: new Date() } }] } })) throw new Error("请先停止运行中的任务并等待请求结束，再恢复备份。");
    const safety = await snapshot();
    const roots = dataPaths();
    const db = new DatabaseSync(roots.database);
    const copied: string[] = [];
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      db.prepare("ATTACH DATABASE ? AS saved").run(path.join(folder, "database.db"));
      const restoreAgent = hasAgentTables(db, "saved");
      for (const table of [...tables, ...(restoreAgent ? agentTables : [])]) {
        const columns = (schema: string) => db.prepare(`PRAGMA ${schema}.table_info("${table}")`).all().map((column: { name: string; type: string }) => `${column.name}:${column.type}`).join("|");
        if (columns("main") !== columns("saved")) throw new Error("备份与当前数据结构不一致，请使用对应版本恢复。");
      }
      // Hold a write reservation while checking collisions and adding records. Existing rows are never replaced.
      db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON; CREATE TEMP TABLE restore_ids AS SELECT id FROM saved.Project WHERE id NOT IN (SELECT id FROM main.Project);');
      if (restoreAgent) db.exec('CREATE TEMP TABLE restore_agent_ids AS SELECT id FROM saved.AgentSession WHERE id NOT IN (SELECT id FROM main.AgentSession);');
      const assets: Array<{ filePath: string }> = db.prepare('SELECT filePath FROM saved.ProductAsset WHERE projectId IN (SELECT id FROM restore_ids)').all();
      if (restoreAgent) assets.push(...db.prepare('SELECT filePath FROM saved.AgentArtifact WHERE filePath IS NOT NULL AND sessionId IN (SELECT id FROM restore_agent_ids)').all());
      const files = new Map(manifest.files.map(file => [file.path, file]));
      for (const asset of assets) {
        const relative = asset.filePath.replaceAll("\\", "/"); const entry = files.get(relative)!;
        const destination = await checkedPath(roots.storage, relative);
        let existing = false;
        try { existing = true; const actual = await digest(destination); if (actual.sha256 !== entry.sha256) throw new Error(`现有文件冲突，已停止恢复：${relative}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; existing = false; }
        if (!existing) {
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.copyFile(await checkedPath(path.join(folder, "files"), relative), destination, constants.COPYFILE_EXCL);
          copied.push(destination);
        }
      }
      const restored = db.prepare("SELECT count(*) AS count FROM saved.Project WHERE id IN (SELECT id FROM restore_ids) AND platform != '__mxpage_system_task__'").get().count;
      for (const table of tables) {
        const condition = table === "Project" ? "id IN (SELECT id FROM restore_ids)" : table === "SectionVersion" ? "sectionId IN (SELECT id FROM saved.PageSection WHERE projectId IN (SELECT id FROM restore_ids))" : "projectId IN (SELECT id FROM restore_ids)";
        db.exec(`INSERT INTO main."${table}" SELECT * FROM saved."${table}" WHERE ${condition}`);
      }
      if (restoreAgent) {
        for (const table of agentTables) {
          const condition = table === "AgentSession" ? "id IN (SELECT id FROM restore_agent_ids)" : ["AgentMessage", "AgentRun", "AgentArtifact"].includes(table) ? "sessionId IN (SELECT id FROM restore_agent_ids)" : "runId IN (SELECT id FROM saved.AgentRun WHERE sessionId IN (SELECT id FROM restore_agent_ids))";
          const columns = db.prepare(`PRAGMA main.table_info("${table}")`).all().map((column: { name: string }) => column.name).filter((name: string) => !(table === "AgentEvent" && name === "seq")).map((name: string) => `"${name}"`).join(",");
          db.exec(`INSERT INTO main."${table}" (${columns}) SELECT ${columns} FROM saved."${table}" WHERE ${condition}`);
        }
        db.exec("UPDATE AgentRun SET status='INTERRUPTED', leaseToken=NULL, leaseUntil=NULL, error='从备份恢复，请重新提供凭据后手动继续。' WHERE sessionId IN (SELECT id FROM restore_agent_ids) AND status IN ('PENDING','RUNNING');");
      }
      db.exec("UPDATE GenerationTask SET status='FAILED', errorMessage='从备份恢复的未完成任务，请检查后手动继续。' WHERE projectId IN (SELECT id FROM restore_ids) AND status IN ('PENDING','RUNNING'); UPDATE DetailRun SET status='FAILED', leaseToken=NULL, leaseUntil=NULL, error='从备份恢复，请检查后手动继续。' WHERE projectId IN (SELECT id FROM restore_ids) AND status IN ('PENDING','RUNNING');");
      if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("恢复记录的关联校验失败。");
      db.exec("COMMIT");
      return { restored, safetyBackupId: safety.id };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* The transaction may not have begun. */ }
      for (const file of copied) await fs.rm(file, { force: true }).catch(() => undefined);
      throw error;
    } finally { db.close(); }
  });
}
