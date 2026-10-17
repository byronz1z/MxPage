// Runs the packaged Electron Node runtime with a disposable database. No model calls.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const root = path.resolve(__dirname, "..");
const mac = process.platform === "darwin";
const appDir = path.join(root, "dist-desktop", mac ? (process.arch === "arm64" ? "mac-arm64" : "mac") : "win-unpacked");
const resources = mac ? path.join(appDir, "MxPage.app", "Contents", "Resources") : path.join(appDir, "resources");
const executable = mac ? path.join(appDir, "MxPage.app", "Contents", "MacOS", "MxPage") : path.join(appDir, "MxPage.exe");
const standalone = path.join(resources, "app", ".next-desktop", "standalone");

async function main() {
  await fs.access(executable);
  await fs.access(path.join(standalone, "server.js"));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mxpage-desktop-smoke-"));
  const env = {
    ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", APP_RUNTIME: "desktop",
    APP_USER_DATA_DIR: temp, APP_SECRET: "isolated-desktop-smoke-secret",
    DATABASE_URL: `file:${path.join(temp, "smoke.db").replaceAll("\\", "/")}`,
    STORAGE_ROOT: path.join(temp, "storage"), HOSTNAME: "127.0.0.1",
  };
  delete env.LOCK_BASE_URL;
  delete env.FORCED_API_BASE;
  delete env.FORCED_API_BASE_URL;
  let server;
  let serverLog = "";
  async function run(args) {
    const child = spawn(executable, args, { cwd: standalone, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", data => { log += data; });
    child.stderr.on("data", data => { log += data; });
    const timer = setTimeout(() => child.kill(), 60_000);
    try {
      const [code] = await once(child, "exit");
      assert.equal(code, 0, log);
    } finally { clearTimeout(timer); }
  }
  try {
    const packagedFiles = await fs.readdir(path.join(resources, "app"), { recursive: true });
    assert.deepEqual(packagedFiles.filter(file => /(^|[\\/])\.env(?:\.|$)|\.db(?:-|$)|(^|[\\/])test-reports[\\/]/i.test(file)), [], "Private files must not ship");
    for (const name of [".env", ".env.local", "storage", "test-output", "public/test-reports", "prisma/dev.db"]) {
      await assert.rejects(fs.access(path.join(standalone, name)), { code: "ENOENT" }, `Private build input leaked: ${name}`);
    }
    await run([path.join(standalone, "scripts", "apply-prisma-migrations.cjs")]);
    // Prisma and sharp contain platform-specific binaries and must work on each native runner.
    await run(["-e", "(async()=>{const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();try{if(await db.project.count()!==0)throw Error('Unexpected project data');await require('sharp')({create:{width:2,height:2,channels:4,background:'#fff'}}).png().toBuffer();}finally{await db.$disconnect();}})().catch(e=>{console.error(e);process.exit(1)})"]);
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    env.PORT = String(listener.address().port);
    await new Promise(resolve => listener.close(resolve));
    server = spawn(executable, [path.join(standalone, "server.js")], { cwd: standalone, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", data => { serverLog = (serverLog + data).slice(-12_000); });
    server.stderr.on("data", data => { serverLog = (serverLog + data).slice(-12_000); });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (server.exitCode !== null) throw new Error(serverLog);
      try { ready = (await fetch(`http://127.0.0.1:${env.PORT}/api/projects`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(ready, `Packaged server did not start: ${serverLog}`);
    for (const route of ["/", "/translate", "/xiaohongshu", "/history", "/tasks", "/settings/providers", "/settings/profile", "/settings/about", "/monitor/usage", "/api/projects", "/llms.txt", "/assets/phone-mockup-frame.png"]) {
      const response = await fetch(`http://127.0.0.1:${env.PORT}${route}`, { signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, 200, `${route}: ${serverLog}`);
      if (route === "/api/projects") assert.deepEqual((await response.json()).data, []);
      else await response.arrayBuffer();
      console.log(`PASS ${route}`);
    }
    const base = `http://127.0.0.1:${env.PORT}`;
    const created = await (await fetch(`${base}/api/projects`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Isolated packaging smoke", platform: "general_ecommerce", style: "generic_clean" }),
    })).json();
    assert.ok(created.success, JSON.stringify(created));
    const updated = await (await fetch(`${base}/api/projects/${created.data.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelSnapshot: { previewConfig: { heroImageCount: 10, detailSectionCount: 20 } } }),
    })).json();
    assert.ok(updated.success, JSON.stringify(updated));
    assert.equal(updated.data.modelSnapshot.previewConfig.detailSectionCount, 20);
    assert.equal((await fetch(`${base}/projects/${created.data.id}/configure`)).status, 200);
    console.log("PASS isolated project create/update/configuration");
    console.log(`Desktop smoke passed: ${process.platform}/${process.arch}; clean SQLite, Prisma, sharp and HTTP pages.`);
  } finally {
    if (server && server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
    // Only the mkdtemp directory created by this process may be removed.
    if (path.dirname(temp) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith("mxpage-desktop-smoke-")) {
      await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
