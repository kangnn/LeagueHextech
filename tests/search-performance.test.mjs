import assert from "node:assert/strict";
import { SearchController } from "../src/search-controller.mjs";
import { DEFAULT_POLICY } from "../src/eligibility.mjs";
import { LcuCustomLobbyProvider } from "../src/lcu-provider.mjs";
import { handleLcuEvent } from "../src/lcu-events.mjs";

// Virtual time exercises real controller scheduling without wall-clock sleeps or a game client.
const tests = [];
const test = (name, run) => tests.push({ name, run });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const row = (id, players = 7, extra = {}) => ({ id, name: "10钢", mapId: 12,
  maxHumanPlayers: 10, playerCount: players, requiresPassword: false, joinable: true, ...extra });
const room = (id, players = 7, extra = {}) => row(id, players,
  { joined: true, gameMode: "KIWI", inviteCount: 1, ...extra });
const policy = { ...DEFAULT_POLICY, minPlayers: 8, nameKeywords: ["10钢"] };

async function withClock(run) {
  const original = { setTimeout, clearTimeout };
  let now = 0;
  let id = 0;
  const timers = new Map();
  const controllers = [];
  const errors = [];
  globalThis.setTimeout = (fn, ms = 0) => {
    timers.set(++id, { fn, at: now + Math.max(0, ms) });
    return id;
  };
  globalThis.clearTimeout = (key) => timers.delete(key);
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  const clock = {
    now: () => now,
    async advance(ms) {
      const target = now + ms;
      let steps = 0;
      await flush();
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        assert.ok(++steps < 1000, "timer loop must stay bounded");
        timers.delete(next[0]);
        now = next[1].at;
        Promise.resolve(next[1].fn()).catch((error) => errors.push(error));
        await flush();
      }
      now = target;
      await flush();
      assert.deepEqual(errors, [], "timer callbacks must not reject");
    },
    flush,
    controller(provider, options = {}) {
      const controller = new SearchController(provider, {
        policy, intervalMs: 500, pushDebounceMs: 50, clock: () => now, ...options
      });
      controllers.push(controller);
      return controller;
    }
  };
  try { await run(clock); }
  finally {
    controllers.forEach((controller) => controller.stop());
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
  }
}

test("one slow refresh stays single-flight across exhausted sweeps", async (clock) => {
  let refreshes = 0;
  const gate = deferred();
  const controller = clock.controller({
    currentLobby: async () => undefined,
    listLobbies: async () => [row("dead")],
    joinLobby: async () => { throw Object.assign(new Error("PARTY_SIZE_LIMIT"), { skip: true }); },
    refreshLobbyList: async () => { refreshes++; await gate.promise; }
  }, { refreshThrottleMs: 10000 });
  await controller.start();
  await clock.advance(9000);
  assert.equal(refreshes, 1, "unanswered refresh must not queue more POSTs");
  gate.resolve();
  await clock.flush();
  await clock.advance(12000);
  assert.equal(refreshes, 2, "refresh may resume after completing and cooling down");
});

test("zero wait leaves a small room during verification and tries the next candidate", async (clock) => {
  let inside;
  let leaves = 0;
  let reads = 0;
  const joins = [];
  const controller = clock.controller({
    currentLobby: async () => inside,
    listLobbies: async () => { reads++; return [row("small", 9), row("good", 8)]; },
    joinLobby: async (id) => { joins.push([id, clock.now()]); inside = room(id, id === "small" ? 3 : 8); },
    leaveLobby: async () => { leaves++; inside = undefined; }
  }, { stallTimeoutMs: 0, attemptGapMs: 0 });
  controller.watchPushConnected = true;
  await controller.start();
  assert.equal(leaves, 1, "zero wait must not wait for the 15s WebSocket backstop");
  assert.deepEqual(joins, [["small", 0], ["good", 0]]);
  assert.equal(reads, 1, "the next candidate should reuse the current sweep");
  assert.match(controller.status().selectedSummary, /good/);
});

test("a silent WebSocket cannot postpone the room's stall deadline", async (clock) => {
  let inside;
  let leftAt;
  const controller = clock.controller({
    currentLobby: async () => inside,
    listLobbies: async () => [row("slow")],
    joinLobby: async () => { inside = room("slow", 3); },
    leaveLobby: async () => { leftAt = clock.now(); inside = undefined; }
  }, { stallTimeoutMs: 2000 });
  controller.watchPushConnected = true;
  await controller.start();
  await clock.advance(1999);
  assert.equal(leftAt, undefined);
  await clock.advance(1);
  assert.equal(leftAt, 2000, "deadline must beat the 15s backstop");
});

