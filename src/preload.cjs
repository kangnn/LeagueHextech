const { contextBridge, ipcRenderer } = require("electron");

// The renderer can only command the search and read status; LCU credentials never cross this bridge.
contextBridge.exposeInMainWorld("searcher", {
  start: () => ipcRenderer.invoke("search:start"),
  stop: () => ipcRenderer.invoke("search:stop"),
  leave: () => ipcRenderer.invoke("search:leave"),
  status: () => ipcRenderer.invoke("search:status"),
  clientStatus: () => ipcRenderer.invoke("client:status"),
  diagnose: () => ipcRenderer.invoke("client:diagnose"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (settings) => ipcRenderer.invoke("settings:update", settings),
  updateStatus: () => ipcRenderer.invoke("updates:status"),
  checkUpdate: () => ipcRenderer.invoke("updates:check"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onEvent: (listener) => ipcRenderer.on("search:event", (_event, value) => listener(value))
});
