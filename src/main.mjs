import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY } from "./eligibility.mjs";
import { createLcuFetch } from "./lcu-fetch.mjs";
import { discoverLcuConnection } from "./lcu-discovery.mjs";
import { LcuCustomLobbyProvider } from "./lcu-provider.mjs";
import { SearchController } from "./search-controller.mjs";
import { SettingsStore } from "./settings.mjs";
import { TRAY_ICON_16, TRAY_ICON_32 } from "./tray-icon.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// The client connection is re-checked on a cadence that depends on the last answer: quickly while the
// client is missing, so the indicator turns green soon after the user launches it, and rarely while it
// is up, because discovery costs a couple of process spawns. A running search is proof of a live client
// on its own, so the check is skipped entirely then instead of running alongside it.
const CLIENT_CHECK_DISCONNECTED_MS = 10_000;
const CLIENT_CHECK_CONNECTED_MS = 60_000;

// Short forms for the tray tooltip and menu, where there is no room for the renderer's full labels.
const STATE_LABELS = {
  idle: "空闲", connecting: "连接客户端", searching: "搜索房间",
  joining: "加入房间", verifying: "核对房间", joined: "守候房间中"
};

let window;
let tray;
let controller;
let settings;
let lcuFetch;
let clientCheckTimer;
let clientStatus = { connected: false, checkedAt: undefined };
// Set once the app is really on its way out; until then closing the window only hides it.
let isQuitting = false;

function publish(event) {
  window?.webContents.send("search:event", event);
  refreshTray();
}

/* ------------------------------ tray ------------------------------ */

/**
 * Two hand-drawn sizes instead of one scaled bitmap: 16px for 100% display scaling and 32px for 200%.
 * They are embedded data URLs, so the portable build needs no icon file next to the exe.
 */
function createTrayImage() {
  const image = nativeImage.createEmpty();
  image.addRepresentation({ scaleFactor: 1, dataURL: `data:image/png;base64,${TRAY_ICON_16}` });
  image.addRepresentation({ scaleFactor: 2, dataURL: `data:image/png;base64,${TRAY_ICON_32}` });
  // A rejected representation must never leave an invisible tray icon behind.
  if (!image.isEmpty()) return image;
  return nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_32, "base64"));
}

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function toggleWindow() {
  if (!window) return;
  if (window.isVisible() && !window.isMinimized()) window.hide();
  else showWindow();
}

function toggleSearch() {
  if (!controller) return;
  if (controller.status().running) controller.stop();
  else controller.start().catch((error) => publish({ type: "error", message: error.message }));
  refreshTray();
}

function buildTrayMenu() {
  const status = controller?.status() ?? {};
  const running = Boolean(status.running);
  const headline = `${STATE_LABELS[status.state] ?? "空闲"}${status.eligibleCount ? ` · 合格 ${status.eligibleCount}` : ""}`;
  return Menu.buildFromTemplate([
    { label: headline, enabled: false },
    { type: "separator" },
    { label: "显示主窗口", click: showWindow },
    { label: running ? "停止搜索" : "开始搜索", click: toggleSearch },
    { type: "separator" },
    { label: "退出", click: () => { isQuitting = true; app.quit(); } }
  ]);
}

// Rebuilding the menu on every event would be wasteful (events arrive every couple of seconds), so the
// tray is only touched when something it displays actually changed.
let traySignature = "";
function refreshTray() {
  if (!tray) return;
  const status = controller?.status() ?? {};
  const signature = `${status.state}|${status.running}|${status.eligibleCount}|${clientStatus.connected}`;
  if (signature === traySignature) return;
  traySignature = signature;
  tray.setToolTip(`LeagueHextech · ${STATE_LABELS[status.state] ?? "空闲"}`);
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  try {
    tray = new Tray(createTrayImage());
  } catch (error) {
    // A failed tray must not take the search down with it: the window still works on its own.
    publish({ type: "warning", message: `托盘图标创建失败：${error.message}` });
    return;
  }
  // Left click toggles, like every other tray app on Windows; the menu is on right click.
  tray.on("click", toggleWindow);
  tray.on("double-click", showWindow);
  refreshTray();
}

/* ------------------------------ window ------------------------------ */

