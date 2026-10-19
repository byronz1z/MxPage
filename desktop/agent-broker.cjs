const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { ipcMain, globalShortcut, systemPreferences } = require("electron");
const { allowedTools, appAllowed, validateCall } = require("./agent-policy.cjs");
const { browserCall, closeBrowsers } = require("./agent-browser.cjs");

function unpack(result) {
  if (result?.structuredContent) return result.structuredContent;
  for (const item of result?.content || []) if (item.type === "text") { try { return JSON.parse(item.text); } catch {} }
  return {};
}
function createAgentBroker({ getWindow, getServerUrl }) {
  const pendingPlans = new Map(), grants = new Map(), localServers = new Map();
  let client, catalog, activeRun, serverChild, busy = false;
  function trusted(event) {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("非工作台桌面通道。");
    const url = new URL(event.senderFrame.url);
    if (url.origin !== getServerUrl() || !["/agent", "/settings/agent"].includes(url.pathname)) throw new Error("页面不具备桌面授权权限。");
  }
  async function connect(command, args, extraEnv = {}) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const connection = new Client({ name: "MxPageDesktop", version: "0.3.0" });
    // Do not inherit model/API keys, arbitrary NODE_OPTIONS, shell startup files or tracing credentials.
    const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const transport = new StdioClientTransport({ command, args, env: { ...env, ...extraEnv }, stderr: "pipe" });
    transport.stderr?.on("data", () => {});
    await connection.connect(transport, { timeout: 15000 });
    return connection;
  }
  async function driver() {
    if (!client) {
      const serverEntry = require.resolve.paths("@zavora-ai/computer-use-mcp").map(root => path.join(root, "@zavora-ai/computer-use-mcp/dist/launch.js")).find(file => fs.existsSync(file));
      if (!serverEntry) throw new Error("桌面控制驱动未包含在安装包中。");
      client = await connect(process.execPath, [serverEntry], { ELECTRON_RUN_AS_NODE: "1", COMPUTER_USE_PROFILE: "ax", COMPUTER_USE_STATUS_CARD: "true", COMPUTER_USE_AUDIT_ENABLED: "false" });
      catalog = (await client.listTools()).tools.filter(t => allowedTools.has(t.name));
    }
    return client;
  }
  async function stop(runId) {
    for (const [id, grant] of grants) if (!runId || runId === id) { grant.stopped = true; grant.observe = true; }
    if (!runId || activeRun === runId) {
      activeRun = null;
      // Closing the private driver interrupts gestures and invalidates its target state.
      const connection = client; client = null; catalog = null;
      if (connection) await connection.close().catch(() => {});
      await closeBrowsers(runId);
    }
  }
  async function userStop() {
    const runIds = [...grants].filter(([, grant]) => !grant.stopped).map(([id]) => id);
    if (serverChild?.connected) serverChild.send({ channel: "mxpage-agent-stop", runIds });
    await stop();
  }
  ipcMain.handle("mxpage-agent:grant", async (event, runId, planHash) => {
    trusted(event); const pending = pendingPlans.get(runId);
    if (!pending || pending.hash !== planHash) throw new Error("方案已改变，请重新确认。");
    if (activeRun && activeRun !== runId) throw new Error("另一个任务正在控制电脑，请先停止它。");
    if (pending.plan.tools.includes("computer") && !pending.plan.applications.length) throw new Error("电脑方案必须明确目标应用 ID。");
    if (pending.plan.directories.some(dir => !path.isAbsolute(dir))) throw new Error("批准的目录需要使用绝对路径。");
    grants.set(runId, { ...pending, stopped: false, observe: true, windowId: null }); activeRun = runId;
  });
  ipcMain.handle("mxpage-agent:stop", async event => { trusted(event); await userStop(); });
  ipcMain.handle("mxpage-agent:status", async event => { trusted(event); return status(); });
  globalShortcut.register("CommandOrControl+Shift+Escape", () => { void userStop(); });
  function status() {
    return { available: ["win32", "darwin"].includes(process.platform), platform: `${process.platform}-${process.arch}`, activeRun, busy,
      permissions: process.platform === "darwin" ? { accessibility: systemPreferences.isTrustedAccessibilityClient(false), screen: systemPreferences.getMediaAccessStatus("screen") } : { interactiveDesktop: !process.env.SESSIONNAME?.toLowerCase().includes("services") },
    };
  }
  async function dispatch(action, data) {
    if (action === "status") return status();
    if (action === "register_plan") {
      const digest = crypto.createHash("sha256").update(JSON.stringify(data.plan)).digest("hex");
      if (digest !== data.planHash) throw new Error("方案摘要不匹配。");
      pendingPlans.set(data.runId, { plan: data.plan, hash: digest });
      if (grants.get(data.runId)?.hash !== digest) await stop(data.runId);
      return { registered: true };
    }
    if (action === "has_grant") return { granted: grants.get(data.runId)?.hash === data.planHash && !grants.get(data.runId)?.stopped };
    if (action === "revoke") { await stop(data.runId); return { stopped: true }; }
    if (action === "require_observation") {
      const grant = grants.get(data.runId);
      if (!grant || grant.stopped || grant.hash !== data.planHash) throw new Error("请重新在桌面工作台确认电脑操作范围。");
      grant.observe = true; grant.windowId = null; return { observationRequired: true };
    }
    if (action === "catalog") { await driver(); return { tools: catalog, status: status() }; }
    if (action === "mcp_list") {
      // Listing is allowed only for a config explicitly registered through trusted settings IPC.
      const server = localServers.get(data.server.id);
      if (!server || JSON.stringify(server.config) !== JSON.stringify(data.server)) throw new Error("请在桌面设置页确认本地 MCP 程序。");
      if (!server.client) server.client = await connect(server.config.command, server.config.args);
      return server.client.listTools();
    }
    const grant = grants.get(data.runId);
    if (!grant || grant.stopped || activeRun !== data.runId) throw new Error("本机控制已暂停或未通过桌面授权。");
    if (busy) throw new Error("电脑控制串行锁正在使用，请稍后再试。");
    busy = true;
    try {
      if (action === "browser") return await browserCall(data.runId, grant, data.input, async state => {
        const connection = await driver();
        const control = unpack(await connection.callTool({ name: "control_status", arguments: {} }));
        const diagnostic = unpack(await connection.callTool({ name: "doctor", arguments: { include_remediation: false } }));
        const guard = diagnostic.checks?.find(c => c.id === "user_active_guard")?.details;
        const front = unpack(await connection.callTool({ name: "get_frontmost_app", arguments: {} }));
        if (control.state !== "running" || !guard?.clockAvailable || guard.userActive || !state.pid || (front.app || front).pid !== state.pid) {
          grant.observe = true; throw new Error("用户接管、输入监控不可用或浏览器焦点改变，已暂停。请重新观察后继续。");
        }
      });
      if (action === "mcp_call") {
        const server = localServers.get(data.serverId);
        if (!server?.client || !grant.plan.tools.includes(`mcp_${data.serverId}_${data.name}`)) throw new Error("本地 MCP 工具未批准。");
        return await server.client.callTool({ name: data.name, arguments: data.args }, undefined, { timeout: 30000 });
      }
      if (action !== "call" || !grant.plan.tools.includes("computer")) throw new Error("未批准电脑操作。");
      const args = { ...data.args }, { mutates, observes } = validateCall(grant, data.name, args);
      const connection = await driver();
      if (grant.stopped || activeRun !== data.runId) throw new Error("本机控制已停止。");
      if (!catalog.some(t => t.name === data.name)) throw new Error("此平台不支持该桌面工具。");
      const targetId = args.target_window_id ?? args.window_id;
      let window;
      if (targetId !== undefined) {
        window = unpack(await connection.callTool({ name: "get_window", arguments: { window_id: targetId } }));
        window = window.window || window;
        if (!appAllowed(grant, window.bundleId)) throw new Error("目标窗口不属于批准应用。");
      }
      if (["screenshot", "get_ui_tree", "get_focused_element", "find_element", "list_menu_bar", "get_app_capabilities"].includes(data.name) && !targetId && !args.target_app && !args.bundle_id) throw new Error("观察必须指定批准应用或其窗口，不能抓取整个桌面。");
      if (mutates && data.name !== "open_application" && data.name !== "activate_app" && data.name !== "activate_window" && data.name !== "set_target") {
        if (grant.observe) throw new Error("请先重新观察目标应用，再操作。");
        const front = unpack(await connection.callTool({ name: "get_frontmost_app", arguments: {} }));
        const app = front.app || front;
        if (!appAllowed(grant, app.bundleId) || (window && window.pid !== app.pid) || (targetId && grant.windowId !== targetId)) { grant.observe = true; throw new Error("目标应用或窗口已改变，已暂停，请重新观察。"); }
        args.focus_strategy = "strict"; args.force = false;
      }
      if (grant.stopped || activeRun !== data.runId) throw new Error("本机控制已停止。");
      const result = await connection.callTool({ name: data.name, arguments: args }, undefined, { timeout: 30000 });
      if (result.isError) { grant.observe = true; throw new Error("桌面操作被拒绝或失败，请检查权限、用户接管状态和目标窗口。"); }
      if (observes) { grant.observe = false; grant.windowId = targetId ?? null; }
      if (["open_application", "activate_app", "activate_window", "set_target"].includes(data.name)) grant.observe = true;
      if (data.name === "list_windows") {
        const raw = unpack(result); const windows = (Array.isArray(raw) ? raw : raw.windows || []).filter(w => appAllowed(grant, w.bundleId));
        return { content: [{ type: "text", text: JSON.stringify({ windows }) }] };
      }
      return result;
    } finally { busy = false; }
  }
  ipcMain.handle("mxpage-agent:configure-mcp", async (event, servers) => {
    trusted(event);
    for (const [id, server] of localServers) if (!servers.some(s => s.id === id && s.enabled && s.transport === "stdio")) { await server.client?.close(); localServers.delete(id); }
    for (const server of servers) {
      if (server.transport !== "stdio" || !server.enabled) continue;
      if (!path.isAbsolute(server.command) || !fs.existsSync(server.command) || !Array.isArray(server.args)) throw new Error("本地 MCP 程序路径无效。");
      const previous = localServers.get(server.id);
      if (previous?.client) await previous.client.close();
      localServers.set(server.id, { config: server, client: null });
    }
  });
  return {
    attach(child) { serverChild = child; child.on("message", async message => {
      if (message?.channel !== "mxpage-agent" || typeof message.id !== "string") return;
      try { const result = await dispatch(message.action, message.data || {}); if (child.connected) child.send({ channel: "mxpage-agent", id: message.id, result }); }
      catch (error) { if (child.connected) child.send({ channel: "mxpage-agent", id: message.id, error: error.message }); }
    }); },
    async close() { globalShortcut.unregister("CommandOrControl+Shift+Escape"); await stop(); await Promise.allSettled([...localServers.values()].map(s => s.client?.close())); },
  };
}
module.exports = { createAgentBroker, unpack };
