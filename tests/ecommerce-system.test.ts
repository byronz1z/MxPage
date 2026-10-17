import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCommercePromptStrategy, buildCommerceSystemPrompt, inferCommerceScenes } from "@/lib/ai/prompts/ecommerce-system";
import { recommendDefaultModels } from "@/lib/ai/model-matcher";

test("commerce prompt strategy maps platform and task scenes to reusable rules", () => {
  assert.deepEqual(inferCommerceScenes("specs", "尺寸参数", "保留完整规格表"), ["specification"]);
  const prompt = buildCommerceSystemPrompt("taobao_tmall", ["hero_search", "specification"]);
  assert.match(prompt, /淘宝 \/ 天猫/);
  assert.match(prompt, /数字与单位不可拆分/);
  assert.match(prompt, /规格信息/);
  assert.equal(buildCommercePromptStrategy("xiaohongshu").scenes.length, 8);
});

test("detected defaults select the requested Luna planner and Flare image model", () => {
  const models = [
    { modelId: "gpt-6-luna", capabilities: { text: true, vision: true, structured_output: true, image_gen: false, image_edit: false }, isAvailable: true },
    { modelId: "gpt-image-2.5-sunburst", capabilities: { text: false, vision: false, structured_output: false, image_gen: true, image_edit: true, real_image_gen: true, real_image_edit: true }, isAvailable: true },
    { modelId: "gpt-image-2.5-flare", capabilities: { text: false, vision: false, structured_output: false, image_gen: true, image_edit: true, real_image_gen: true, real_image_edit: true }, isAvailable: true },
  ] as any;
  const defaults = recommendDefaultModels(models);
  assert.equal(defaults.planningModelId, "gpt-6-luna");
  assert.equal(defaults.heroImageModelId, "gpt-image-2.5-flare");
  assert.equal(defaults.detailImageModelId, "gpt-image-2.5-flare");
  assert.equal(defaults.imageEditModelId, "gpt-image-2.5-flare");
});
