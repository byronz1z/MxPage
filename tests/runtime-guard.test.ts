import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const { acquireRuntime, portAvailable } = createRequire(import.meta.url)("../scripts/runtime-guard.cjs");

test("one workspace/build directory has a single owner; separate output can run and released locks can restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mxpage-runtime-test-"));
  const held: net.Server[] = [];
  try {
    const owner = { command: "dev", url: "http://127.0.0.1:3000", pid: process.pid };
    const first = await acquireRuntime(root, ".next", owner); held.push(first.server);
    const second = await acquireRuntime(root, ".next", { ...owner, command: "build" });
    assert.equal(second.server, null); assert.deepEqual(second.owner, owner);
    const isolated = await acquireRuntime(root, ".next-test", { ...owner, command: "build" }); held.push(isolated.server);
    await new Promise<void>(resolve => first.server.close(resolve)); held.shift();
    const restarted = await acquireRuntime(root, ".next", owner); held.push(restarted.server);
    assert.equal(restarted.owner, null);
    const listener = net.createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve)); held.push(listener);
    assert.equal(await portAvailable((listener.address() as net.AddressInfo).port, "127.0.0.1"), false);
  } finally {
    for (const server of held) await new Promise<void>(resolve => server.close(() => resolve()));
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith("mxpage-runtime-test-")) await rm(root, { recursive: true, force: true });
  }
});

test("launcher reuses a live owner and refuses a build or unrelated port without starting Next", async () => {
  const dist = `.next-test-${randomUUID()}`;
  const guard = await acquireRuntime(process.cwd(), dist, { command: "dev", url: "http://127.0.0.1:3199", pid: process.pid });
  const run = promisify(execFile);
  const options = { env: { ...process.env, NEXT_DIST_DIR: dist }, windowsHide: true };
  try {
    const result = await run(process.execPath, ["scripts/run-next-safe.cjs", "dev"], options);
    assert.match(result.stdout, /already running or starting.*3199/);
    await assert.rejects(run(process.execPath, ["scripts/run-next-safe.cjs", "build"], options), /in use by dev/);
  } finally { await new Promise<void>(resolve => guard.server.close(resolve)); }
  const foreign = http.createServer((_, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}"); });
  await new Promise<void>(resolve => foreign.listen(0, "127.0.0.1", resolve));
  try {
    const port = String((foreign.address() as net.AddressInfo).port);
    await assert.rejects(run(process.execPath, ["scripts/run-next-safe.cjs", "dev", "--port", port], options), /already in use/);
  } finally { foreign.closeAllConnections(); await new Promise<void>(resolve => foreign.close(() => resolve())); }
});
