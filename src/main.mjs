import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY } from "./eligibility.mjs";
import { createLcuFetch } from "./lcu-fetch.mjs";
import { discoverLcuConnection } from "./lcu-discovery.mjs";
import { LcuCustomLobbyProvider, normalize } from "./lcu-provider.mjs";
import { createLcuWebsocket } from "./lcu-websocket.mjs";
import { SearchController } from "./search-controller.mjs";
import { SettingsStore } from "./settings.mjs";
import { createStatsReporter } from "./stats.mjs";
import { resolveAutoUpdater } from "./updater-loader.mjs";
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
let stats;
let lcuFetch;
let clientCheckTimer;
let clientStatus = { connected: false, checkedAt: undefined };
// The live client socket and the connection (port:token) it was built from; rebuilt whenever
// discovery reports a different client.
let lcuSocket;
let lcuSocketKey = "";
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
  const template = [
    { label: headline, enabled: false },
    { type: "separator" },
    { label: "显示主窗口", click: showWindow },
    { label: running ? "停止搜索" : "开始搜索", click: toggleSearch },
    { type: "separator" }
  ];
  // The update entry only appears once there is something to do with it, and it is the restart-and-apply
  // action that a downloaded update is waiting for.
  if (updateState.status === "ready") {
    template.push({ label: `重启并更新到 v${updateState.version}`, click: installUpdate });
  } else if (updateState.supported) {
    template.push({
      label: updateState.status === "downloading" ? `正在下载更新 ${updateState.percent ?? 0}%` : "检查更新",
      enabled: updateState.status !== "downloading" && updateState.status !== "checking",
      click: () => { checkForUpdates(); }
    });
  }
  template.push({ label: "退出", click: () => { isQuitting = true; app.quit(); } });
  return Menu.buildFromTemplate(template);
}

// Rebuilding the menu on every event would be wasteful (events arrive every couple of seconds), so the
// tray is only touched when something it displays actually changed. Download progress is bucketed so a
// long download does not rebuild the menu on every tick.
let traySignature = "";
function refreshTray() {
  if (!tray) return;
  const status = controller?.status() ?? {};
  const progress = updateState.percent === undefined ? "" : Math.floor(updateState.percent / 10);
  const signature = [
    status.state, status.running, status.eligibleCount, clientStatus.connected,
    updateState.status, updateState.version ?? "", progress
  ].join("|");
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

/* ------------------------------ updates ------------------------------ */

// electron-updater only exists in the installed build: electron-builder bundles it from `dependencies`,
// while the hand-rolled portable folder ships no node_modules at all. The import is therefore allowed to
// fail, and everything below degrades to "no updater" rather than breaking startup.
let updater;
let updateState = { supported: false, status: "idle" };

// electron-updater reports one network failure several times over (its internal retry stages each
// log, and the error event repeats it), so identical messages inside a window are collapsed to one
// log line. Network errors also get a plain-language version instead of a Chromium error code.
const UPDATE_PROBLEM_WINDOW_MS = 10 * 60 * 1000;
let lastUpdateProblem = { text: "", at: 0 };

function describeUpdateProblem(raw) {
  const text = String(raw).split("\n")[0];
  // No "检查更新失败" prefix here - the renderer's own summary/toast wording adds one.
  if (/net::ERR_CONNECTION_RESET/i.test(text)) return "连接被重置，暂时无法访问更新服务器（网络或代理问题，不影响使用）";
  if (/net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_(TIMED_OUT|REFUSED)|NAME_NOT_RESOLVED|TIMED_OUT|ACCESS_DENIED)/i.test(text)) return "暂时无法访问更新服务器（网络或代理问题，不影响使用）";
  return text;
}

function publishUpdateProblem(kind, raw) {
  const text = describeUpdateProblem(raw);
  const now = Date.now();
  if (text === lastUpdateProblem.text && now - lastUpdateProblem.at < UPDATE_PROBLEM_WINDOW_MS) return;
  lastUpdateProblem = { text, at: now };
  publish({ type: kind, message: `更新：${text}` });
}

function setUpdateState(next) {
  // `notice` is per-event routing for the renderer (prompt / silent / download) and must not leak
  // into the next state - a stale "prompt" would re-open the ask on every download tick.
  updateState = { ...updateState, notice: undefined, ...next };
  publish({ type: "update", ...updateState });
  refreshTray();
}

