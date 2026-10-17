const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");

const { ensureSafeWorkdir } = require("./safe-workdir.cjs");

const projectRoot = path.resolve(__dirname, "..");
const safeCwd = ensureSafeWorkdir(projectRoot);
const nextBin = path.join(safeCwd, "node_modules", "next", "dist", "bin", "next");
const nextDistDirName = process.env.NEXT_DIST_DIR || ".next";
const command = process.argv[2];

if (command === "dev" || command === "build") {
  if (!/^\.next(?:-[a-zA-Z0-9_-]+)?$/.test(nextDistDirName)) {
    throw new Error("NEXT_DIST_DIR must be .next or a .next-* directory inside this project.");
  }
  const nextCacheDir = path.resolve(projectRoot, nextDistDirName);
  if (path.dirname(nextCacheDir) !== projectRoot) throw new Error("Unsafe build output path");
  if (fs.existsSync(nextCacheDir)) {
    if (fs.lstatSync(nextCacheDir).isSymbolicLink()) throw new Error("Refusing to remove a linked build directory");
    fs.rmSync(nextCacheDir, { recursive: true, force: true });
  }
}

const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  cwd: safeCwd,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
