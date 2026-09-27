import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/**
 * Controller / provider behaviour. Runs on plain Node with no dependencies: the LCU is replaced by a
 * hand-written double, so nothing here needs Electron or a running client.
 */
// Resolved from this file's own location, so the suite runs from a clone at any path.
const root = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src")).href + "/";
const { DEFAULT_POLICY, evaluateLobby, evaluateJoinedLobby, rankLobbies, isInviteBudgetExhausted, summarizeLobby } = await import(root + "eligibility.mjs");
const { normalize, LcuCustomLobbyProvider } = await import(root + "lcu-provider.mjs");
const { SearchController } = await import(root + "search-controller.mjs");
const { DEFAULT_SETTINGS } = await import(root + "settings.mjs");

let failures = 0;
const check = (name, condition, detail = "") => {
  if (condition) console.log("PASS", name);
  else { failures += 1; console.log("FAIL", name, detail); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const row = (partyId, filled, name = "10钢 禁高飞过") => ({
  partyId, id: 7, lobbyName: name, mapId: 12, maxPlayerSlots: 10, filledPlayerSlots: filled,
  hasPassword: false, createdAt: "2026-09-25T06:00:00Z"
});
const joined = (partyId, players, invites) => ({
  partyId,
  gameConfig: { gameMode: "KIWI", maxLobbySize: 10, mapId: 12, customMutatorName: "AllRandomPickStrategy" },
  members: Array.from({ length: players }, (_, i) => ({ summonerId: i + 1 })),
  invitations: Array.from({ length: invites }, (_, i) => ({ state: "Declined" }))
});
const policy = { ...DEFAULT_POLICY, nameKeywords: ["10钢"], minPlayers: 5, maxInvites: 50, modePolicy: "attempt" };

// --- the browser count is a hint, never a gate ---
check("1/10 keyword room is a candidate now", evaluateLobby(normalize(row("p1", 1)), policy).eligible);
check("full room is still excluded", ["full", "not-joinable"].includes(evaluateLobby(normalize(row("p1", 10)), policy).reason));
check("password-unknown room is still excluded", evaluateLobby(normalize({ ...row("p1", 3), hasPassword: undefined }), policy).reason === "password-or-unknown");
const order = rankLobbies([normalize(row("a", 1)), normalize(row("b", 9)), normalize(row("c", 6))], policy).map((c) => c.lobby.playerCount);
check("ranking still prefers the closest to 10", JSON.stringify(order) === "[9,6,1]", JSON.stringify(order));

// --- post-join rules: an early room is kept, a spent budget is not ---
check("joined 10/10 room accepted", evaluateJoinedLobby(normalize(joined("p1", 10, 20)), policy).eligible);
check("joined 2/10 with few invites is kept (waiting is the point)", evaluateJoinedLobby(normalize(joined("p1", 2, 1)), policy).eligible);
check("joined 50 invites + 2 players rejected", evaluateJoinedLobby(normalize(joined("p1", 2, 50)), policy).reason === "invites-exhausted");
check("wrong mode rejected", evaluateJoinedLobby({ ...normalize(joined("p1", 8, 1)), gameMode: "CLASSIC" }, policy).reason === "not-mayhem-aram");
check("invite guard ignores a room that filled up", !isInviteBudgetExhausted(normalize(joined("p1", 5, 50)), policy));

// --- a joined lobby reports seat totals; the player capacity is the part inside the 10 slots ---
const seats = (config, members = []) => normalize({
  partyId: "seats",
  gameConfig: { gameMode: "KIWI", mapId: 12, customMutatorName: "AllRandomPickStrategy", ...config },
  members
});
const eightOfFourteen = seats(
  { maxLobbySize: 14, spectatorPolicy: "AllAllowed" },
  Array.from({ length: 8 }, (_, i) => ({ summonerId: i + 1 }))
);
check("maxLobbySize 14 with spectators on reports 10 player seats", eightOfFourteen.maxHumanPlayers === 10, String(eightOfFourteen.maxHumanPlayers));
check("spectator capacity is the client's 4 reserved seats", eightOfFourteen.maxSpectators === 4, String(eightOfFourteen.maxSpectators));
check("an open spectator gate is reported", eightOfFourteen.spectatorsAllowed === true);
check("the summary shows spectators as 观战 0/4", summarizeLobby(eightOfFourteen).includes("观战 0/4"), summarizeLobby(eightOfFourteen));
const spectatorsOff = seats({ maxLobbySize: 10, spectatorPolicy: "AllNotAllowed" });
check("spectators off keeps 10 players and no spectator line", spectatorsOff.maxHumanPlayers === 10 && spectatorsOff.spectatorsAllowed === false && !summarizeLobby(spectatorsOff).includes("观战"), summarizeLobby(spectatorsOff));
const noGateReported = seats({ maxLobbySize: 14 });
check("a build without a spectator gate still reports 10 players", noGateReported.maxHumanPlayers === 10 && noGateReported.spectatorsAllowed === undefined, String(noGateReported.maxHumanPlayers));
const withSpectatorMember = seats(
  { maxLobbySize: 14, spectatorPolicy: "AllAllowed" },
  [{ summonerId: 1, isSpectator: true }, { summonerId: 2 }, { summonerId: 3 }]
);
check("a flagged spectator member is counted and not counted as a player",
  withSpectatorMember.spectatorCount === 1 && withSpectatorMember.playerCount === 2,
  `count=${withSpectatorMember.spectatorCount} players=${withSpectatorMember.playerCount}`);
check("the summary counts the spectator too", summarizeLobby(withSpectatorMember).includes("观战 1/4"), summarizeLobby(withSpectatorMember));

// --- provider surfaces the client's error code ---
const state = { rows: [row("p1", 1)], room: undefined, left: 0, joins: {}, joinError: {} };
const provider = new LcuCustomLobbyProvider({
  credentials: async () => ({ port: "1234", token: "t" }),
  fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    const method = options?.method ?? "GET";
    const send = (status, body) => ({
      ok: status >= 200 && status < 300, status,
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
      json: async () => body
    });
    if (path === "/lol-lobby/v1/custom-games/refresh" && method === "POST") return send(204);
    if (path === "/lol-lobby/v1/custom-games" && method === "GET") return send(200, state.rows);
    if (path.endsWith("/join") && method === "POST") {
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      state.joins[id] = (state.joins[id] ?? 0) + 1;
      const failure = state.joinError[id];
      if (failure) return send(400, { errorCode: "RPC_ERROR", httpStatus: 400, message: failure });
      state.room = joined(id, 1, 1);
      return send(204);
    }
    if (path === "/lol-lobby/v2/lobby" && method === "GET") return state.room ? send(200, state.room) : send(404);
    if (path === "/lol-lobby/v2/lobby" && method === "DELETE") { state.room = undefined; state.left += 1; return send(204); }
    return send(404);
  }
});
state.joinError.p2 = "PARTY_INVITE_LIMIT";
await provider.joinLobby("p2").then(() => check("join rejection carries an error code", false), (error) => {
  // The real client reports errorCode "RPC_ERROR" with the meaningful code in the message body;
  // shaping the double after the real payload is what exposed the matcher that never fired.
  check("join rejection carries the limit code in its message", error.message.includes("PARTY_INVITE_LIMIT"), String(error.message));
});

const events = [];
const controller = new SearchController(provider, {
  policy, emit: (event) => events.push(event),
  intervalMs: 10, maxIntervalMs: 10, sweepIntervalMs: 10, maxSweepIntervalMs: 10,
  attemptGapMs: 0, refreshThrottleMs: 0, exhaustedCooldownMs: 60_000, inviteLimitCooldownMs: 60_000, stallTimeoutMs: 400
});

await controller.start();
check("joined a 1/10 room instead of skipping it", controller.state === "joined", controller.state);
check("the room is reported as-is", controller.status().selectedSummary?.includes("1/10 人") === true, controller.status().selectedSummary);

await sleep(200);
check("still waiting while the room is small (no instant leave)", state.left === 0, `left=${state.left}`);

state.room = joined("p1", 2, 1);
await sleep(300);
check("gaining a player resets the stall timer", state.left === 0, `left=${state.left}`);
check("the join attempt carries the browser snapshot for the log chips", events.some((e) => e.type === "joining" && e.lobby?.playerCount === 1 && e.lobby?.id === "p1"), JSON.stringify(events.find((e) => e.type === "joining")));
check("room changes are logged", events.some((e) => e.type === "watching" && e.lobby?.playerCount === 2), JSON.stringify(events.find((e) => e.type === "watching")));

state.room = joined("p1", 2, 50);
await sleep(120);
check("spent invite budget ends the wait", state.left === 1 && controller.state === "searching", `left=${state.left} state=${controller.state}`);
check("leave explains why", (() => {
  const left = events.find((e) => e.type === "left-stale-room");
  return left?.lobby?.inviteCount === 50 && left?.lobby?.playerCount === 2;
})(), JSON.stringify(events.find((e) => e.type === "left-stale-room")));

const joinsAfterLeave = state.joins.p1;
await sleep(300);
check("the dead room is not re-joined while the snapshot lags", state.joins.p1 === joinsAfterLeave, `joins ${joinsAfterLeave} -> ${state.joins.p1}`);

state.rows = [row("p1", 3)];
await sleep(200);
check("a room that filled up is retried", state.joins.p1 === joinsAfterLeave + 1 && controller.state === "joined", `joins=${state.joins.p1} state=${controller.state}`);

await sleep(600);
check("a room that never grows is given up on", state.left === 2, `left=${state.left}`);
check("stall leave is logged", events.some((e) => e.type === "left-stalled-room" && e.message.includes("停滞")), JSON.stringify(events.at(-1)?.message));

state.rows = [row("p1", 1), row("p2", 1, "10钢禁长手莉莉娅"), row("p3", 2), row("p4", 2)];
state.joinError.p3 = "INVALID_WHILE_PARTY_IN_ACTION";
state.joinError.p4 = "PARTY_SIZE_LIMIT";
await sleep(250);
const inviteLimitSkips = events.filter((e) => e.type === "skipped" && e.message.includes("邀请名额已满")).length;
check("invite-limit rooms are explained in plain language", inviteLimitSkips >= 1, `skips=${inviteLimitSkips}`);
check("a client mid-transition says so instead of dumping the HTTP line",
  events.some((e) => e.type === "skipped" && e.message.includes("客户端正忙")), JSON.stringify(events.filter((e) => e.type === "skipped").map((e) => e.message)));
check("a party-size rejection is explained as a full room",
  events.some((e) => e.type === "skipped" && e.message.includes("房间人数已满")), JSON.stringify(events.filter((e) => e.type === "skipped").map((e) => e.message)));
const p4Attempts = state.joins.p4 ?? 0;
await sleep(400);
check("party-size rooms are parked, not retried every sweep", state.joins.p4 === p4Attempts, `attempts ${p4Attempts} -> ${state.joins.p4}`);
const p2Attempts = state.joins.p2 ?? 0;
await sleep(400);
check("invite-limit rooms are parked, not retried every sweep", state.joins.p2 === p2Attempts, `attempts ${p2Attempts} -> ${state.joins.p2}`);
check("no unhandled errors", events.filter((e) => e.type === "error").length === 0, JSON.stringify(events.filter((e) => e.type === "error").map((e) => e.message)));
controller.stop();

/* ---------- the player floor is a real gate, not decoration ---------- */
// These are controller rules, so the LCU layer is replaced by a hand-written double rather than a fake
// HTTP server.
function floorHarness({ stallTimeoutMs, players, invites = 1, floor = 5, inRoom = false }) {
  const events = [];
  let inLobby = inRoom;
  const provider = {
    leaves: 0,
    async listLobbies() { return [normalize(row("floor-room", 1))]; },
    async refreshLobbyList() {},
    async joinLobby() { inLobby = true; },
    async currentLobby() { return inLobby ? normalize(joined("floor-room", players, invites)) : undefined; },
    async leaveLobby() { this.leaves += 1; inLobby = false; }
  };
  const controller = new SearchController(provider, {
    policy: { ...DEFAULT_POLICY, nameKeywords: ["10钢"], minPlayers: floor, maxInvites: 50, modePolicy: "attempt" },
    stallTimeoutMs,
    emit: (event) => events.push(event),
    intervalMs: 10, maxIntervalMs: 10, sweepIntervalMs: 10, maxSweepIntervalMs: 10,
    attemptGapMs: 0, refreshThrottleMs: 0, exhaustedCooldownMs: 60_000, inviteLimitCooldownMs: 60_000
  });
  return { controller, provider, events };
}

check("the shipped stall timeout is short enough to look deliberate", DEFAULT_SETTINGS.stallTimeoutMs === 30_000, String(DEFAULT_SETTINGS.stallTimeoutMs));

// 0 means "do not wait": the floor becomes a hard gate for a room the tool joined itself.
const hard = floorHarness({ stallTimeoutMs: 0, players: 3 });
await hard.controller.start();
await sleep(250);
check("floor 5 with no waiting leaves a 3-player room at once", hard.provider.leaves >= 1, `leaves=${hard.provider.leaves} state=${hard.controller.state}`);
check("the immediate leave says why", hard.events.some((e) => e.type === "left-stalled-room" && e.message.includes("不等待")), JSON.stringify(hard.events.at(-1)?.message));
hard.controller.stop();

// A waiting room must say so, and say when it will give up.
const waiting = floorHarness({ stallTimeoutMs: 60_000, players: 3 });
await waiting.controller.start();
await sleep(200);
const joinedEvent = waiting.events.find((e) => e.type === "joined");
check("a below-floor room announces the wait instead of looking stuck",
  joinedEvent?.belowFloor === true && joinedEvent?.message?.includes("低于下限"), JSON.stringify(joinedEvent?.message));
check("the wait carries a deadline the UI can show", Number(joinedEvent?.watchDeadlineAt) > Date.now(), String(joinedEvent?.watchDeadlineAt));
check("nothing is left while the wait is still running", waiting.provider.leaves === 0, `leaves=${waiting.provider.leaves}`);
check("the status snapshot carries the wait", waiting.controller.status().belowFloor === true && Number(waiting.controller.status().watchDeadlineAt) > 0);
waiting.controller.stop();
check("stopping clears the wait state", waiting.controller.status().belowFloor === false && waiting.controller.status().watchDeadlineAt === undefined);

// A room that reached the floor is not on the stall clock at all.
const satisfied = floorHarness({ stallTimeoutMs: 150, players: 6 });
await satisfied.controller.start();
await sleep(600);
check("a room that reached the floor is kept indefinitely", satisfied.provider.leaves === 0 && satisfied.controller.status().belowFloor === false, `leaves=${satisfied.provider.leaves} belowFloor=${satisfied.controller.status().belowFloor}`);
satisfied.controller.stop();

// The room the user was already sitting in. The floor now applies to it too - it used to be adopted and
// reported as the finished result forever, which is what made the search look stuck on a 3/10 room.
const adopted = floorHarness({ stallTimeoutMs: 60, players: 3, inRoom: true });
await adopted.controller.start();
check("an adopted below-floor room is reported as waiting, not as the result",
  adopted.events.find((e) => e.type === "joined")?.belowFloor === true,
  JSON.stringify(adopted.events.find((e) => e.type === "joined")?.message));
await sleep(250);
check("an adopted room is never left automatically", adopted.provider.leaves === 0, `leaves=${adopted.provider.leaves}`);
check("the wait ends with an explanation instead of silence",
  adopted.events.some((e) => e.type === "left-stalled-room" && e.message.includes("不会退出你自己所在的房间")),
  JSON.stringify(adopted.events.at(-1)?.message));
check("the search stops after reporting the adopted room",
  adopted.controller.state === "idle" && adopted.controller.status().running === false, adopted.controller.state);
adopted.controller.stop();

// A room the user was already in that already meets the floor is still just adopted.
const adoptedOk = floorHarness({ stallTimeoutMs: 60, players: 8, inRoom: true });
await adoptedOk.controller.start();
await sleep(150);
check("an acceptable adopted room is accepted as the result",
  adoptedOk.controller.state === "joined" && adoptedOk.provider.leaves === 0, adoptedOk.controller.state);
check("an adopted room above the floor is not put on a clock",
  adoptedOk.controller.status().belowFloor === false, String(adoptedOk.controller.status().belowFloor));
adoptedOk.controller.stop();

/* ---------- legacy settings migration ---------- */
const { SettingsStore } = await import(root + "settings.mjs");
const os = await import("node:os");
const fs = await import("node:fs/promises");
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hextech-settings-"));
const writeSettings = (value) => fs.writeFile(path.join(dir, "settings.json"), JSON.stringify(value), "utf8");

await writeSettings({ minPlayers: 5, stallTimeoutMs: 180_000 });
const legacy = SettingsStore.at(dir);
await legacy.load();
check("a stored 180s stall timeout (the old default) moves to the new one", legacy.settings.stallTimeoutMs === 30_000, String(legacy.settings.stallTimeoutMs));

await writeSettings({ stallTimeoutMs: 120_000 });
const chosen = SettingsStore.at(dir);
await chosen.load();
check("a deliberately chosen stall timeout is left alone", chosen.settings.stallTimeoutMs === 120_000, String(chosen.settings.stallTimeoutMs));

await fs.rm(dir, { recursive: true, force: true });

/* ---------- a stalled read is retried once; a write never is ---------- */
const { shouldRetryRequest, slowRequestWarning, TIMEOUT_CODE, TIMEOUT_MESSAGE } = await import(root + "lcu-fetch.mjs");
const stalled = new Error(`${TIMEOUT_MESSAGE}（等待 15000ms，已连接但无响应）`);
stalled.code = TIMEOUT_CODE;
check("a timed-out read is retried", shouldRetryRequest({ method: "GET", error: stalled, attempt: 0 }) === true);
check("a timed-out write is never retried", shouldRetryRequest({ method: "POST", error: stalled, attempt: 0 }) === false);
check("only one retry is allowed", shouldRetryRequest({ method: "GET", error: stalled, attempt: 1 }) === false);
check("a cancelled request is not retried", shouldRetryRequest({ method: "GET", error: stalled, attempt: 0, aborted: true }) === false);
check("a connection reset is not retried", shouldRetryRequest({ method: "GET", error: new Error("ECONNRESET"), attempt: 0 }) === false);
check("a request with no method counts as a read", shouldRetryRequest({ error: stalled, attempt: 0 }) === true);
check("the retry decision uses the error code, not the wording",
  shouldRetryRequest({ method: "GET", error: new Error(TIMEOUT_MESSAGE), attempt: 0 }) === false);

/* ---------- a transient failure must not stick to the UI ---------- */
let failReads = true;
const readProvider = {
  async listLobbies() { if (failReads) throw new Error(TIMEOUT_MESSAGE); return []; },
  async refreshLobbyList() {},
  async joinLobby() {},
  async currentLobby() { return undefined; },
  async leaveLobby() {}
};
const readController = new SearchController(readProvider, {
  policy: { ...DEFAULT_POLICY, nameKeywords: ["10钢"], minPlayers: 4 },
  stallTimeoutMs: 30_000,
  emit: () => {},
  intervalMs: 20, maxIntervalMs: 20, sweepIntervalMs: 20, maxSweepIntervalMs: 20,
  attemptGapMs: 0, refreshThrottleMs: 0
});
await readController.start();
await sleep(120);
check("a failed read is reported", typeof readController.status().lastError === "string", String(readController.status().lastError));
failReads = false;
await sleep(250);
check("the error clears as soon as the client answers again", readController.status().lastError === undefined, String(readController.status().lastError));
readController.stop();

/* ---------- a room that rejects us after joining is parked, not re-joined every sweep ---------- */
const churn = { joins: 0, leaves: 0 };
let churnInLobby = false;
const deadRoom = normalize(joined("dead-room", 2, 50));
const churnProvider = {
  async listLobbies() { return [normalize(row("dead-room", 1))]; },
  async refreshLobbyList() {},
  async joinLobby() { churn.joins += 1; churnInLobby = true; },
  async currentLobby() { return churnInLobby ? deadRoom : undefined; },
  async leaveLobby() { churn.leaves += 1; churnInLobby = false; }
};
const churnEvents = [];
const churnController = new SearchController(churnProvider, {
  policy: { ...DEFAULT_POLICY, nameKeywords: ["10钢"], minPlayers: 4, maxInvites: 50, modePolicy: "attempt" },
  stallTimeoutMs: 30_000,
  emit: (event) => churnEvents.push(event),
  intervalMs: 10, maxIntervalMs: 10, sweepIntervalMs: 10, maxSweepIntervalMs: 10,
  attemptGapMs: 0, refreshThrottleMs: 0, exhaustedCooldownMs: 60_000, inviteLimitCooldownMs: 600_000
});
await churnController.start();
await sleep(700);
churnController.stop();
check("a room whose invite list is already full is left after joining", churn.leaves >= 1, `leaves=${churn.leaves}`);
check("the rejection is explained as an invite-budget failure",
  churnEvents.some((e) => e.type === "rejected-after-join" && e.reason === "invites-exhausted"),
  JSON.stringify(churnEvents.map((e) => e.type)));
check("the dead room is not joined again while the browser still reports it unchanged",
  churn.joins === 1, `joins=${churn.joins}`);

/* ---------- idle connections are not pooled ---------- */
// The LCU closes idle sockets on its own schedule; reusing one that it already closed is what produced
// sporadic timeouts on reads and writes alike.
const fetchSource = await fs.readFile(new URL(root + "lcu-fetch.mjs"), "utf8");
check("the LCU agent does not keep connections alive", /keepAlive: false/.test(fetchSource));
check("no stale keep-alive setting is left behind", !/keepAlive: true/.test(fetchSource));

/* ---------- a failing watch backs off instead of hammering the client ---------- */
let reads = 0;
let failingWatchReads = 0;
const flakyProvider = {
  async listLobbies() { return [normalize(row("flaky-room", 1))]; },
  async refreshLobbyList() {},
  async joinLobby() {},
  async currentLobby() {
    reads += 1;
    if (reads === 1) return undefined;                    // the pre-join check: not in a room yet
    if (reads === 2) return normalize(joined("flaky-room", 6, 1));  // post-join verification
    failingWatchReads += 1;
    throw new Error(TIMEOUT_MESSAGE);
  },
  async leaveLobby() {}
};
const flakyEvents = [];
const flakyController = new SearchController(flakyProvider, {
  policy: { ...DEFAULT_POLICY, nameKeywords: ["10钢"], minPlayers: 4, maxInvites: 50 },
  stallTimeoutMs: 30_000,
  emit: (event) => flakyEvents.push(event),
  intervalMs: 10, maxIntervalMs: 400, sweepIntervalMs: 10, maxSweepIntervalMs: 10,
  attemptGapMs: 0, refreshThrottleMs: 0
});
await flakyController.start();
await sleep(900);
flakyController.stop();
const retries = flakyEvents.filter((e) => e.type === "error").map((e) => e.retryInMs);
check("a failing watch backs off instead of retrying flat out",
  retries.length >= 2 && retries.at(-1) > retries[0], JSON.stringify(retries));
check("the backoff stops at the ceiling", retries.at(-1) === 400, JSON.stringify(retries));
check("a failing watch does not hammer the client", failingWatchReads <= 10, String(failingWatchReads));

/* ---------- a slow request is called out with numbers ---------- */
const slow = slowRequestWarning({ method: "DELETE", path: "/lol-lobby/v2/lobby", elapsedMs: 13_400 });
check("a slow request names the method, path and duration", slow === "LCU 响应慢：DELETE /lol-lobby/v2/lobby 用了 13.4s", String(slow));
check("a quick request is not called out", slowRequestWarning({ method: "GET", path: "/x", elapsedMs: 120 }) === undefined);
check("a request right at the threshold is called out",
  slowRequestWarning({ method: "GET", path: "/x", elapsedMs: 3_000 }) !== undefined);

/* ---------- leaving a room says what it is doing ---------- */
const leaveProvider = {
  async listLobbies() { return []; },
  async refreshLobbyList() {},
  async joinLobby() {},
  async currentLobby() { return normalize(joined("slow-room", 8, 3)); },
  async leaveLobby() { await sleep(80); }
};
const leaveEvents = [];
const leaveController = new SearchController(leaveProvider, {
  policy: { ...DEFAULT_POLICY, nameKeywords: ["10钢"], minPlayers: 4, maxInvites: 50 },
  stallTimeoutMs: 30_000,
  emit: (event) => leaveEvents.push(event),
  intervalMs: 10, maxIntervalMs: 10, sweepIntervalMs: 10, maxSweepIntervalMs: 10,
  attemptGapMs: 0, refreshThrottleMs: 0
});
await leaveController.start();
await sleep(30);
await leaveController.leave();
const leavingIndex = leaveEvents.findIndex((e) => e.type === "leaving");
const leftIndex = leaveEvents.findIndex((e) => e.type === "left");
check("leaving a room is announced before the client answers", leavingIndex >= 0, JSON.stringify(leaveEvents.map((e) => e.type)));
check("the announcement precedes the result", leavingIndex >= 0 && leftIndex > leavingIndex, `leaving=${leavingIndex} left=${leftIndex}`);
check("the leave reports how long the client took", Number(leaveEvents[leftIndex]?.elapsedMs) >= 50, String(leaveEvents[leftIndex]?.elapsedMs));
leaveController.stop();

/* ---------- the list count and the filtered count are different numbers ---------- */
const mixedProvider = {
  async listLobbies() {
    return [
      normalize(row("keep-me", 2)),                        // map 12, keyword match, passwordless
      normalize({ ...row("other-map", 2), mapId: 11 }),    // a different map entirely
      normalize(row("plain-name", 2, "随便玩玩"))           // right map, wrong name
    ];
  },
  async refreshLobbyList() {},
  async joinLobby() {},
  async currentLobby() { return undefined; },
  async leaveLobby() {}
};
const mixedController = new SearchController(mixedProvider, {
  policy: { ...DEFAULT_POLICY, nameKeywords: ["10钢"], minPlayers: 5, maxInvites: 50 },
  stallTimeoutMs: 30_000,
  emit: () => {},
  intervalMs: 20, maxIntervalMs: 20, sweepIntervalMs: 20, maxSweepIntervalMs: 20,
  attemptGapMs: 0, refreshThrottleMs: 0
});
await mixedController.start();
await sleep(60);
const mixedStatus = mixedController.status();
check("the list count is everything the client returned", mixedStatus.candidateCount === 3, String(mixedStatus.candidateCount));
check("the eligible count is only what passed the filters", mixedStatus.eligibleCount === 1, String(mixedStatus.eligibleCount));
mixedController.stop();

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
