import { test } from "node:test";
import assert from "node:assert/strict";
import { imageReview } from "../components/editor/product-phone-preview";

test("V4 structured issues display for the inspected image and disappear after a version change", () => {
  const section = { id: "section", type: "HERO", title: "Product", order: 0, currentImageAssetId: "inspected" };
  const progress: any[] = [{ sectionId: section.id, assetId: "inspected", state: "checked", check: { passed: false, issues: [{ kind: "copy", message: "文字需要校对", severity: "error" }] } }];
  assert.deepEqual(imageReview(section, progress), { assetId: "inspected", passed: false, issues: ["文字需要校对"] });
  assert.equal(imageReview({ ...section, currentImageAssetId: "new-version" }, progress), undefined);
  progress[0].check = { passed: true, issues: [] };
  assert.equal(imageReview(section, progress)?.passed, true);
  assert.equal(imageReview({ ...section, currentImageAssetId: null }, []), undefined);
});