test("wrong-mode verification advances without a second list read or poll delay", async (clock) => {
  let inside;
  let reads = 0;
  const joins = [];
  const controller = clock.controller({
    currentLobby: async () => inside,
    listLobbies: async () => { reads++; return [row("wrong", 9), row("good", 8)]; },
    joinLobby: async (id) => { joins.push(id); inside = room(id, 8, { gameMode: id === "wrong" ? "CLASSIC" : "KIWI" }); },
    leaveLobby: async () => { inside = undefined; }
  }, { attemptGapMs: 0 });
  await controller.start();
  assert.deepEqual(joins, ["wrong", "good"]);
  assert.equal(reads, 1);
});

test("a new list push wakes an exhausted sweep and consumes its snapshot", async (clock) => {
  let inside;
  let reads = 0;
  const joins = [];
  const controller = clock.controller({
    currentLobby: async () => inside,
    listLobbies: async () => { reads++; return [row("dead")]; },
    joinLobby: async (id) => {
      joins.push(id);
      if (id === "dead") throw Object.assign(new Error("PARTY_SIZE_LIMIT"), { skip: true });
      inside = room(id, 8);
    }
  });
  await controller.start();
  assert.equal(controller.acceptLobbyListPush([row("new", 8)]), true);
  await clock.advance(50);
  assert.deepEqual(joins, ["dead", "new"]);
  assert.equal(reads, 1, "a complete push snapshot needs no redundant list GET");
  assert.equal(controller.state, "joined");
});

test("list event bursts cannot overlap a pending list request or duplicate a join", async (clock) => {
  const gate = deferred();
  let reads = 0;
  let inside;
  const joins = [];
  const controller = clock.controller({
    currentLobby: async () => inside,
    listLobbies: async () => { reads++; return gate.promise; },
    joinLobby: async (id) => { joins.push(id); inside = room(id, 8); }
  });
  const start = controller.start();
  await clock.flush();
  for (let n = 0; n < 20; n++) controller.acceptLobbyListPush([row("fresh", 8)]);
  await clock.advance(50);
  assert.equal(reads, 1);
  assert.deepEqual(joins, []);
  gate.resolve([]);
  await start;
  await clock.advance(50);
  assert.deepEqual(joins, ["fresh"]);
});

test("an unchanged list push cannot hammer a refused room", async (clock) => {
  let attempts = 0;
  const controller = clock.controller({
    currentLobby: async () => undefined,
    listLobbies: async () => [row("busy")],
    joinLobby: async () => { attempts++; throw Object.assign(new Error("INVALID_WHILE_PARTY_IN_ACTION"), { skip: true }); }
  });
  await controller.start();
  for (let n = 0; n < 10; n++) {
    controller.acceptLobbyListPush([row("busy")]);
    await clock.advance(50);
  }
  assert.equal(attempts, 1, "identical snapshots must preserve the retry backoff");
});

test("watch pushes and fallback polling cannot issue duplicate leave requests", async (clock) => {
  let inside;
  let leaves = 0;
  const gate = deferred();
  const controller = clock.controller({
    currentLobby: async () => inside,
    listLobbies: async () => [row("room")],
    joinLobby: async () => { inside = room("room", 3); },
    leaveLobby: async () => { leaves++; await gate.promise; inside = undefined; }
  }, { stallTimeoutMs: 500 });
  await controller.start();
  await clock.advance(1000);
  controller.acceptLobbyPush(room("room", 3));
  await clock.advance(50);
  assert.equal(leaves, 1);
  gate.resolve();
  await clock.flush();
});

test("stopping discards a queued list push", async (clock) => {
  const joins = [];
  const controller = clock.controller({
    currentLobby: async () => undefined,
    listLobbies: async () => [],
    joinLobby: async (id) => { joins.push(id); }
  });
  await controller.start();
  controller.acceptLobbyListPush([row("fresh")]);
  controller.stop();
  await clock.advance(1000);
  assert.deepEqual(joins, []);
  assert.equal(controller.acceptLobbyListPush([row("fresh")]), false);
});

test("the latest list push can retract a candidate before its debounce ends", async (clock) => {
  const joins = [];
  const controller = clock.controller({
    currentLobby: async () => undefined, listLobbies: async () => [],
    joinLobby: async (id) => { joins.push(id); }
  });
  await controller.start();
  controller.acceptLobbyListPush([row("already-gone")]);
  controller.acceptLobbyListPush([]);
  await clock.advance(50);
  assert.deepEqual(joins, [], "the newest empty snapshot supersedes the earlier candidate");
});

