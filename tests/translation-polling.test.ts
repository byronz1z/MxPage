import assert from "node:assert/strict";
import { test } from "node:test";
import { translationNeedsPolling } from "../lib/translation/polling";
import { TRANSLATION_WORKFLOW } from "../lib/translation/contracts";

test("completed and failed translation results stop polling; active requests and waiting versions keep syncing", () => {
  const task = (status: string) => ({ status, inputPayload: { workflow: TRANSLATION_WORKFLOW } });
  const done = { sections: [{ imageUrl: "/result.png", status: "SUCCESS" }], tasks: [task("SUCCESS")] };
  assert.equal(translationNeedsPolling(done), false);
  assert.equal(translationNeedsPolling({ ...done, tasks: [task("RUNNING")] }), true, "An existing image does not mean an edit has finished");
  assert.equal(translationNeedsPolling({ sections: [{ imageUrl: null, status: "FAILED" }], tasks: [task("FAILED")] }), false);
  assert.equal(translationNeedsPolling({ sections: [{ imageUrl: null }], tasks: [] }), true);
  assert.equal(translationNeedsPolling({ sections: [{ imageUrl: "/old.png", status: "GENERATING" }], tasks: [task("SUCCESS")] }), true);
  assert.equal(translationNeedsPolling({ sections: [], tasks: [] }), false);
});
