import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTypesetting, validateExactTypesetting, wrapExactText } from "../lib/detail-runs/typesetting-v4";

test("V4 typesetting preserves canonical text and keeps numbers attached to units", () => {
  const text = "容量 500毫升，额定功率 120瓦";
  const lines = wrapExactText(text, 10);
  assert.equal(lines.join(""), text);
  assert.ok(lines.every(line => !/\d$/.test(line) || !/^(?:毫米|厘米|米|克|千克|公斤|毫升|升|瓦|伏|安|Hz|小时|分钟|寸|英寸|个|件|套|%|℃|°C)/i.test(lines[lines.indexOf(line) + 1] || "")));
});

test("V4 normalization regenerates stale model line breaks", () => {
  const blocks = normalizeTypesetting([{ text: "参数 100毫升", lines: ["错误内容"], role: "body", width: 40 }]);
  assert.deepEqual(validateExactTypesetting(blocks), []);
  assert.equal(blocks[0].lines?.join(""), "参数 100毫升");
});
