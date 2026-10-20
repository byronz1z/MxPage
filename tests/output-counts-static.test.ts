import assert from "node:assert/strict";
import fs from "node:fs";

const plannerService = fs.readFileSync("lib/services/planner-service.ts", "utf8");
const planRoute = fs.readFileSync("app/api/projects/[id]/plan-sections/route.ts", "utf8");

for (const source of [plannerService, planRoute]) {
  assert.match(source, /heroImageCount: z\.number\(\)\.int\(\)\.min\(0\)\.max\(HERO_MAX\)/);
  assert.match(source, /detailSectionCount: z\.number\(\)\.int\(\)\.min\(0\)\.max\(DETAIL_MAX\)/);
}

assert.doesNotMatch(plannerService, /至少保留 3 张/);
assert.doesNotMatch(plannerService, /至少保留 4 张/);
