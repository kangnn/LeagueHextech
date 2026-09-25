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
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.className = "";
    this.title = "";
    this.hidden = false;
    this.value = "";
    this.parent = undefined;
    this._text = "";
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
  prepend(node) { this.children.unshift(node); node.parent = this; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
  }
  querySelector(selector) { return this.#find(selector.replace(/^[.#]/, ""), selector.startsWith(".") ? "class" : "tag"); }
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
}

const IDS = [
  "state", "log", "logCount", "clearLog", "start", "stop", "leave", "diagnose",
  "client", "clientText", "refreshed", "sweeps", "selectionRow", "selection",
  "errorRow", "error", "diagnostics", "pollIntervalMs", "minPlayers", "maxInvites",
  "stallTimeoutSec", "nameKeywords", "save", "settingsNow",
  "statAttempts", "statJoined", "statAbandoned", "statSkipped", "statErrors"
];
const byId = new Map(IDS.map((id) => [id, new El("div")]));
const missingIds = [];
const document = {
  getElementById(id) {
    if (!byId.has(id)) { missingIds.push(id); byId.set(id, new El("div")); }
    return byId.get(id);
  },
  createElement: (tag) => new El(tag)
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
  (html.match(/class="help" title="[^"]{10,}"/g) ?? []).length === 5, String((html.match(/class="help" title="[^"]{10,}"/g) ?? []).length));
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
const joiningLine = log.children[0];
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
check("a success row is green-toned", log.children[0].dataset.tone === "ok");
fire({ type: "error", state: "idle", message: "未检测到已登录的 League Client" });
check("an error row is red-toned", log.children[0].dataset.tone === "bad");
fire({ type: "skipped", state: "searching", lobby: lobby("2f92c643-767e-4d65-9e56-5db925ac8fcd", 1, undefined), message: "邀请名单已满，无法加入（PARTY_INVITE_LIMIT）" });
check("a skipped room is amber-toned", log.children[0].dataset.tone === "warn");
fire({ type: "left-stale-room", state: "searching", lobby: lobby("aaaabbbb-0000-0000-0000-000000000000", 3, 50), message: "邀请已达上限，人数仍为 3，已退出" });
check("the invite count gets its own chip", log.children[0].querySelector(".invite")?.textContent === "邀请 50");

const before = log.children.length;
fire({ type: "searching", state: "searching", message: "本轮没有可用房间" });
fire({ type: "searching", state: "searching", message: "本轮没有可用房间" });
fire({ type: "searching", state: "searching", message: "本轮没有可用房间" });
check("an identical repeat collapses instead of stacking", log.children.length === before + 1, `${before} -> ${log.children.length}`);
check("the repeat counter shows the count", log.children[0].querySelector(".x")?.textContent === "×3", log.children[0].querySelector(".x")?.textContent);

for (let i = 0; i < 600; i += 1) {
  fire({ type: "skipped", state: "searching", lobby: lobby(`room-${i}`, i % 11, undefined), message: `第 ${i} 次跳过` });
}
check("the log never exceeds its bound", log.children.length === 200, String(log.children.length));
check("the counter reports the bound", document.getElementById("logCount").textContent === "200 条", document.getElementById("logCount").textContent);
check("the newest line is on top", log.children[0].querySelector(".msg")?.textContent === "第 599 次跳过", log.children[0].querySelector(".msg")?.textContent);
check("the oldest lines are dropped from the DOM", log.children.some((child) => child.querySelector(".msg")?.textContent === "第 0 次跳过") === false);

document.getElementById("clearLog").onclick();
check("clear empties the panel", log.children.length === 0 && document.getElementById("logCount").textContent === "0 条", `${log.children.length} / ${document.getElementById("logCount").textContent}`);

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
check("starting a new search resets the aggregate",
  [stat("statAttempts"), stat("statJoined"), stat("statAbandoned"), stat("statSkipped"), stat("statErrors")].join("/") === "0/0/0/0/0",
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
check("waiting under the floor is amber, not green", log.children[0].dataset.tone === "warn", log.children[0].dataset.tone);

// A leave the client drags out must show that it is in flight, and then how long it took.
fire({ type: "leaving", state: "idle", message: "正在通知客户端退出房间…" });
check("leaving a room is its own log line", log.children[0].querySelector(".tag")?.textContent === "离开房间中", log.children[0].querySelector(".tag")?.textContent);
check("the in-flight leave is not painted as a failure", log.children[0].dataset.tone === "accent", log.children[0].dataset.tone);
fire({ type: "left", state: "idle", elapsedMs: 13_400, message: "已离开房间" });
check("a slow leave reports the client's own duration",
  log.children[0].querySelector(".chips")?.textContent === "耗时 13.4s", log.children[0].querySelector(".chips")?.textContent);
fire({ type: "stopped", state: "idle", running: false, selectedSummary: "房间 ccccdddd-1111-2222-3333-444455556666（8/10 人）" });
check("the current room row disappears when the search stops", document.getElementById("selectionRow").hidden === true);
check("start is re-enabled and leave disabled when idle",
  document.getElementById("start").disabled === false && document.getElementById("leave").disabled === true);

rmSync(scriptPath, { force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
