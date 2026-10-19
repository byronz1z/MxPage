const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
function workspaceId(root) {
  const real = fs.realpathSync(root);
  return createHash("sha256").update(process.platform === "win32" ? real.toLowerCase() : real).digest("hex");
}
function lockAddress(root, dist) {
  const hash = createHash("sha256").update(`${workspaceId(root)}:${dist}`).digest("hex").slice(0, 32);
  return process.platform === "win32" ? `\\\\.\\pipe\\mxpage-${hash}` : path.join(os.tmpdir(), `mxpage-${hash}.sock`);
}
function readOwner(address) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address); let value = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("Existing startup is not responding; retry shortly.")));
    socket.on("data", data => { value += data; });
    socket.on("end", () => { try { resolve(JSON.parse(value)); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
}
async function acquireRuntime(root, dist, owner) {
  const address = lockAddress(root, dist);
  const server = net.createServer(socket => socket.end(JSON.stringify(owner)));
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
    return { server, owner: null };
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    try { return { server: null, owner: await readOwner(address) }; }
    catch (readError) {
      if (process.platform !== "win32" && readError.code === "ECONNREFUSED") {
        fs.unlinkSync(address);
        return acquireRuntime(root, dist, owner);
      }
      throw readError;
    }
  }
}
async function portAvailable(port, host) {
  const probe = net.createServer();
  return new Promise((resolve, reject) => {
    probe.once("error", error => error.code === "EADDRINUSE" ? resolve(false) : reject(error));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}
module.exports = { workspaceId, acquireRuntime, portAvailable };
