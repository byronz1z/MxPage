const { spawn } = require("child_process");
const path = require("path");
const { ensureSafeWorkdir } = require("./safe-workdir.cjs");
const { workspaceId, acquireRuntime, portAvailable } = require("./runtime-guard.cjs");

async function main() {
  const root = path.resolve(__dirname, "..");
  const cwd = ensureSafeWorkdir(root);
  const args = process.argv.slice(2), command = args[0];
  const dist = process.env.NEXT_DIST_DIR || ".next";
  if (!/^\.next(?:-[a-zA-Z0-9_-]+)?$/.test(dist)) throw new Error("NEXT_DIST_DIR must be .next or a .next-* directory inside this project.");
  const argument = (long, short) => {
    const index = args.findIndex(arg => arg === long || arg === short);
    return index >= 0 ? args[index + 1] : args.find(arg => arg.startsWith(`${long}=`))?.slice(long.length + 1);
  };
  const port = Number(argument("--port", "-p") || process.env.PORT || 3000);
  const host = argument("--hostname", "-H") || "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  const probeHost = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
  const url = `http://${probeHost.includes(":") ? `[${probeHost}]` : probeHost}:${port}`;
  const guard = await acquireRuntime(root, dist, { command, url, pid: process.pid });
  if (guard.owner) {
    if (["dev", "start"].includes(command) && ["dev", "start"].includes(guard.owner.command)) {
      console.log(`MxPage already running or starting: ${guard.owner.url}`); return;
    }
    throw new Error(`Build directory ${dist} is in use by ${guard.owner.command}. Stop it or use a separate NEXT_DIST_DIR.`);
  }
  try {
    if (!await portAvailable(port, host)) {
      let identity;
      try { identity = await (await fetch(`${url}/api/runtime/identity`, { signal: AbortSignal.timeout(15000) })).json(); } catch {}
      if (["dev", "start"].includes(command) && identity?.workspaceId === workspaceId(root) && identity.dist === dist) {
        console.log(`MxPage already running: ${url}`); guard.server.close(); return;
      }
      if (command !== "build" || dist === ".next" || identity?.dist === dist) throw new Error(`Port ${port} is already in use. No server was stopped and no build cache was removed.`);
    }
    if (["dev", "start"].includes(command)) {
      if (!argument("--port", "-p")) args.push("--port", String(port));
      if (!argument("--hostname", "-H")) args.push("--hostname", host);
    }
    // Next manages its own cache; never remove another running service's output.
    const child = spawn(process.execPath, [path.join(cwd, "node_modules", "next", "dist", "bin", "next"), ...args], { cwd, stdio: "inherit", env: process.env, windowsHide: true });
    child.once("error", error => { console.error(error.message); guard.server.close(); process.exitCode = 1; });
    child.once("exit", code => { guard.server.close(); process.exitCode = code ?? 1; });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  } catch (error) { guard.server.close(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
