import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");

test("desktop package names distinguish platforms and exclude local fixtures", () => {
  const config = require("../package.json").build;
  assert.notEqual(config.win.artifactName, config.mac.artifactName);
  assert.ok(config.win.artifactName.includes("${arch}"));
  assert.ok(config.mac.artifactName.includes("${arch}"));
  assert.ok(config.files.includes("!**/test-reports/**/*"));
  assert.ok(config.files.includes("!**/.env*"));
  assert.ok(config.files.includes("!**/*.db"));
});

test("build cleanup rejects an output directory outside the project", () => {
  const result = spawnSync(process.execPath, ["scripts/run-next-safe.cjs", "build"], {
    cwd: root, encoding: "utf8", env: { ...process.env, NEXT_DIST_DIR: "../must-not-remove" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEXT_DIST_DIR must/);
});

test("safe workdir keeps a normal path on native runners", () => {
  const { ensureSafeWorkdir } = require("../scripts/safe-workdir.cjs");
  if (process.platform !== "win32" || /^[\x20-\x7e]+$/.test(root)) assert.equal(ensureSafeWorkdir(root), root);
});
