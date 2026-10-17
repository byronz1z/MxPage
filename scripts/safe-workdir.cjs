const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");

function getSafeAliasPath(targetDir) {
  const suffix = createHash("sha256").update(targetDir).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `MxPage-workdir-${suffix}`);
}

function ensureSafeWorkdir(targetDir) {
  targetDir = path.resolve(targetDir);
  // Native macOS/Linux paths do not need Windows junctions; ordinary ASCII paths
  // also avoid aliasing so parallel checkouts and release builds stay isolated.
  if (process.platform !== "win32" || /^[\x20-\x7e]+$/.test(targetDir)) return targetDir;
  const aliasPath = getSafeAliasPath(targetDir);

  if (fs.existsSync(aliasPath)) {
    const stats = fs.lstatSync(aliasPath);
    if (stats.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(aliasPath), fs.readlinkSync(aliasPath));
      if (resolved === targetDir) return aliasPath;
    }
    throw new Error(`Workdir alias is occupied; refusing to remove it: ${aliasPath}`);
  }

  fs.symlinkSync(targetDir, aliasPath, "junction");
  return aliasPath;
}

module.exports = {
  ensureSafeWorkdir,
};
