import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { desktopRequest } from "./desktop";
import { hash, type AgentSettings } from "./contracts";
import { version } from "../../package.json";

export async function connectMcpTools(settings: AgentSettings, tokens: Record<string, string>, runId?: string) {
  const clients: Client[] = [];
  const tools: DynamicStructuredTool[] = [];
  try {
    for (const server of settings.mcp.filter(s => s.enabled)) {
      if (server.transport === "stdio") {
        const catalog = await desktopRequest("mcp_list", { server });
        for (const definition of catalog.tools) tools.push(new DynamicStructuredTool({ name: `mcp_${server.id}_${definition.name}`, description: String(definition.description || definition.name).slice(0, 2000), schema: definition.inputSchema,
          func: async args => JSON.stringify(await desktopRequest("mcp_call", { runId, serverId: server.id, name: definition.name, args })),
        }));
      } else {
        const client = new Client({ name: "MxPage", version });
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: tokens[server.id] ? { Authorization: `Bearer ${tokens[server.id]}` } : {}, redirect: "error" } }), { timeout: 15000 });
        clients.push(client);
        const catalog = await client.listTools();
        for (const definition of catalog.tools.slice(0, 40)) {
          const name = `mcp_${server.id}_${definition.name}`;
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) continue;
          tools.push(new DynamicStructuredTool({ name, description: `外部 MCP ${server.id}：${String(definition.description || definition.name).slice(0, 1500)}`, schema: definition.inputSchema,
            func: async args => JSON.stringify(await client.callTool({ name: definition.name, arguments: args }, undefined, { timeout: 30000 })),
          }));
        }
      }
    }
    return { tools, catalogHash: hash(tools.map(t => ({ name: t.name, description: t.description, schema: t.schema })).sort((a, b) => a.name.localeCompare(b.name))), close: async () => { await Promise.allSettled(clients.map(c => c.close())); } };
  } catch (error) { await Promise.allSettled(clients.map(c => c.close())); throw error; }
}