function createWindow() {
  window = new BrowserWindow({
    width: 1080, height: 700, resizable: true, minWidth: 880, minHeight: 560,
    title: "LeagueHextech · 海克斯乱斗房间搜索器",
    backgroundColor: "#141416",
    // Same drawing as the tray, so the window and taskbar stop showing the Electron logo.
    icon: createTrayImage(),
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false }
  });
  window.loadFile(path.join(here, "renderer", "index.html"));
  // The boot-time check usually resolves before the renderer has subscribed, so the last known result
  // is re-sent once the page is up.
  window.webContents.on("did-finish-load", () => {
    if (clientStatus.checkedAt) publish({ type: "client-status", ...clientStatus });
  });
  // Closing the window is not quitting. A searcher spends its time waiting for a room to fill, so it
  // keeps working from the tray and the window comes back on a click.
  window.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on("closed", () => { window = undefined; });
}

/* ------------------------------ controller ------------------------------ */

function createController() {
  if (controller) return controller;
  // The LCU's self-signed certificate is pinned to Riot's CA instead of Electron's trust store.
  lcuFetch = createLcuFetch({ onWarning: (message) => publish({ type: "warning", message }) });
  const provider = new LcuCustomLobbyProvider({ fetchImpl: lcuFetch });
  controller = new SearchController(provider, {
    emit: publish,
    intervalMs: settings.settings.pollIntervalMs,
    // Every tuning value the settings store persists has to be handed over here too. Passing only the
    // policy left `stallTimeoutMs` at its constructor default, so a value the user had saved was
    // silently ignored from startup until the next time they pressed save.
    stallTimeoutMs: settings.settings.stallTimeoutMs,
    policy: {
      ...DEFAULT_POLICY,
      minPlayers: settings.settings.minPlayers,
      nameKeywords: settings.settings.nameKeywords,
      maxInvites: settings.settings.maxInvites
    }
  });
  return controller;
}

/** Resolves the LCU connection once and remembers the outcome for the status indicator. */
async function refreshClientStatus() {
  try {
    const connection = await discoverLcuConnection();
    clientStatus = {
      connected: true,
      source: connection.source,
      port: connection.port,
      detail: connection.detail,
      checkedAt: Date.now()
    };
  } catch (error) {
    clientStatus = {
      connected: false,
      hasClient: Boolean(error.hasClient),
      message: error.message,
      attempts: error.attempts ?? [],
      checkedAt: Date.now()
    };
  }
  refreshTray();
  return clientStatus;
}

function scheduleClientCheck() {
  clearTimeout(clientCheckTimer);
  const delay = clientStatus.connected ? CLIENT_CHECK_CONNECTED_MS : CLIENT_CHECK_DISCONNECTED_MS;
  clientCheckTimer = setTimeout(async () => {
    if (window && !controller?.status().running) {
      publish({ type: "client-status", ...(await refreshClientStatus()) });
    }
    scheduleClientCheck();
  }, delay);
  clientCheckTimer.unref?.();
}

/* ------------------------------ lifecycle ------------------------------ */

function start() {
  app.whenReady().then(async () => {
    // Electron installs a File/Edit/View/... menu bar by default. This tool has no menu commands - every
    // action lives in the window or the tray - so the bar is pure decoration on top of the UI.
    Menu.setApplicationMenu(null);
    settings = SettingsStore.at(app.getPath("userData"));
    await settings.load();
    createController();
    createWindow();
    createTray();

    ipcMain.handle("search:status", () => controller.status());
    ipcMain.handle("search:start", async () => {
      await controller.start();
      return controller.status();
    });
    ipcMain.handle("search:stop", () => { controller.stop(); return controller.status(); });
    ipcMain.handle("search:leave", () => controller.leave());
    ipcMain.handle("client:status", () => clientStatus);
    ipcMain.handle("client:diagnose", async () => {
      const status = await refreshClientStatus();
      return status.connected
        ? { ok: true, source: status.source, port: status.port, endpoint: status.detail, checkedAt: status.checkedAt }
        : { ok: false, message: status.message, attempts: status.attempts, checkedAt: status.checkedAt };
    });
    ipcMain.handle("settings:get", () => settings.settings);
    ipcMain.handle("settings:update", async (_event, partial) => {
      controller.configure(await settings.update(partial));
      return settings.settings;
    });

    scheduleClientCheck();
    publish({ type: "client-status", ...(await refreshClientStatus()) });
  });
}

// Living in the tray makes it easy to launch the exe a second time by accident, and two searchers would
// race each other for the same rooms, so a second launch just brings the running window back.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  start();
}

app.on("before-quit", () => { isQuitting = true; });

app.on("window-all-closed", () => {
  // With a tray icon the app outlives its window, so this only runs during a real quit.
  if (!isQuitting) return;
  clearTimeout(clientCheckTimer);
  controller?.stop();
  // Drops the pooled LCU sockets so nothing keeps the process alive after the window is gone.
  lcuFetch?.dispose?.();
  app.quit();
});
