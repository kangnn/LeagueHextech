// Builds tests/preview/app.html: the real renderer markup with a scripted fake bridge injected
// ahead of its module script, so the UI can be clicked through in a normal browser. This exists
// because an interactive Electron window cannot be driven headlessly on this machine, and the
// things worth checking here (does the button spin, does a banner appear, does the pill flash) are
// all renderer-side.
//
// Re-run after touching src/renderer/index.html:  node tests/preview/build-preview.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const source = path.join(repo, "src", "renderer", "index.html");
const target = path.join(here, "app.html");

const html = fs.readFileSync(source, "utf8");
const marker = '<script type="module">';
const at = html.indexOf(marker);
if (at === -1) throw new Error("找不到渲染层的模块脚本入口");

// The bridge mirrors the real preload surface (see the window.searcher.* call list in the renderer)
// and, crucially, lets each call be made slow on demand: the whole point of this preview is to watch
// what the UI does while a call is still outstanding.
const bridge = `<script>
(() => {
  const listeners = [];
  const settings = { pollIntervalMs: 2000, minPlayers: 9, maxInvites: 50, stallTimeoutMs: 0, nameKeywords: ["10刚", "10钢"] };
  const status = { state: "idle", running: false, candidateCount: 0, sweepCount: 0, lastRefreshAt: Date.now() };
  let scene = "fast";
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const delayed = (ms, value) => async () => { await wait(ms); return value; };

  window.searcher = {
    start: async () => { status.running = true; status.state = "searching"; return status; },
    stop: async () => { status.running = false; status.state = "idle"; return status; },
    restart: async () => status,
    leave: async () => status,
    status: async () => status,
    getSettings: async () => settings,
    updateSettings: async () => settings,
    updateStatus: async () => ({ supported: true, status: "idle", currentVersion: "0.1.5" }),
    winMinimize: () => {}, winMaximize: () => {}, winClose: () => {},
    downloadUpdate: async () => ({ supported: true, status: "downloading", version: "0.1.6", percent: 0 }),
    installUpdate: async () => ({ supported: true, status: "ready", version: "0.1.6" }),
    skipUpdateVersion: async () => ({ supported: true, status: "idle", currentVersion: "0.1.5" }),
    onEvent(fn) { listeners.push(fn); },
    // Lets the harness inject a main-process event (a repeating failure, say) that no button click
    // can produce, so the notice layer's merge behaviour is reachable without a real client.
    __emit(payload) { for (const fn of listeners) fn(payload); },
    // The two probes under test. "fast" is the real-world case: the client answers in well under
    // 200ms, which is exactly why it must not raise a banner.
    clientStatus: async () => ({ connected: true, source: "client-log", port: 7252, checkedAt: Date.now() }),
    diagnose: () => {
      if (scene === "connected") return delayed(180, { ok: true, source: "client-log", port: 7252 })();
      if (scene === "slow") return delayed(800, { ok: false, hasClient: false, message: "未检测到游戏客户端：请先启动英雄联盟客户端并登录到大厅，然后点「重新检测」。" })();
      return delayed(150, { ok: false, hasClient: false, message: "未检测到游戏客户端：请先启动英雄联盟客户端并登录到大厅，然后点「重新检测」。" })();
    },
    checkUpdate: () => {
      if (scene === "slow-update") return delayed(1300, { supported: true, status: "uptodate", currentVersion: "0.1.5" })();
      return async () => ({ supported: true, status: "uptodate", currentVersion: "0.1.5" })();
    }
  };

  window.addEventListener("message", (event) => {
    if (event.data?.scene) scene = event.data.scene;
  });
})();
<\/script>
`;

const built = html.slice(0, at) + bridge + html.slice(at);
fs.writeFileSync(target, built, "utf8");
console.log(`wrote ${path.relative(repo, target)} (${built.length} bytes)`);
