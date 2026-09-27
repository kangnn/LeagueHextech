const { contextBridge, ipcRenderer } = require("electron");

// The renderer can only command the search and read status; LCU credentials never cross this bridge.
contextBridge.exposeInMainWorld("searcher", {
  start: () => ipcRenderer.invoke("search:start"),
  stop: () => ipcRenderer.invoke("search:stop"),
  leave: () => ipcRenderer.invoke("search:leave"),
  restart: () => ipcRenderer.invoke("search:restart"),
  status: () => ipcRenderer.invoke("search:status"),
  clientStatus: () => ipcRenderer.invoke("client:status"),
  diagnose: () => ipcRenderer.invoke("client:diagnose"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (settings) => ipcRenderer.invoke("settings:update", settings),
  updateStatus: () => ipcRenderer.invoke("updates:status"),
  checkUpdate: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  skipUpdateVersion: (version) => ipcRenderer.invoke("updates:skip-version", version),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  winMinimize: () => ipcRenderer.invoke("win:minimize"),
  winMaximize: () => ipcRenderer.invoke("win:maximize"),
  winClose: () => ipcRenderer.invoke("win:close"),
  onEvent: (listener) => ipcRenderer.on("search:event", (_event, value) => listener(value))
});