test("growth pushed during a slow watch GET prevents leaving on its stale response", async (clock) => {
  let reads = 0;
  let leaves = 0;
  let inside;
  const gate = deferred();
  const controller = clock.controller({
    listLobbies: async () => [row("room")],
    joinLobby: async () => { inside = room("room", 3); },
    currentLobby: async () => (++reads === 3 ? gate.promise : inside),
    leaveLobby: async () => { leaves++; inside = undefined; }
  }, { stallTimeoutMs: 1000 });
  await controller.start();
  await clock.advance(1000);
  controller.acceptLobbyPush(room("room", 8));
  gate.resolve(room("room", 3));
  await clock.flush();
  assert.equal(leaves, 0, "an accepted growth push must beat an older in-flight GET");
  await clock.advance(50);
  assert.equal(controller.status().belowFloor, false);
});

test("room growth extends the deadline and duplicate pushes cannot extend it again", async (clock) => {
  let inside;
  let leftAt;
  const controller = clock.controller({
    currentLobby: async () => inside, listLobbies: async () => [row("room")],
    joinLobby: async () => { inside = room("room", 3); },
    leaveLobby: async () => { leftAt = clock.now(); inside = undefined; }
  }, { stallTimeoutMs: 2000, pushDebounceMs: 0 });
  controller.watchPushConnected = true;
  await controller.start();
  await clock.advance(1000);
  inside = room("room", 4);
  controller.acceptLobbyPush(inside);
  await clock.advance(0);
  assert.equal(controller.status().watchDeadlineAt, 3000);
  await clock.advance(500);
  controller.acceptLobbyPush(inside);
  await clock.advance(0);
  assert.equal(controller.status().watchDeadlineAt, 3000);
  await clock.advance(1500);
  assert.equal(leftAt, 3000);
});

test("a stopped session cannot overwrite the next session when its list GET completes", async (clock) => {
  const old = deferred();
  let reads = 0;
  let inside;
  const joins = [];
  const controller = clock.controller({
    currentLobby: async () => inside,
    listLobbies: async () => (++reads === 1 ? old.promise : [row("new", 8)]),
    joinLobby: async (id) => { joins.push(id); inside = room(id, 8); }
  });
  const first = controller.start();
  await clock.flush();
  controller.stop();
  await controller.start();
  old.resolve([row("old", 9)]);
  await first;
  await clock.advance(1000);
  assert.deepEqual(joins, ["new"]);
  assert.match(controller.status().selectedSummary, /new/);
  assert.equal(controller.status().candidateCount, 1);
});

test("an adopted room with zero wait is reported immediately and never left", async (clock) => {
  let leaves = 0;
  const controller = clock.controller({
    currentLobby: async () => room("mine", 3),
    leaveLobby: async () => { leaves++; }
  }, { stallTimeoutMs: 0 });
  controller.watchPushConnected = true;
  await controller.start();
  assert.equal(controller.running, false);
  assert.equal(leaves, 0);
});

test("deadline read failures back off instead of running a zero-delay retry loop", async (clock) => {
  let reads = 0;
  let inside;
  const controller = clock.controller({
    listLobbies: async () => [row("room")],
    joinLobby: async () => { inside = room("room", 3); },
    currentLobby: async () => {
      reads++;
      if (reads > 2) throw new Error("client temporarily unavailable");
      return inside;
    }
  }, { stallTimeoutMs: 1000 });
  await controller.start();
  await clock.advance(10000);
  assert.ok(reads <= 6, `failed watch must remain bounded, got ${reads} reads`);
  assert.match(controller.status().lastError, /unavailable/);
});

test("failure retry backoff does not stop browser polling at the user's cadence", async (clock) => {
  let rows = [row("dead")];
  let reads = 0;
  let inside;
  const joins = [];
  const controller = clock.controller({
    currentLobby: async () => inside,
    listLobbies: async () => { reads++; return rows; },
    joinLobby: async (id) => {
      joins.push([id, clock.now()]);
      if (id === "dead") throw Object.assign(new Error("PARTY_SIZE_LIMIT"), { skip: true });
      inside = room(id, 8);
    }
  });
  await controller.start();
  await clock.advance(9000);
  assert.equal(reads, 19, "a 500ms preference still polls while failed rooms cool down");
  assert.equal(joins.length, 1, "browser polling must not retry parked rooms");
  rows = [row("new", 8)];
  await clock.advance(500);
  assert.deepEqual(joins.at(-1), ["new", 9500]);
});

test("a fresh list push supersedes a stale GET before selecting its candidate", async (clock) => {
  const gate = deferred();
  let inside;
  const joins = [];
  const controller = clock.controller({
    currentLobby: async () => inside,
    listLobbies: async () => gate.promise,
    joinLobby: async (id) => { joins.push(id); inside = room(id, 8); }
  });
  const start = controller.start();
  await clock.flush();
  controller.acceptLobbyListPush([row("fresh", 8)]);
  gate.resolve([row("obsolete", 9)]);
  await start;
  await clock.advance(50);
  assert.deepEqual(joins, ["fresh"]);
});

