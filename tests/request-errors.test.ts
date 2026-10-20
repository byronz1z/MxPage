import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { readApiResponse, ApiRequestError, requestErrorMessage, fetchApiProgress, isStructuredSchemaRejection } from "../lib/utils/request-error";

test("workflow failures identify model, query and download recovery separately", () => {
  assert.match(requestErrorMessage({ code: "MODEL_REQUEST_FAILED", message: "fetch failed" }), /模型请求失败/);
  assert.match(requestErrorMessage({ code: "IMAGE_RESULT_QUERY_FAILED", message: "fetch failed" }), /查询失败/);
  assert.match(requestErrorMessage({ code: "IMAGE_DOWNLOAD_FAILED", message: "fetch failed" }), /下载失败/);
});
import { handleRouteError } from "../lib/utils/route";

test("HTML gateways, empty responses and corrupt JSON produce actionable feedback without parser errors", async () => {
  for (const response of [new Response("<html>nginx upstream secret</html>", { status: 502 }), new Response(null, { status: 204 }), new Response("{broken", { status: 200 })]) {
    await assert.rejects(readApiResponse(response), error => error instanceof ApiRequestError && /服务/.test(error.message) && !/nginx|secret|JSON|Unexpected|html/.test(error.message));
  }
  await assert.rejects(readApiResponse(Response.json({ success: true, data: {} }, { status: 500 })), ApiRequestError);
  assert.equal(await readApiResponse(Response.json({ success: true, data: null })), null);
});

test("missing resources remain distinguishable so polling can stop; business feedback stays actionable", async () => {
  await assert.rejects(readApiResponse(Response.json({ success: false, error: { code: "NOT_FOUND", message: "Project not found." } }, { status: 404 })), error => error instanceof ApiRequestError && error.status === 404 && /不存在/.test(error.message));
  const response = Response.json({ success: false, error: { code: "BRIEF_UNCERTAIN", message: "请勾选重试，可能再次计费。" } }, { status: 409 });
  await assert.rejects(readApiResponse(response), error => error instanceof ApiRequestError && error.code === "BRIEF_UNCERTAIN" && /计费/.test(error.message));
});

test("provider bodies, SQL errors and internal stacks do not reach the client", async () => {
  for (const error of [new Error("401 sk-secret-provider-key"), new Error("Invalid prisma.project invocation at D:/private/db"), new SyntaxError("Unexpected token <secret>"), Object.assign(new Error("P2025 internal table"), { code: "P2025" })]) {
    const payload = await handleRouteError(error).json();
    assert.doesNotMatch(JSON.stringify(payload), /secret|private|invocation|rawMessage|internal table/);
  }
  const invalid = z.object({ sections: z.array(z.string()) }).safeParse({ sections: 5 });
  assert.equal(invalid.success, false);
  assert.match(requestErrorMessage(invalid.error), /数据格式不完整/);
});

test("missing files and unavailable database have stable status codes", async () => {
  assert.equal(handleRouteError(Object.assign(new Error("file path"), { code: "ENOENT" })).status, 409);
  assert.equal(handleRouteError(Object.assign(new Error("db path"), { code: "P2024" })).status, 503);
});

test("schema properties called key cannot turn HTTP 400 into an authentication error", async () => {
  const message = "400 Invalid schema for response_format 'mxpage_workflow_result': 'required' is required to include every key in properties. Missing 'contentCoverage'.";
  const error = Object.assign(new Error(message), { status: 400 });
  assert.equal(isStructuredSchemaRejection(error), true);
  assert.match(requestErrorMessage(error), /数据格式.*无需更换/);
  const routeError = handleRouteError(error); assert.equal(routeError.status, 400);
  assert.equal((await routeError.json()).error.code, "PROVIDER_SCHEMA_REJECTED");
  for (const status of [401, 403]) assert.match(requestErrorMessage({ status, message: "Rejected" }), /鉴权失败/);
  assert.match(requestErrorMessage(new Error("Invalid API key")), /鉴权失败/);
  for (const text of ["Invalid schema: every key must be listed", "Invalid value for key width", "Image value 403 is outside bounds"]) assert.doesNotMatch(requestErrorMessage(new Error(text)), /鉴权失败/);
  assert.equal(isStructuredSchemaRejection({ status: 504, message }), false);
  assert.equal(isStructuredSchemaRejection(new SyntaxError("Invalid JSON response")), false);
});

test("legacy wording failures offer local continuation instead of exposing strict field diagnostics", () => {
  for (const message of ["sections[4].textBlocks：遗漏或改写规划文案", "内容覆盖.need：需求需要落实到详情页", "Typesetting block 1: line breaks must preserve exact text"]) {
    const display = requestErrorMessage(new Error(message));
    assert.match(display, /继续.*自动整理/);
    assert.doesNotMatch(display, /textBlocks|Typesetting|内容覆盖\./);
  }
  assert.match(requestErrorMessage(new Error("504 Gateway Timeout")), /超时/);
});

test("progress reads have bounded timeouts and never retry or turn into a mutation", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", (async (_url: unknown, init: RequestInit) => {
    calls++; assert.equal(init.method, undefined);
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      init.signal!.addEventListener("abort", abort, { once: true });
      if (init.signal!.aborted) abort();
    });
  }) as any);
  await assert.rejects(fetchApiProgress("/api/progress", undefined, 5), { code: "POLL_TIMEOUT" });
  assert.equal(calls, 1);
  const controller = new AbortController();
  const pending = fetchApiProgress("/api/progress", controller.signal); controller.abort();
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(calls, 2);
});