async function setUpdates() {
  // Reported either way, so a manual check can say which version is current.
  updateState = { ...updateState, currentVersion: app.getVersion() };
  // A development run has no app-update.yml and no installed copy to replace.
  if (!app.isPackaged) return undefined;
  try {
    updater = resolveAutoUpdater(await import("electron-updater"));
  } catch {
    // Portable folder: the way to update is to download a new build.
    return undefined;
  }
  // `autoUpdater` is only a property of the module's default export under ESM; treating it as a named
  // export is what made 0.1.1 a dead window (see src/updater-loader.mjs).
  if (!updater) return undefined;
  // Downloads are explicit: a check the user did not ask for (startup, the 6-hour timer) asks first,
  // and only the user's answer moves bytes. A manual check starts the download itself.
  updater.autoDownload = false;
  // A user who simply closes the window still ends up current the next time the app starts.
  updater.autoInstallOnAppQuit = true;
  // There is no web-installer flow here, and the updater nags about it unless told so.
  updater.disableWebInstaller = true;
  // A dev build (version like `0.1.3-ci.g<sha>`) follows the dev channel: electron-updater then reads
  // the `ci.yml` of the newest prerelease. A stable install keeps the default and never sees one.
  if (app.getVersion().includes("-")) updater.allowPrerelease = true;
  // The updater's own chatter belongs in the event log, not on stdout.
  updater.logger = {
    info: () => {},
    debug: () => {},
    warn: (message) => publishUpdateProblem("warning", message),
    error: (message) => publishUpdateProblem("error", message)
  };
  updater.on("checking-for-update", () => setUpdateState({ status: "checking" }));
  updater.on("update-available", (info) => {
    const version = info?.version;
    const auto = updateCheckSource === "auto";
    if (auto && version !== undefined && version === settings?.settings?.skippedUpdateVersion) {
      // The user already declined this exact version; stay quiet until something newer appears.
      setUpdateState({ status: "available", version, notice: "silent" });
      return;
    }
    if (auto) {
      // A background check never downloads on its own: it asks, with buttons in the window.
      setUpdateState({ status: "available", version, notice: "prompt" });
      return;
    }
    // A manual check means the user asked for it, so the download starts right away as before.
    setUpdateState({ status: "available", version, notice: "download" });
    void startUpdateDownload();
  });
  updater.on("update-not-available", () => setUpdateState({
    status: "uptodate", version: undefined, percent: undefined,
    // A background check that finds nothing new is silence by design; only a manual check reports it.
    notice: updateCheckSource === "auto" ? "silent" : undefined
  }));
  updater.on("download-progress", (progress) => setUpdateState({ status: "downloading", percent: Math.round(progress?.percent ?? 0) }));
  updater.on("update-downloaded", (info) => setUpdateState({ status: "ready", version: info?.version, percent: 100 }));
  updater.on("error", (error) => {
    const text = String(error?.message ?? error);
    // electron-updater wraps errors and can carry the whole stack inside the message; the UI only
    // needs the first line. And a dev channel that currently has nothing newer is the normal state,
    // not a failure worth an alarm.
    const code = error?.code ?? text.match(/ERR_UPDATER_[A-Z_]+/)?.[0];
    if (code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS") {
      publish({ type: "warning", message: "更新：当前通道暂无可更新的版本" });
      setUpdateState({ status: "uptodate" });
      return;
    }
    // A differential download that falls back to a full download is the updater recovering on its own
    // (usually the previous build shipped without a blockmap), not a failure - the download continues.
    if (text.includes("fallback to full download")) {
      publish({ type: "warning", message: "更新：无法增量下载，本次改为完整下载" });
      return;
    }
    setUpdateState({ status: "error", message: describeUpdateProblem(text) });
  });
  updateState = { ...updateState, supported: true };
  return updater;
}

// Which kind of check is in flight; the "update-available"/"update-not-available" handlers read it
// to decide between asking (auto) and acting (manual). Checks are never concurrent in practice.
let updateCheckSource = "manual";

async function checkForUpdates(source = "manual") {
  if (!updater) {
    publish({ type: "warning", message: "当前是免安装版，不能自动更新；请到发布页下载新版本。" });
    return { ...updateState, supported: false };
  }
  updateCheckSource = source;
  try {
    await updater.checkForUpdates();
  } catch (error) {
    setUpdateState({ status: "error", message: describeUpdateProblem(String(error?.message ?? error)) });
  }
  return updateState;
}

async function startUpdateDownload() {
  // Only an "available" state may start one: this guard also stops a double click from launching
  // two downloads, and downloadUpdate() is what flips the state on to "downloading"/"ready".
  if (!updater || updateState.status !== "available") return false;
  try {
    await updater.downloadUpdate();
  } catch (error) {
    setUpdateState({ status: "error", message: describeUpdateProblem(String(error?.message ?? error)) });
  }
  return true;
}

