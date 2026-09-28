/**
 * Runs the renderer's own inline module against a tiny DOM double and asserts the log panel's
 * contract: bounded length, repeat collapsing, coloured tones and structured room chips.
 *
 * A real browser is not available in this sandbox, so this is the closest thing to opening the window.
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// `new URL(...).pathname` keeps %20 escapes, which breaks every path under a directory with a space.
// The project root is one level up from this file.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(root, "src", "renderer", "index.html");
const html = readFileSync(htmlPath, "utf8");

const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!match) throw new Error("no inline module script found in index.html");
const scriptPath = path.join(root, "tests", ".extract.mjs");
writeFileSync(scriptPath, match[1], "utf8");

let failures = 0;
const check = (name, condition, detail = "") => {
  if (condition) console.log("PASS", name);
  else { failures += 1; console.log("FAIL", name, detail); }
};

/* ---------- minimal DOM ---------- */
class El {
  constructor(tag, text = "") {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.className = "";
    this.title = "";
    this.hidden = false;
    this.value = "";
    this.style = { setProperty: () => {} };
    this.parent = undefined;
    this._text = text;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  get classList() {
    const self = this;
    const parts = () => String(self.className).split(/\s+/).filter(Boolean);
    return {
      add: (name) => { if (!parts().includes(name)) self.className = [...parts(), name].join(" "); },
      remove: (name) => { self.className = parts().filter((part) => part !== name).join(" "); },
      contains: (name) => parts().includes(name),
      toggle: (name, force) => {
        const want = force ?? !parts().includes(name);
        if (want) self.classList.add(name); else self.classList.remove(name);
        return want;
      }
    };
  }
  /** The renderer asks "is the pointer on it?" to decide whether a toggle keeps the notice open. */
  matches(selector) { return selector === ":hover" ? Boolean(this._hover) : false; }
  /** Deduplication keys off a notice still being in the document; the stub models that by parentage. */
  get isConnected() { return Boolean(this.parent); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  /** The real DOM promotes bare strings to text nodes; the stub has to as well, because the busy
      wrapper appends its verb phrase as a string next to the spinner element. */
  #node(value) { return typeof value === "string" ? new El("#text", value) : value; }
  append(...nodes) { for (const node of nodes) { const child = this.#node(node); this.children.push(child); child.parent = this; } }
  prepend(node) { const child = this.#node(node); this.children.unshift(child); child.parent = this; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
  }
  querySelector(selector) { return this.#find(selector.replace(/^[.#]/, ""), selector.startsWith(".") ? "class" : "tag"); }
  querySelectorAll(selector) { return this.#findAll(selector.replace(/^[.#]/, ""), selector.startsWith(".") ? "class" : "tag"); }
  #findAll(needle, kind) {
    let hits = [];
    for (const child of this.children) {
      const hit = kind === "class"
        ? String(child.className).split(/\s+/).includes(needle)
        : child.tagName === needle;
      if (hit) hits.push(child);
      hits = hits.concat(child.querySelectorAll?.(kind === "class" ? `.${needle}` : needle) ?? []);
    }
    return hits;
  }
  #find(needle, kind) {
    for (const child of this.children) {
      const hit = kind === "class"
        ? String(child.className).split(/\s+/).includes(needle)
        : child.tagName === needle;
      if (hit) return child;
      const deeper = child.querySelector?.(kind === "class" ? `.${needle}` : needle);
      if (deeper) return deeper;
    }
    return undefined;
  }
  get scrollTop() { return this._scrollTop ?? 0; }
  set scrollTop(value) { this._scrollTop = value; }
  /* A crude scroll model: 20px per line against a 100px viewport. It exists so the log's
     stick-to-bottom logic has something real to compute against. */
  get scrollHeight() { return this.children.length * 20; }
  get clientHeight() { return 100; }
}

const IDS = [
  "state", "log", "logCount", "clearLog", "start", "stop", "leave", "restart", "diagnose", "checkUpdate",
  "client", "clientText", "refreshed", "sweeps", "selectionRow", "selection",
  "errorRow", "error", "updateRow", "updateText", "installUpdate",
  "updatePromptRow", "updatePromptText", "downloadUpdate", "skipUpdate", "laterUpdate",
  "pollIntervalMs", "minPlayers", "maxInvites",
  "stallTimeoutSec", "nameKeywords", "save", "settingsNow",
  "statAttempts", "statJoined", "statAbandoned", "statSkipped", "statErrors",
  "toasts", "topVersion",
  "themeBtn", "themeMenu",
  "accentSwatches", "accentCustom", "winMin", "winMax", "winClose"
];
const BUTTON_IDS = ["start", "stop", "leave", "restart", "diagnose", "checkUpdate"];
// The real markup gives each button its label; the stub has to as well, because the busy wrapper
// saves the resting label and restores it when the call answers.
const BUTTON_LABELS = { start: "开始搜索", stop: "停止", leave: "离开房间", restart: "继续搜索", diagnose: "检测客户端", checkUpdate: "检查更新" };
// Two of them are glyph-only buttons in the real markup: they carry a <span class="glyph"> rather
// than a text label, which is exactly the branch the busy wrapper and the spinner take.
const GLYPH_BUTTONS = { diagnose: "⟳", checkUpdate: "⇩" };
const byId = new Map(IDS.map((id) => [id, new El(BUTTON_IDS.includes(id) ? "button" : "div")]));
for (const [id, label] of Object.entries(BUTTON_LABELS)) {
  const button = byId.get(id);
  if (GLYPH_BUTTONS[id]) {
    const glyph = new El("span");
    glyph.className = "glyph";
    glyph.textContent = GLYPH_BUTTONS[id];
    button.append(glyph);
  } else {
    button.textContent = label;
  }
}
const missingIds = [];
const document = {
  documentElement: { style: { setProperty: () => {} } },
  getElementById(id) {
    if (!byId.has(id)) { missingIds.push(id); byId.set(id, new El("div")); }
    return byId.get(id);
  },
  createElement: (tag) => new El(tag),
  // The renderer walks every button once at startup to seed its title table (the narrow buttons
  // cannot spell their own verb phrase in place, so the hover title carries it).
  querySelectorAll(selector) {
    if (selector !== "button") return [];
    return [...byId.values()].filter((el) => el.tagName === "button");
  }
};

/* ---------- renderer bridge ---------- */
let listener;
const settings = { pollIntervalMs: 2000, minPlayers: 5, maxInvites: 50, stallTimeoutMs: 180000, nameKeywords: ["10刚", "10钢"] };
const status = { state: "idle", running: false, candidateCount: 0, sweepCount: 0, lastRefreshAt: undefined };
globalThis.document = document;
globalThis.window = {
  searcher: {
    start: async () => status,
    stop: async () => status,
    leave: async () => status,
    status: async () => status,
    clientStatus: async () => ({ connected: true, source: "client-log", port: 7252, checkedAt: Date.now() }),
    diagnose: async () => ({ ok: true, source: "client-log", port: 7252 }),
    getSettings: async () => settings,
    updateSettings: async () => settings,
    updateStatus: async () => ({ supported: true, status: "idle", currentVersion: "0.1.1" }),
    checkUpdate: async () => ({ supported: true, status: "uptodate", currentVersion: "0.1.1" }),
    downloadUpdate: async () => true,
    skipUpdateVersion: async (version) => ({ supported: true, status: "available", version, notice: "silent" }),
    installUpdate: async () => true,
    onEvent: (fn) => { listener = fn; }
  }
};

await import(pathToFileURL(scriptPath).href);

/* ---------- assertions ---------- */
check("every element id the renderer looks up exists in the markup", missingIds.length === 0, missingIds.join(","));
check("the event listener was registered", typeof listener === "function");

/* ---------- the settings panel explains itself ---------- */
const helpBadges = (html.match(/class="help"/g) ?? []).length;
check("every setting carries a visible hover explanation", helpBadges === 5, String(helpBadges));
check("each explanation actually has text",
  (html.match(/class="help" data-tip="[^"]{10,}"/g) ?? []).length === 5, String((html.match(/class="help" data-tip="[^"]{10,}"/g) ?? []).length));
check("the mode choice is gone (the browser never reports a mode)",
  !/modePolicy/.test(html), "modePolicy still present");
check("the subtitle line is gone", !/class="sub"/.test(html), "sub still present");
check("zero means 'do not wait' in the stall explanation", /填 0 = 不等待/.test(html));

const lobby = (id, players, invites) => ({
  id, playerCount: players, maxHumanPlayers: 10, mapId: 12, inviteCount: invites
});
const fire = (event) => listener(event);

fire({ type: "joining", state: "joining", lobby: lobby("9ff01f04-f50f-4eb9-b0f1-469cf051907e", 2, undefined), message: "尝试加入" });
const log = document.getElementById("log");
const joiningLine = log.children.at(-1);
check("a log line is a coloured row", joiningLine?.className === "line" && joiningLine?.dataset.tone === "accent", joiningLine?.dataset.tone);
const roomChip = joiningLine.querySelector(".room");
check("the room is a short chip with the full id in its tooltip",
  roomChip?.textContent === "9ff01f04" && roomChip?.title === "9ff01f04-f50f-4eb9-b0f1-469cf051907e",
  `${roomChip?.textContent} / ${roomChip?.title}`);
check("the player count is its own chip", joiningLine.querySelector(".count")?.textContent === "2/10 人");
check("the timestamp and badge are separate spans",
  Boolean(joiningLine.querySelector(".t")?.textContent) && joiningLine.querySelector(".tag")?.textContent === "加入房间",
  `${joiningLine.querySelector(".t")?.textContent} | ${joiningLine.querySelector(".tag")?.textContent}`);

fire({ type: "joined", state: "joined", lobby: lobby("9ff01f04-f50f-4eb9-b0f1-469cf051907e", 9, 20), message: "已在房间内，持续确认人数变化" });
check("a success row is green-toned", log.children.at(-1).dataset.tone === "ok");
fire({ type: "error", state: "idle", message: "未检测到已登录的 League Client" });
check("an error row is red-toned", log.children.at(-1).dataset.tone === "bad");
fire({ type: "skipped", state: "searching", lobby: lobby("2f92c643-767e-4d65-9e56-5db925ac8fcd", 1, undefined), message: "邀请名额已满（上限 50），无法加入" });
check("a skipped room is amber-toned", log.children.at(-1).dataset.tone === "warn");

// The raw LCU rejection carries the full UUID in the request path; the sentence shows the 8-character
// form and keeps the untouched text one hover away.
fire({ type: "skipped", state: "searching", lobby: lobby("2f92c643-767e-4d65-9e56-5db925ac8fcd", 1, undefined), message: "无法连接 League Client（POST /lol-lobby/v2/party/2f92c643-767e-4d65-9e56-5db925ac8fcd/join）：boom" });
const rawSkipLine = log.children.at(-1);
const rawSkipMsg = rawSkipLine.querySelector(".msg");
check("a UUID in the message is shortened to 8 characters",
  rawSkipMsg?.textContent === "无法连接 League Client（POST /lol-lobby/v2/party/2f92c643/join）：boom", rawSkipMsg?.textContent);
check("the full message stays available on hover", rawSkipMsg?.title?.includes("2f92c643-767e-4d65-9e56-5db925ac8fcd") === true, rawSkipMsg?.title);
fire({ type: "left-stale-room", state: "searching", lobby: lobby("aaaabbbb-0000-0000-0000-000000000000", 3, 50), message: "邀请已达上限，人数仍为 3，已退出" });
check("the invite count gets its own chip", log.children.at(-1).querySelector(".invite")?.textContent === "邀请 50");

fire({
  type: "watching", state: "joined",
  lobby: { ...lobby("aaaabbbb-0000-0000-0000-000000000000", 8, 21), spectatorsAllowed: true, maxSpectators: 4, spectatorCount: 1 },
  message: "房间人数有变化"
});
check("an open spectator gate gets its own chip", log.children.at(-1).querySelector(".spectate")?.textContent === "观战 1/4", log.children.at(-1).querySelector(".spectate")?.textContent);

const before = log.children.length;
fire({ type: "searching", state: "searching", message: "本轮没有可用房间" });
fire({ type: "searching", state: "searching", message: "本轮没有可用房间" });
fire({ type: "searching", state: "searching", message: "本轮没有可用房间" });
check("an identical repeat collapses instead of stacking", log.children.length === before + 1, `${before} -> ${log.children.length}`);
check("the repeat counter shows the count", log.children.at(-1).querySelector(".x")?.textContent === "×3", log.children.at(-1).querySelector(".x")?.textContent);

for (let i = 0; i < 600; i += 1) {
  fire({ type: "skipped", state: "searching", lobby: lobby(`room-${i}`, i % 11, undefined), message: `第 ${i} 次跳过` });
}
check("the log never exceeds its bound", log.children.length === 200, String(log.children.length));
check("the counter reports the bound", document.getElementById("logCount").textContent === "200 条", document.getElementById("logCount").textContent);
check("the newest line is at the bottom", log.children.at(-1).querySelector(".msg")?.textContent === "第 599 次跳过", log.children.at(-1).querySelector(".msg")?.textContent);
check("the oldest lines are dropped from the DOM", log.children.some((child) => child.querySelector(".msg")?.textContent === "第 0 次跳过") === false);
check("the view follows the newest line to the bottom", log.scrollTop === log.scrollHeight, `${log.scrollTop} / ${log.scrollHeight}`);

document.getElementById("clearLog").onclick();
check("clear empties the panel", log.children.length === 0 && document.getElementById("logCount").textContent === "0 条", `${log.children.length} / ${document.getElementById("logCount").textContent}`);
fire({ type: "joining", state: "joining", message: "尝试加入" });
document.getElementById("clearLog").onclick();
check("clearing the log zeroes the aggregate too",
  ["statAttempts", "statJoined", "statAbandoned", "statSkipped", "statErrors"].every((id) => document.getElementById(id).textContent === "0"),
  ["statAttempts", "statJoined", "statAbandoned", "statSkipped", "statErrors"].map((id) => document.getElementById(id).textContent).join("/"));

/* ---------- status rendering ---------- */
fire({ type: "client-status", connected: false, message: "未检测到已登录的 League Client", checkedAt: Date.now() });
check("the connection pill goes red when the client is missing", document.getElementById("client").dataset.state === "off");
fire({ type: "client-status", connected: true, source: "lockfile", port: 7252, checkedAt: Date.now() });
check("the connection pill goes green once connected", document.getElementById("client").dataset.state === "on");
fire({ type: "client-status", connected: false, hasClient: true, message: "已检测到 League Client 但无法获取连接参数", checkedAt: Date.now() });
check("a running client whose parameters cannot be read is its own state", document.getElementById("client").dataset.state === "warn");
fire({ type: "client-status", connected: true, source: "lockfile", port: 7252, checkedAt: Date.now() });
check("client status is not written into the event log", log.children.length === 0, String(log.children.length));

/* ---------- the aggregate line over the feed ---------- */
const stat = (id) => document.getElementById(id).textContent;
fire({ type: "connecting", state: "connecting" });
fire({ type: "joining", state: "joining", message: "尝试加入" });
fire({ type: "joining", state: "joining", message: "尝试加入" });
fire({ type: "joined", state: "joined", message: "已在房间内" });
fire({ type: "left-stale-room", state: "searching", message: "邀请已达上限，已退出" });
fire({ type: "skipped", state: "searching", message: "房间不可加入" });
fire({ type: "error", state: "searching", message: "LCU 请求超时" });
check("the feed carries a running aggregate",
  [stat("statAttempts"), stat("statJoined"), stat("statAbandoned"), stat("statSkipped"), stat("statErrors")].join("/") === "2/1/1/1/1",
  [stat("statAttempts"), stat("statJoined"), stat("statAbandoned"), stat("statSkipped"), stat("statErrors")].join("/"));
fire({ type: "connecting", state: "connecting" });
fire({ type: "joining", state: "joining", message: "尝试加入" });
check("a new search does not reset the aggregate - the panel keeps old lines, so the numbers must match it",
  [stat("statAttempts"), stat("statJoined"), stat("statAbandoned"), stat("statSkipped"), stat("statErrors")].join("/") === "3/1/1/1/1",
  [stat("statAttempts"), stat("statJoined"), stat("statAbandoned"), stat("statSkipped"), stat("statErrors")].join("/"));

fire({ type: "joined", state: "joined", running: true, lobby: lobby("ccccdddd-1111-2222-3333-444455556666", 8, 30), message: "已在房间内" });
check("the current room row appears while joined", document.getElementById("selectionRow").hidden === false);
check("the current room is shown as chips, not a sentence",
  document.getElementById("selection").children.length === 3, String(document.getElementById("selection").children.length));

// Below the floor the row has to explain the wait and when it ends, or a deliberate wait looks like a bug.
fire({
  type: "watching", state: "joined", running: true, belowFloor: true, minPlayers: 5,
  watchDeadlineAt: Date.now() + 30_000, lobby: lobby("ccccdddd-1111-2222-3333-444455556666", 3, 7),
  message: "人数 3 仍低于下限 5，继续等待"
});
const selection = document.getElementById("selection");
check("a below-floor room adds the floor and the deadline", selection.children.length === 5, String(selection.children.length));
check("the floor chip names the limit", selection.querySelector(".floor")?.textContent === "低于下限 5", selection.querySelector(".floor")?.textContent);
check("the deadline chip says when it gives up",
  selection.querySelector(".deadline")?.textContent?.startsWith("最晚 ") === true, selection.querySelector(".deadline")?.textContent);
check("waiting under the floor is amber, not green", log.children.at(-1).dataset.tone === "warn", log.children[0].dataset.tone);

// A leave the client drags out must show that it is in flight, and then how long it took.
fire({ type: "leaving", state: "idle", message: "正在通知客户端退出房间…" });
check("leaving a room is its own log line", log.children.at(-1).querySelector(".tag")?.textContent === "离开房间中", log.children.at(-1).querySelector(".tag")?.textContent);
check("the in-flight leave is not painted as a failure", log.children.at(-1).dataset.tone === "accent", log.children.at(-1).dataset.tone);
fire({ type: "left", state: "idle", elapsedMs: 13_400, message: "已离开房间" });
check("a slow leave reports the client's own duration",
  log.children.at(-1).querySelector(".chips")?.textContent === "耗时 13.4s", log.children.at(-1).querySelector(".chips")?.textContent);
fire({ type: "stopped", state: "idle", running: false, selectedSummary: "房间 ccccdddd-1111-2222-3333-444455556666（8/10 人）" });
check("the current room row disappears when the search stops", document.getElementById("selectionRow").hidden === true);
check("start is re-enabled and leave disabled when idle",
  document.getElementById("start").disabled === false && document.getElementById("leave").disabled === true);
check("restart is disabled when idle too", document.getElementById("restart").disabled === true);

// The whole point of the one-click restart: sitting in a room, both leave and restart are live.
fire({ type: "joined", state: "joined", running: false, lobby: lobby("ccccdddd-1111-2222-3333-444455556666", 8, 3), message: "已在房间内" });
check("in a room, restart is enabled alongside leave",
  document.getElementById("restart").disabled === false && document.getElementById("leave").disabled === false);

/* ---------- the update row ---------- */
document.getElementById("clearLog").onclick();
const updateRow = document.getElementById("updateRow");
check("the update row is hidden while there is nothing to say", updateRow.hidden === true);

fire({ type: "update", supported: true, status: "downloading", version: "0.1.2", percent: 42 });
check("a download in flight shows the version and percentage",
  document.getElementById("updateText").textContent === "正在下载 v0.1.2 42%", document.getElementById("updateText").textContent);
check("the install button stays hidden until the download is done", document.getElementById("installUpdate").hidden === true);
check("download progress stays out of the event log", log.children.length === 0, String(log.children.length));

fire({ type: "update", supported: true, status: "ready", version: "0.1.2", percent: 100 });
check("a downloaded update offers a restart action",
  document.getElementById("updateText").textContent.includes("v0.1.2") && document.getElementById("installUpdate").hidden === false,
  document.getElementById("updateText").textContent);
check("a ready update is logged as good news",
  log.children.length === 1 && log.children.at(-1).dataset.tone === "ok", log.children[0]?.dataset.tone);

fire({ type: "update", supported: true, status: "uptodate", currentVersion: "0.1.2" });
check("a manual check that finds nothing pops a transient toast",
  document.getElementById("updateRow").hidden === true &&
  document.getElementById("toasts").children[0]?.textContent.includes("已是最新版本"),
  document.getElementById("toasts").children[0]?.textContent);

fire({ type: "update", supported: true, status: "error", message: "网络不可达" });
check("an update failure is reported as a toast rather than swallowed",
  document.getElementById("toasts").children.some((row) => row.className.includes("bad") && row.textContent.includes("网络不可达")),
  document.getElementById("toasts").children.map((row) => row.textContent).join(" | "));

/* ---------- a notice is one sentence with an icon; a repeated one is just another sentence ---------- */
const bannerFor = (text) => document.getElementById("toasts").children.find((row) => row.querySelector(".text")?.textContent === text);
const frozenBanner = bannerFor("更新检查失败：网络不可达");
check("a banner shows an icon and the sentence, and nothing else",
  Boolean(frozenBanner?.querySelector(".badge")) &&
  Boolean(frozenBanner?.querySelector(".text")) &&
  frozenBanner?.children.length === 2,
  `${frozenBanner?.children.length} children`);
check("the banner carries no progress bar, counter or expander",
  !frozenBanner?.querySelector(".bar") && !frozenBanner?.querySelector(".count") && !frozenBanner?.querySelector(".chev"),
  frozenBanner?.className);
const beforeRepeat = document.getElementById("toasts").children.length;
fire({ type: "update", supported: true, status: "error", message: "网络不可达" });
fire({ type: "update", supported: true, status: "error", message: "网络不可达" });
check("a repeated message still lands as its own notice",
  document.getElementById("toasts").children.length > beforeRepeat,
  `${beforeRepeat} -> ${document.getElementById("toasts").children.length}`);
check("the notice stack stays short even under a burst",
  document.getElementById("toasts").children.length <= 3,
  String(document.getElementById("toasts").children.length));
check("a different message still gets its own banner",
  document.getElementById("toasts").children.filter((row) => row.querySelector(".text")).length >= 1);

fire({ type: "update", supported: false, status: "idle" });
check("a build with no updater shows no update row", updateRow.hidden === true);
check("the install action is gone once there is nothing to install", document.getElementById("installUpdate").hidden === true);

/* ---------- an automatic check asks instead of downloading ---------- */
const toastsBeforePrompt = document.getElementById("toasts").children.length;
const logLinesBeforePrompt = log.children.length;
fire({ type: "update", supported: true, status: "available", version: "0.1.3", notice: "prompt" });
check("an automatically found update asks with buttons instead of downloading",
  document.getElementById("updatePromptRow").hidden === false &&
  document.getElementById("updatePromptText").textContent.includes("0.1.3") &&
  document.getElementById("updateText").textContent === "" &&
  document.getElementById("downloadUpdate").hidden === false &&
  document.getElementById("skipUpdate").hidden === false &&
  document.getElementById("laterUpdate").hidden === false,
  document.getElementById("updatePromptText").textContent);
check("the ask is neither a log line nor a toast",
  log.children.length === logLinesBeforePrompt && document.getElementById("toasts").children.length === toastsBeforePrompt,
  `log=${log.children.length}`);

await document.getElementById("downloadUpdate").onclick();
check("accepting the ask hides it and hands over to the download flow",
  document.getElementById("updatePromptRow").hidden === true);

fire({ type: "update", supported: true, status: "available", version: "0.1.3", notice: "prompt" });
fire({ type: "update", supported: true, status: "uptodate", currentVersion: "0.1.1", notice: "silent" });
check("a silent background result clears the ask and says nothing anywhere",
  document.getElementById("updatePromptRow").hidden === true &&
  document.getElementById("toasts").children.length === toastsBeforePrompt &&
  log.children.length === logLinesBeforePrompt,
  `toasts=${document.getElementById("toasts").children.length} log=${log.children.length}`);

fire({ type: "update", supported: true, status: "available", version: "0.1.3", notice: "prompt" });
await document.getElementById("skipUpdate").onclick();
check("skipping hides the ask", document.getElementById("updatePromptRow").hidden === true);
fire({ type: "update", supported: true, status: "downloading", version: "0.1.3", percent: 10 });
check("a download tick does not resurrect the ask", document.getElementById("updatePromptRow").hidden === true);

fire({ type: "update", supported: true, status: "available", version: "0.1.3", notice: "prompt" });
document.getElementById("laterUpdate").onclick();
check("later just closes the ask", document.getElementById("updatePromptRow").hidden === true);

/* ---------- a button in flight carries the state itself, not a banner ---------- */
// The client probe answers in well under 200ms, so it must not raise an in-flight banner - that
// banner arriving alongside its own result is what made the old version feel abrupt. The button
// itself says it is working (the glyph turns in place) and the connection pill pulses. The verdict
// then arrives as one banner.
const toastsBeforeProbe = document.getElementById("toasts").children.length;
let releaseDiagnose;
globalThis.window.searcher.diagnose = () => new Promise((resolve) => { releaseDiagnose = () => resolve({ ok: true, source: "client-log", port: 7252 }); });
const diagnoseButton = document.getElementById("diagnose");
const pendingDiagnose = diagnoseButton.onclick();
check("a button in flight locks itself and turns its glyph",
  diagnoseButton.disabled === true && diagnoseButton.dataset.working === "1" &&
  diagnoseButton.classList.contains("working") &&
  Boolean(diagnoseButton.querySelector(".glyph")),
  `text=${diagnoseButton.textContent} class=${diagnoseButton.className}`);
check("a probe in flight raises no banner",
  document.getElementById("toasts").children.length === toastsBeforeProbe,
  document.getElementById("toasts").children.map((row) => row.textContent).join(" | "));
check("the connection light pulses while the probe is in flight",
  document.getElementById("client").classList.contains("probing"));
releaseDiagnose();
await pendingDiagnose;
check("the busy state is released and the glyph survives it",
  diagnoseButton.disabled === false && diagnoseButton.dataset.working === undefined &&
  !diagnoseButton.classList.contains("working") &&
  diagnoseButton.textContent === "⟳",
  `text=${diagnoseButton.textContent}`);
check("the verdict arrives as a banner",
  document.getElementById("toasts").children.some((row) => row.textContent.includes("已连接")) &&
  document.getElementById("toasts").children.length <= 3,
  document.getElementById("toasts").children.map((row) => row.textContent).join(" | "));
check("the pulse stops once the probe answers",
  !document.getElementById("client").classList.contains("probing"));
check("the verdict is written on the connection pill",
  document.getElementById("clientText").textContent === "已连接客户端",
  document.getElementById("clientText").textContent);
check("the verdict stays out of the event log",
  log.children.every((line) => line.querySelector(".msg")?.textContent?.includes("已连接") !== true),
  log.children.map((line) => line.querySelector(".msg")?.textContent).join(" | "));

let diagnoseCalls = 0;
globalThis.window.searcher.diagnose = async () => { diagnoseCalls += 1; return { ok: true, source: "client-log", port: 7252 }; };
const firstClick = diagnoseButton.onclick();
const secondClick = diagnoseButton.onclick();
await Promise.all([firstClick, secondClick]);
check("a second click while one is in flight is ignored instead of queued",
  diagnoseCalls === 1, String(diagnoseCalls));

/* ---------- slow work still escalates to a banner, but only once it proves slow ---------- */
let releaseUpdate;
globalThis.window.searcher.checkUpdate = () => new Promise((resolve) => { releaseUpdate = () => resolve({ supported: true, status: "uptodate", currentVersion: "0.1.2" }); });
const updateButton = document.getElementById("checkUpdate");
const pendingUpdate = updateButton.onclick();
check("slow work starts on the button, not in a banner",
  document.getElementById("toasts").children.some((row) => row.querySelector(".text")?.textContent === "正在检查更新…") === false,
  document.getElementById("toasts").children.map((row) => row.textContent).join(" | "));
await new Promise((resolve) => setTimeout(resolve, 420));
check("a wait that outlasts the threshold escalates to a banner",
  document.getElementById("toasts").children.some((row) => row.querySelector(".text")?.textContent === "正在检查更新…"),
  document.getElementById("toasts").children.map((row) => row.textContent).join(" | "));
releaseUpdate();
await pendingUpdate;
check("the escalated banner is withdrawn as soon as the answer arrives",
  document.getElementById("toasts").children.some((row) => row.querySelector(".text")?.textContent === "正在检查更新…") === false,
  document.getElementById("toasts").children.map((row) => row.textContent).join(" | "));

rmSync(scriptPath, { force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