test("child deletion invalidates an in-flight GET before selecting stale room", async (clock) => {
  const gate = deferred(); let reads=0; const joins=[]; let inside;
  const controller=clock.controller({
    currentLobby:async()=>inside,
    listLobbies:async()=> (++reads===1 ? gate.promise : []),
    joinLobby:async(id)=>{joins.push(id);inside=room(id,8);}
  });
  const start=controller.start(); await clock.flush();
  controller.acceptLobbyListPush(); // /custom-games/42 Delete arrived during GET
  gate.resolve([row("deleted",8)]); await start; await clock.advance(50);
  assert.equal(reads, 2, "the invalidated response requires a fresh GET");
  assert.deepEqual(joins,[],"must re-read after invalidation instead of joining deleted row");
});

test("unrelated ineligible row churn must not bypass failed room retry backoff",async(clock)=>{
 let attempts=[]; let n=0;
 const controller=clock.controller({currentLobby:async()=>undefined,
 listLobbies:async()=>[row("busy",8),row("other", (++n%2)+1,{mapId:11})],
 joinLobby:async()=>{attempts.push(clock.now());throw Object.assign(new Error("INVALID_WHILE_PARTY_IN_ACTION"),{skip:true});}
 });
 await controller.start();await clock.advance(2000);
 assert.equal(attempts.length,1,"unchanged busy candidate should retain 3s retry backoff");
});


test("parked candidate must not starve retries of a busy candidate", async(clock)=>{
 const attempts=[];
 const controller=clock.controller({currentLobby:async()=>undefined,
 listLobbies:async()=>[row("busy",8),row("parked",7)],
 joinLobby:async(id)=>{attempts.push([id,clock.now()]);throw Object.assign(new Error(id==="parked"?"PARTY_SIZE_LIMIT":"INVALID_WHILE_PARTY_IN_ACTION"),{skip:true});}
 },{attemptGapMs:0});
 await controller.start(); await clock.advance(30000);
 assert.ok(controller.status().sweepCount <= 5, "parked rooms must not repeatedly extend retry deadlines");
 assert.ok(attempts.filter(([id])=>id==="busy").length>=3,"busy room must be retried again within 30s, despite parked neighbor");
});

test("raw LCU events and provider requests join by party id and verify real membership", async (clock) => {
  const requests = [];
  let inside;
  const provider = new LcuCustomLobbyProvider({
    credentials: () => ({ port: 2999, token: "test-token" }),
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      requests.push(`${options.method} ${path}`);
      const reply = (body, status = 200) => ({ ok: true, status, json: async () => body });
      if (path.endsWith("/refresh")) return reply(undefined, 204);
      if (path === "/lol-lobby/v1/custom-games") return reply([]);
      if (path.endsWith("/join")) {
        inside = path.includes("party-small") ? "party-small" : "party-good";
        return reply(undefined, 204);
      }
      if (path === "/lol-lobby/v2/lobby") {
        if (options.method === "DELETE") { inside = undefined; return reply(undefined, 204); }
        return reply(inside ? {
          partyId: inside, gameConfig: { mapId: 12, gameMode: "KIWI", maxLobbySize: 14 },
          members: Array.from({ length: inside === "party-small" ? 3 : 8 }, () => ({})), invitations: []
        } : undefined, inside ? 200 : 204);
      }
      throw new Error(`unexpected request: ${options.method} ${path}`);
    }
  });
  const controller = clock.controller(provider, { stallTimeoutMs: 0, attemptGapMs: 0 });
  await controller.start();
  const rawRow = (id, partyId, filledPlayerSlots) => ({
    id, partyId, filledPlayerSlots, lobbyName: "10钢", mapId: 12, maxPlayerSlots: 10, hasPassword: false
  });
  assert.equal(handleLcuEvent(controller, {
    uri: "/lol-lobby/v1/custom-games", eventType: "Update",
    data: [rawRow(42, "party-small", 9), rawRow(43, "party-good", 8)]
  }), true);
  await clock.advance(50);
  assert.equal(controller.state, "joined");
  assert.equal(controller.status().belowFloor, false);
  assert.equal(requests.filter((request) => request === "GET /lol-lobby/v1/custom-games").length, 1);
  assert.deepEqual(requests.filter((request) => /\/join$/.test(request) || request.startsWith("DELETE")), [
    "POST /lol-lobby/v2/party/party-small/join", "DELETE /lol-lobby/v2/lobby",
    "POST /lol-lobby/v2/party/party-good/join"
  ]);
});

let failures = 0;
for (const { name, run } of tests) {
  try { await withClock(run); console.log("PASS", name); }
  catch (error) { failures++; console.error("FAIL", name, "\n ", error.message); }
}
console.log(`${tests.length - failures}/${tests.length} search performance tests passed`);
process.exitCode = failures ? 1 : 0;
