import test from "node:test";
import assert from "node:assert/strict";
import { workflowReferenceAssets } from "../lib/utils/asset-purpose";

test("style references cannot enter the product evidence set, including before the eight-image limit", () => {
  const style = { type: "REFERENCE", metadata: { purpose: "style_reference" }, id: "style" };
  const original = { type: "MAIN", id: "original" };
  const legacy = { type: "REFERENCE", id: "legacy-product" };
  const output = workflowReferenceAssets([style, original, legacy, { type: "GENERATED", id: "generated" }]);
  assert.deepEqual(output.product.map(asset => asset.id), ["original", "legacy-product"]);
  assert.deepEqual(output.style.map(asset => asset.id), ["style"]);
});
