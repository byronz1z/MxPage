const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mxPageDesktop", {
  runtime: "desktop",
  agent: {
    grant: (runId, planHash) => ipcRenderer.invoke("mxpage-agent:grant", runId, planHash),
    stop: () => ipcRenderer.invoke("mxpage-agent:stop"),
    status: () => ipcRenderer.invoke("mxpage-agent:status"),
    configureMcp: servers => ipcRenderer.invoke("mxpage-agent:configure-mcp", servers),
  },
});
