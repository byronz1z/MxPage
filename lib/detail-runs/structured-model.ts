import { z } from "zod";
import { callText, type TextCall } from "@/lib/ai/text-transport";
export { normalizeOpenAiBaseUrl } from "@/lib/ai/text-protocol";
export type StructuredModelInput<T extends z.ZodType> = Omit<TextCall, "schema"> & { schema: T; maxAttempts?: 1 | 2 };
// Explicit retries belong to the workflow, never the transport.
export async function invokeStructured<T extends z.ZodType>(input: StructuredModelInput<T>): Promise<z.infer<T>> {
  return (await callText(input)).parsed as z.infer<T>;
}
