import test from "node:test";
import assert from "node:assert/strict";
import { detailRunInputSchema, planSchema } from "../lib/detail-runs/contracts";
import { commercePlanSchema } from "../lib/detail-runs/merchandising";
import { artDirectionSchema, currentArtDirectionSchema, validateArtDirection } from "../lib/detail-runs/art-direction";
import { flexibleDirectionSchema, flexibleReviewSchema, normalizeIntentPlan, validateFlexibleDirection } from "../lib/detail-runs/flexible-creative";
import { heroCountOptions, detailCountOptions, legacyHeroCountOptions, legacyDetailCountOptions, OUTPUT_COUNT_ERROR } from "../lib/utils/image-counts";
import { previewImageCountsSchema } from "../lib/validations/project";
import { commercePlanFixture } from "./commerce-plan-fixture";
import { artDirectionFixture } from "./art-direction-fixture";
import { flexibleFixture, intentFixture } from "./flexible-creative-fixture";

test("configuration allows either image type to be zero but rejects an empty task", () => {
  const request = { idempotencyKey: "count-boundary-test", heroCount: 10, detailCount: 20 };
  assert.equal(detailRunInputSchema.parse(request).heroCount, 10);
  assert.equal(detailRunInputSchema.parse(request).detailCount, 20);
  assert.deepEqual(heroCountOptions, Array.from({ length: 11 }, (_, i) => i));
  assert.deepEqual(legacyHeroCountOptions, heroCountOptions);
  assert.deepEqual(detailCountOptions, Array.from({ length: 21 }, (_, i) => i));
  assert.deepEqual(legacyDetailCountOptions, detailCountOptions);
  for (const detailCount of [0, 1, 2, 3, 20]) assert.equal(detailRunInputSchema.parse({ ...request, detailCount }).detailCount, detailCount);
  for (const [heroCount, detailCount] of [[0, 1], [0, 20], [1, 0], [10, 0]]) {
    assert.equal(detailRunInputSchema.safeParse({ ...request, heroCount, detailCount }).success, true);
    assert.equal(previewImageCountsSchema.safeParse({ heroImageCount: heroCount, detailSectionCount: detailCount }).success, true);
  }
  const empty = detailRunInputSchema.safeParse({ ...request, heroCount: 0, detailCount: 0 });
  assert.equal(empty.success, false);
  if (!empty.success) assert.equal(empty.error.issues[0].message, OUTPUT_COUNT_ERROR);
  assert.equal(previewImageCountsSchema.safeParse({ heroImageCount: 0, detailSectionCount: 0 }).success, false);
  for (const change of [{ heroCount: 11 }, { heroCount: -1 }, { heroCount: 0.5 }, { detailCount: 21 }, { detailCount: -1 }, { detailCount: 4.5 }]) {
    assert.equal(detailRunInputSchema.safeParse({ ...request, ...change }).success, false);
  }
  const defaults = detailRunInputSchema.parse({ idempotencyKey: request.idempotencyKey });
  assert.equal(defaults.heroCount, 4);
  assert.equal(defaults.detailCount, 6);
});

test("a full 30-frame plan survives all planning schemas and 19 detail junctions", () => {
  const legacy = commercePlanFixture("asset-a", 10, 20);
  const targets = legacy.sections.map((s, i) => ({ id: `frame-${i}`, kind: s.kind, copy: s.copy }));
  assert.equal(planSchema.parse(legacy).sections.length, 30);
  assert.equal(commercePlanSchema.parse(legacy).sections.length, 30);
  const direction = currentArtDirectionSchema.parse(artDirectionFixture(targets, 2));
  assert.equal(direction.detailSeams.length, 19);
  assert.deepEqual(validateArtDirection(direction, targets), []);
  const plan = normalizeIntentPlan(intentFixture("asset-a", 10, 20));
  const flexible = flexibleDirectionSchema.parse(flexibleFixture(targets));
  assert.deepEqual(validateFlexibleDirection(flexible, targets, plan, []), []);
  assert.equal(artDirectionSchema.parse(JSON.parse(JSON.stringify(flexible))).sections.length, 30);
  assert.equal(flexibleReviewSchema.parse({ passed: true, issues: [], changes: flexible.sections.map(section => ({ section, reason: "Adjust local typography", factIds: [] })) }).changes.length, 30);
  assert.equal(planSchema.safeParse({ ...legacy, sections: [...legacy.sections, legacy.sections[0]] }).success, false);
  assert.equal(flexibleDirectionSchema.safeParse({ ...flexible, detailSeams: [...flexible.detailSeams, flexible.detailSeams[0]] }).success, false);
});
