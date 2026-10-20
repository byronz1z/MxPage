import assert from "node:assert/strict";
import fs from "node:fs";

const plannerService = fs.readFileSync("lib/services/planner-service.ts", "utf8");
const cancelRoute = fs.readFileSync("app/api/projects/[id]/cancel-planning/route.ts", "utf8");

assert.match(plannerService, /registerTaskAbortController\(task\.id\)/);
assert.match(plannerService, /signal: taskSignal/);
assert.match(plannerService, /assertTaskNotCanceled\(task\.id\)/);
assert.match(plannerService, /releaseTaskAbortController\(task\.id\)/);
assert.match(cancelRoute, /taskType: "PLAN"/);
assert.match(cancelRoute, /cancelTask\(task\.id\)/);
