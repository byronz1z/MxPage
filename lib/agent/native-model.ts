import { BaseChatModel, type BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { nativeCompletion, nativeRequest, textHeaders } from "@/lib/ai/native-text";
import { textEndpoint, type NativePathPrefix, type TextProtocol } from "@/lib/ai/text-protocol";

type Options = BaseChatModelCallOptions & { tools?: any[]; parallel_tool_calls?: boolean };
// Single native transport inside the existing graph/ledger. No separate tool loop,
// SDK retries or model-name routing. Opaque Gemini signatures survive checkpoints.
export class NativeAgentModel extends BaseChatModel<Options> {
  constructor(private config: { baseUrl: string; model: string; protocol: TextProtocol; nativePathPrefix?: NativePathPrefix; apiKey: string; fetchImpl?: typeof fetch }) { super({ maxRetries: 0, disableStreaming: true }); }
  _llmType() { return "mxpage-native"; }
  bindTools(tools: Parameters<NonNullable<BaseChatModel["bindTools"]>>[0], options: Partial<Options> = {}) {
    return this.withConfig({ ...options, tools: tools.map(tool => convertToOpenAITool(tool)) });
  }
  async getNumTokens(content: any) { return Math.ceil((typeof content === "string" ? content : JSON.stringify(content)).length / 3); }
  async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]) {
    const { baseUrl, model, protocol, apiKey } = this.config;
    const choice = typeof options.tool_choice === "string" && !["auto", "none", "any", "required"].includes(options.tool_choice) ? { function: { name: options.tool_choice } } : options.tool_choice === "any" ? "required" : options.tool_choice;
    const body = nativeRequest(protocol, { model, tools: options.tools, tool_choice: choice, messages: messages.map(message => ({
      role: ({ human: "user", ai: "assistant", tool: "tool", system: "system" } as Record<string, string>)[message.getType()] || message.getType(), content: message.content,
      ...(message.getType() === "tool" ? { tool_call_id: (message as any).tool_call_id } : {}),
      ...(message.getType() === "ai" ? { tool_calls: (message as AIMessage).tool_calls?.map(call => ({ id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } })), nativeParts: message.additional_kwargs.nativeParts as any[] | undefined } : {}),
    })) });
    const timeout = AbortSignal.timeout(120000);
    const response = await (this.config.fetchImpl || fetch)(textEndpoint(baseUrl, protocol, model, this.config.nativePathPrefix), { method: "POST", redirect: "error", headers: { ...textHeaders(baseUrl, protocol, apiKey), "Content-Type": "application/json" }, body: JSON.stringify(body), signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout });
    const raw = await response.text();
    if (!response.ok) {
      let error: any; try { error = JSON.parse(raw).error; } catch {}
      throw Object.assign(new Error(error?.message || `Provider HTTP ${response.status}`), { status: response.status, error });
    }
    const payload = JSON.parse(raw), completion = nativeCompletion(payload, protocol), result = completion.choices[0].message;
    const input = completion.usage?.prompt_tokens || 0, output = completion.usage?.completion_tokens || 0;
    const message = new AIMessage({ content: result.content, tool_calls: (result.tool_calls || []).map(call => ({ id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments), type: "tool_call" as const })),
      additional_kwargs: protocol === "gemini_native" ? { nativeParts: (payload.candidates?.[0]?.content?.parts || []).filter((p: any) => !p.thought) } : {},
      response_metadata: { model_name: completion.model, finish_reason: completion.choices[0].finish_reason }, usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: completion.usage?.total_tokens || input + output } });
    return { generations: [{ text: result.content, message }] };
  }
}
