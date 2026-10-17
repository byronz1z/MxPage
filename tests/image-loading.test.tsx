import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductImage } from "../components/editor/product-phone-preview";
import { imageDisplayProgress } from "../lib/tasks/image-progress";
import type { ImageProgress } from "../lib/detail-runs/contracts";
const section = { id: "one", title: "商品头图", type: "HERO", order: 0 };
const pending: ImageProgress[] = [{ sectionId: "one", title: section.title, state: "generating", correctionCount: 0 }];

test("generating placeholders animate, including an overlay above an existing image", () => {
  const placeholder = renderToStaticMarkup(<ProductImage section={section} progress={pending} square/>);
  assert.match(placeholder, /aria-busy="true"/);
  assert.match(placeholder, /aria-hidden="true" class="image-generation-dots/);
  assert.doesNotMatch(placeholder, /animate-spin|lucide-image-plus|lucide-loader/);
  assert.match(placeholder, /正在生成图片/);
  const replacement = renderToStaticMarkup(<ProductImage section={{ ...section, imageUrl: "/original.png" }} progress={pending}/>);
  assert.match(replacement, /src="\/original.png"/);
  assert.match(replacement, /正在更新图片/);
  assert.match(replacement, /absolute inset-0/);
});

test("completed and stopped work never shows a perpetual animation", () => {
  const stopped = imageDisplayProgress(pending, false);
  assert.equal(pending[0].state, "generating", "Display projection must not mutate the checkpoint");
  assert.doesNotMatch(renderToStaticMarkup(<ProductImage section={section} progress={stopped}/>), /aria-busy/);
  const done = [{ ...pending[0], state: "generated" as const, assetId: "saved" }];
  assert.doesNotMatch(renderToStaticMarkup(<ProductImage section={{ ...section, imageUrl: "/done.png" }} progress={done}/>), /aria-busy/);
});

test("single image edits animate after navigation while stale or finished requests do not", () => {
  const tasks = [{ sectionId: "edit", taskType: "REGENERATE", status: "RUNNING", updatedAt: new Date(100_000) }];
  assert.equal(imageDisplayProgress([], false, tasks, undefined, 105_000)[0].state, "generating");
  assert.equal(imageDisplayProgress([], false, tasks, undefined, 2_000_000).length, 0);
  assert.equal(imageDisplayProgress([], false, [{ ...tasks[0], status: "SUCCESS" }]).length, 0);
  assert.equal(imageDisplayProgress([], false, [], "immediate")[0].sectionId, "immediate");
});
