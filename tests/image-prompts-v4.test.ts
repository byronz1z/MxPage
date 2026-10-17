import assert from "node:assert/strict";
import test from "node:test";
import { materializeImagePrompts } from "../lib/detail-runs/image-prompts-v4";

test("paid image input uses finalized art direction and exact copy, not an earlier planning prompt", () => {
  const savedBeforeArt = [{ id: "hero", order: 0, visualPrompt: "stale planning objective" }];
  const [generation] = materializeImagePrompts(savedBeforeArt, [{ sectionIndex: 0, prompt: "Cream background; product on the right.", textBlocks: [{ text: "浅棕马克杯" }, { text: "数字：350 ml（示例）" }] }]);
  assert.equal(generation.id, "hero");
  assert.match(generation.visualPrompt, /Cream background/);
  assert.ok(generation.visualPrompt.endsWith("浅棕马克杯\n数字：350 ml（示例）"));
  assert.ok(!generation.visualPrompt.includes("stale planning"));
});

test("out-of-order storyboard entries bind to the matching section index", () => {
  const output = materializeImagePrompts([{ order: 0, visualPrompt: "" }, { order: 1, visualPrompt: "" }], [
    { sectionIndex: 1, prompt: "Detail closeup", textBlocks: [] },
    { sectionIndex: 0, prompt: "Hero composition", textBlocks: [] },
  ]);
  assert.match(output[0].visualPrompt, /^Hero composition/);
  assert.match(output[1].visualPrompt, /^Detail closeup/);
});

test("duplicate or missing storyboard indices stop before paid requests", () => {
  const sections = [{ order: 0, visualPrompt: "" }, { order: 1, visualPrompt: "" }];
  const direction = (sectionIndex: number) => ({ sectionIndex, prompt: "test", textBlocks: [] });
  assert.throws(() => materializeImagePrompts(sections, [direction(0), direction(0)]), /编号重复/);
  assert.throws(() => materializeImagePrompts(sections, [direction(1), direction(2)]), /缺少第 1/);
});