function installUpdate() {
  if (!updater || updateState.status !== "ready") return false;
  // The updater runs its own installer, so the app really has to exit here.
  isQuitting = true;
  setImmediate(() => updater.quitAndInstall(false, true));
  return true;
}

function scheduleUpdateCheck() {
  if (!updater) return;
  // Late enough not to compete with client discovery at startup, then twice a day. Both are
  // background checks: they ask before downloading and stay silent when nothing is new.
  setTimeout(() => { checkForUpdates("auto"); }, 20_000).unref?.();
  setInterval(() => { checkForUpdates("auto"); }, 6 * 60 * 60 * 1000).unref?.();
}

/* ------------------------------ window ------------------------------ */

function createWindow() {
  window = new BrowserWindow({
    width: 1080, height: 700, resizable: true, minWidth: 880, minHeight: 560,
    // The renderer draws its own titlebar (title, version, tool and window buttons), so the native
    // one is hidden; the taskbar still shows `title`.
    titleBarStyle: "hidden",
    title: "LeagueHextech",
    backgroundColor: "#101014",
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
    // A live client means a live socket: this also drives the event-driven watch and liveness.
    // Socket setup must never break the status readout itself - when it could, one bad connection
    // object left the indicator stuck on "未检测到客户端" even while a search was talking to the
    // client just fine.
    try {
      ensureLcuSocket(connection);
    } catch (error) {
      publish({ type: "warning", message: `实时连接建立失败：${error?.message ?? error}` });
    }
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

/** The joined-lobby endpoints the watch loop consumes; every other push is ignored. */
const LOBBY_PUSH_URIS = new Set(["/lol-lobby/v2/lobby", "/lol-lobby/v1/lobby"]);

function handleLcuSocketEvent({ uri, eventType, data }) {
  if (!LOBBY_PUSH_URIS.has(uri)) return;
  if (eventType === "Delete" || data === null || data === undefined) {
    // The room is gone (game started, or the user left): an empty push runs the room-gone path.
    controller?.acceptLobbyPush(undefined);
    return;
  }
  if (typeof data !== "object" || Array.isArray(data)) return;
  try {
    controller?.acceptLobbyPush(normalize(data));
  } catch {
    // A payload shape the normalizer does not know is dropped; the backstop fetch covers the gap.
  }
}

/**
 * Keeps one supervised WebSocket per discovered client. The socket's lifecycle *is* the liveness
 * signal - it closes exactly when the client exits - so a healthy socket also lets the periodic
 * discovery skip its work entirely. When discovery reports a different client (restart changes
 * the port/token), the old session is replaced; its stop() must not be mistaken for a real
 * disconnect, which is what the session-identity guard in `onDown` is for.
 */
function ensureLcuSocket(connection) {
  const key = `${connection.port}:${connection.token}`;
  if (lcuSocket && lcuSocketKey === key) return;
  const stale = lcuSocket;
  lcuSocket = undefined;
  lcuSocketKey = "";
  stale?.stop();

  const session = createLcuWebsocket({
    port: connection.port,
    token: connection.token,
    onEvent: handleLcuSocketEvent,
    onUp() {
      controller.watchPushConnected = true;
      if (!clientStatus.connected) {
        clientStatus = { ...clientStatus, connected: true, checkedAt: Date.now() };
        publish({ type: "client-status", ...clientStatus });
      }
      refreshTray();
    },
    onDown() {
      // A replaced session stopping itself is not a disconnect.
      if (lcuSocket !== session) return;
      controller.watchPushConnected = false;
      if (clientStatus.connected) {
        clientStatus = {
          connected: false,
          hasClient: true,
          message: "与 League Client 的实时连接已断开（客户端可能已退出）",
          checkedAt: Date.now()
        };
        publish({ type: "client-status", ...clientStatus });
      }
      // The cached connection parameters are now suspect; the next request must re-discover.
      controller.provider.invalidate();
      refreshTray();
      // The pending check may be a 60s one (scheduled while connected); a restarted client should
      // be found on the much shorter disconnected cadence instead.
      scheduleClientCheck();
    }
  });
  lcuSocket = session;
  lcuSocketKey = key;
  session.start();
}

function scheduleClientCheck() {
  clearTimeout(clientCheckTimer);
  const delay = clientStatus.connected ? CLIENT_CHECK_CONNECTED_MS : CLIENT_CHECK_DISCONNECTED_MS;
  clientCheckTimer = setTimeout(async () => {
    // The reschedule is in a finally: a thrown check must not silently end the loop, or the
    // indicator freezes on whatever it last showed.
    try {
      // A live socket already proves the client is here; discovery would only burn process spawns.
      if (window && !controller?.status().running && !lcuSocket?.isUp()) {
        publish({ type: "client-status", ...(await refreshClientStatus()) });
      }
    } catch (error) {
      clientStatus = { connected: false, message: String(error?.message ?? error), checkedAt: Date.now() };
      publish({ type: "client-status", ...clientStatus });
    } finally {
      scheduleClientCheck();
    }
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

    // Everything the window can ask for is registered *before the window exists*. The renderer starts
    // firing IPC the moment it loads (the titlebar icon is fetched on module load), and the 0.1.1 build
    // showed what a registration gap does: one exception there left a window whose every button
    // answered "No handler registered" - a nice-to-have must never be able to do that.
    ipcMain.handle("search:status", () => controller.status());
    ipcMain.handle("search:start", async () => {
      await controller.start();
      return controller.status();
    });
    ipcMain.handle("search:stop", () => { controller.stop(); return controller.status(); });
    ipcMain.handle("search:leave", () => controller.leave());
    // One click for "this room is fine but I don't want it": leave, then search again. Starting only
    // after the leave actually reached idle - a failed leave leaves the room in place, and a new
    // search would just adopt the very room the user asked to leave.
    ipcMain.handle("search:restart", async () => {
      const afterLeave = await controller.leave();
      if (afterLeave.state !== "idle") return afterLeave;
      await controller.start();
      return controller.status();
    });
    ipcMain.handle("client:status", () => clientStatus);
    ipcMain.handle("client:diagnose", async () => {
      const status = await refreshClientStatus();
      return status.connected
        ? { ok: true, source: status.source, port: status.port, endpoint: status.detail, checkedAt: status.checkedAt }
        : {
          ok: false,
          message: status.message,
          hasClient: Boolean(status.hasClient),
          attempts: status.attempts,
          checkedAt: status.checkedAt
        };
    });
    ipcMain.handle("settings:get", () => settings.settings);
    ipcMain.handle("settings:update", async (_event, partial) => {
      controller.configure(await settings.update(partial));
      return settings.settings;
    });
    ipcMain.handle("updates:status", () => updateState);
    ipcMain.handle("updates:check", () => checkForUpdates());
    ipcMain.handle("updates:install", () => installUpdate());
    // The two answers to an automatic check's question: start moving bytes, or stop being asked
    // about this exact version (a newer one asks again; a manual check ignores the skip).
    ipcMain.handle("updates:download", () => startUpdateDownload());
    ipcMain.handle("updates:skip-version", async (_event, version) => {
      await settings.update({ skippedUpdateVersion: typeof version === "string" ? version.slice(0, 32) : "" });
      setUpdateState({ notice: "silent" });
      return updateState;
    });
    // The renderer draws its own titlebar, so the window buttons live here. `close` still runs the
    // close-to-tray handler instead of quitting.
    ipcMain.handle("win:minimize", () => window?.minimize());
    ipcMain.handle("win:maximize", () => (window?.isMaximized() ? window?.unmaximize() : window?.maximize()));
    ipcMain.handle("win:close", () => window?.close());

    createWindow();

    createTray();
    scheduleClientCheck();
    // 匿名使用统计（随机 ID + 版本号，失败静默），与更新器一样不许拖慢或干扰启动。
    stats = createStatsReporter({ userDataPath: app.getPath("userData"), appVersion: app.getVersion() });
    stats.start();
    // Deliberately not awaited, and wrapped: the updater is optional, so neither a slow import nor a
    // failure inside it can delay or break the rest of startup.
    setUpdates()
      .then(() => scheduleUpdateCheck())
      .catch((error) => publish({ type: "warning", message: `更新器初始化失败：${error?.message ?? error}` }));

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

app.on("before-quit", () => {
  isQuitting = true;
  // 尽力补发下线信号；进程很快退出，发不出去就由服务端的心跳超时兜底。
  stats?.stop();
});

app.on("window-all-closed", () => {
  // With a tray icon the app outlives its window, so this only runs during a real quit.
  if (!isQuitting) return;
  clearTimeout(clientCheckTimer);
  controller?.stop();
  lcuSocket?.stop();
  // Drops the pooled LCU sockets so nothing keeps the process alive after the window is gone.
  lcuFetch?.dispose?.();
  app.quit();
});
