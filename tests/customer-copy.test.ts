import assert from "node:assert/strict";
import test from "node:test";
import { customerFacingCopy } from "../lib/detail-runs/customer-copy";
import { materializeImagePrompts } from "../lib/detail-runs/image-prompts-v4";
import { normalizeTypesetting } from "../lib/detail-runs/typesetting-v4";

test("confirmed estimate annotations are removed without changing quantities, units or approximate wording", () => {
  assert.equal(customerFacingCopy("容量：约350 mL（模拟数据，非实测）\n尺寸：约12×12×10 cm\n仅供设计参考"), "容量：约350 mL\n尺寸：约12×12×10 cm");
  assert.equal(customerFacingCopy("净重（模拟数据：约350 g）"), "净重（约350 g）");
  assert.equal(customerFacingCopy("以上参数为模拟数据。"), "");
  assert.equal(customerFacingCopy("Capacity: approx. 350 mL (simulated data, not measured)"), "Capacity: approx. 350 mL");
});
test("ordinary copy, product names, existing punctuation and user measurements remain intact", () => {
  const original = "飞行模拟器\n参数：\n容量：350 mL（用户提供）\n尺寸：12×12×10 cm；净重350 g。\n支持模拟信号输出";
  assert.equal(customerFacingCopy(original), original);
});
test("final visible copy strips provenance only for confirmed estimates; internal data stays unchanged", () => {
  const raw = { sectionIndex: 0, prompt: "Warm table scene", textBlocks: [{ role: "body", text: "容量：约350 mL（模拟数据）" }, { role: "note", text: "非实测，仅供设计参考" }] };
  const original = JSON.stringify(raw);
  const [image] = materializeImagePrompts([{ order: 0, visualPrompt: "" }], [raw], true);
  assert.equal(JSON.stringify(raw), original);
  assert.equal(image.visualPrompt.split("Exact copy:\n")[1], "容量：约350 mL");
  assert.equal(image.artDirection.textBlocks.length, 1);
  const [block] = normalizeTypesetting(image.artDirection.textBlocks);
  assert.equal(block.lines?.join(""), block.text);
  assert.match(materializeImagePrompts([{ order: 0, visualPrompt: "" }], [raw])[0].visualPrompt, /模拟数据/);
});
