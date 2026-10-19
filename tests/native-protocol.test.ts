import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeRequest, nativeCompletion, textHeaders } from "../lib/ai/native-text";
import { nativePathPrefix, textEndpoint, textProtocolOrder } from "../lib/ai/text-protocol";
import { NativeAgentModel } from "../lib/agent/native-model";
import { HumanMessage, ToolMessage, mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

test("native paths retain proxy prefixes and discovery resource IDs", () => {
  assert.equal(textEndpoint("https://provider.test/proxy/v1", "gemini_native", "models/custom-id"), "https://provider.test/proxy/v1beta/models/custom-id:generateContent");
  assert.equal(textEndpoint("https://provider.test/proxy/v2/", "anthropic_messages", "custom"), "https://provider.test/proxy/v2/messages");
  assert.equal(textProtocolOrder("https://api.anthropic.com")[0], "anthropic_messages");
  assert.equal(textProtocolOrder("https://generativelanguage.googleapis.com/v1beta")[0], "gemini_native");
  assert.deepEqual(textHeaders("https://generativelanguage.googleapis.com", "gemini_native", "test"), { "x-goog-api-key": "test" });
  assert.equal(textHeaders("https://api.anthropic.com", "anthropic_messages", "test").Authorization, undefined);
  assert.equal(textHeaders("https://api.evolink.ai", "gemini_native", "test").Authorization, "Bearer test");
});
test("CloseAI native prefixes are opt-in snapshots and keep OpenAI, custom paths and other origins unchanged", () => {
  for (const base of ["https://api.openai-proxy.org", "https://api.openai-proxy.org/v1/"]) {
    assert.equal(textEndpoint(base, "responses", "raw", nativePathPrefix(base, "responses")), "https://api.openai-proxy.org/v1/responses");
    assert.equal(textEndpoint(base, "anthropic_messages", "raw", nativePathPrefix(base, "anthropic_messages")), "https://api.openai-proxy.org/anthropic/v1/messages");
    assert.equal(textEndpoint(base, "gemini_native", "models/custom", nativePathPrefix(base, "gemini_native")), "https://api.openai-proxy.org/google/v1beta/models/custom:generateContent");
    assert.equal(textEndpoint(base, "anthropic_messages", "raw"), "https://api.openai-proxy.org/v1/messages", "Old snapshots keep their exact route");
  }
  for (const base of ["https://provider.test/proxy/v1", "https://api.evolink.ai", "https://api.openai-proxy.org/custom/v1"]) assert.equal(nativePathPrefix(base, "gemini_native"), undefined);
  assert.equal(textEndpoint("https://api.openai-proxy.org/google/v1beta", "gemini_native", "raw", "google"), "https://api.openai-proxy.org/google/v1beta/models/raw:generateContent");
  assert.equal(textEndpoint("https://api.openai-proxy.org/anthropic", "anthropic_messages", "raw", "anthropic"), "https://api.openai-proxy.org/anthropic/v1/messages");
});
for (const protocol of ["anthropic_messages", "gemini_native"] as const) test(`${protocol} translates vision and requires a completed response`, () => {
  const request = nativeRequest(protocol, { model: "raw-model", messages: [{ role: "system", content: "Inspect" }, { role: "user", content: [{ type: "text", text: "Read" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }] }] });
  assert.match(JSON.stringify(request), /AAAA/); assert.match(JSON.stringify(request), /image\/jpeg/);
  for (const payload of [{}, { error: { message: "bad" } }, { stop_reason: "max_tokens", content: [] }, { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] }]) assert.throws(() => nativeCompletion(payload, protocol));
});
for (const protocol of ["anthropic_messages", "gemini_native"] as const) test(`${protocol} LangChain tools round trip without retries and retain Gemini signatures across serialization`, async () => {
  let calls = 0;
  const model = new NativeAgentModel({ model: "raw-ID", baseUrl: "https://native.test/prefix", protocol, apiKey: "test-only", fetchImpl: async (url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get(protocol === "anthropic_messages" ? "x-api-key" : "x-goog-api-key"), "test-only");
    if (calls === 1) {
      assert.match(JSON.stringify(body), /connection_check/);
      return Response.json(protocol === "anthropic_messages" ? { id: "resp-a", model: "raw-ID", stop_reason: "tool_use", content: [{ type: "tool_use", id: "call-a", name: "connection_check", input: { status: "OK" } }] }
        : { responseId: "resp-a", modelVersion: "raw-ID", candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "connection_check", args: { status: "OK" } }, thoughtSignature: "opaque-signature" }] } }] });
    }
    if (protocol === "gemini_native") { assert.match(JSON.stringify(body.contents), /opaque-signature/); assert.match(JSON.stringify(body.contents), /functionResponse/); }
    else assert.match(JSON.stringify(body.messages), /tool_result/);
    return Response.json(protocol === "anthropic_messages" ? { model: "raw-ID", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] }
      : { modelVersion: "raw-ID", candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Done" }] } }] });
  } });
  const bound = model.bindTools([tool(async () => "OK", { name: "connection_check", schema: z.object({ status: z.literal("OK") }) })], { tool_choice: "connection_check" });
  const input = new HumanMessage("Check"), first = await bound.invoke([input]);
  assert.equal(first.tool_calls?.length, 1);
  const restored = mapStoredMessagesToChatMessages(mapChatMessagesToStoredMessages([input, first]));
  const second = await bound.invoke([...restored, new ToolMessage({ tool_call_id: first.tool_calls![0].id!, content: "OK" })]);
  assert.equal(second.content, "Done"); assert.equal(calls, 2);
  let failures = 0;
  const failed = new NativeAgentModel({ model: "raw-ID", baseUrl: "https://native.test", protocol, apiKey: "test-only", fetchImpl: async () => { failures++; return new Response("Unauthorized", { status: 401 }); } });
  await assert.rejects(failed.invoke([input]), { status: 401 }); assert.equal(failures, 1);
});
