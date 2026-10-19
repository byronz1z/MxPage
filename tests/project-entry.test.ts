import assert from "node:assert/strict";
import { test } from "node:test";
import { isTranslationProject, translationEntryHref, workEntryHref } from "../lib/utils/project-entry";

test("translation drafts always open translation, including legacy links and prepared results", () => {
  assert.equal(workEntryHref({ id: "draft", category: "translation", sectionCount: 0 }), "/projects/draft/editor");
  assert.equal(workEntryHref({ id: "detail", category: "detail", sectionCount: 0 }), "/projects/detail/configure");
  assert.ok(isTranslationProject({ id: "draft", modelSnapshot: { workType: "translation" } }));
  assert.ok(isTranslationProject({ id: "old", tasks: [{ taskType: "TRANSLATE_PAGE" }] }));
  assert.equal(translationEntryHref({ id: "draft", modelSnapshot: { translationBatchId: "batch" } }), "/translate/batch");
  assert.equal(translationEntryHref({ id: "result", modelSnapshot: { translationBatchId: "batch", translationReady: true } }), "/projects/result/editor");
});
