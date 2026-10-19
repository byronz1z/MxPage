import { NextRequest } from "next/server";
import { readProviderCredentialsFromRequest } from "@/lib/services/provider-runtime";
import type { AgentCredentials } from "./runtime";
export function agentCredentials(request: NextRequest): AgentCredentials {
  let tokens: Record<string, string> = {};
  try { const raw = JSON.parse(request.headers.get("x-mxpage-mcp-tokens") || "{}"); for (const [id, token] of Object.entries(raw)) if (typeof token === "string" && token.length < 5000) tokens[id] = token; } catch { /* Missing optional tool credentials. */ }
  return { ...readProviderCredentialsFromRequest(request), tavilyKey: request.headers.get("x-mxpage-tavily-key") || undefined, mcpTokens: tokens };
}
export function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  // Next's internal request URL can use localhost behind the standalone server.
  // The browser's Origin must match the actual Host header, not that internal URL.
  if (origin && new URL(origin).host !== request.headers.get("host")) throw new Error("Agent: 拒绝跨站修改请求。");
  if (!["same-origin", "none", null].includes(request.headers.get("sec-fetch-site"))) throw new Error("Agent: 拒绝跨站请求。");
}
