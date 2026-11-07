import assert from "node:assert/strict";
import { handleLcuEvent } from "../src/lcu-events.mjs";

const calls = [];
const controller = {
  acceptLobbyListPush: (rows) => { calls.push({ type: "list", rows }); return true; },
  acceptLobbyPush: (lobby) => { calls.push({ type: "lobby", lobby }); return true; }
};
const root = "/lol-lobby/v1/custom-games";
const raw = { partyId: "p-1", id: 42, lobbyName: "10钢", mapId: 12,
  filledPlayerSlots: 7, maxPlayerSlots: 10, hasPassword: false, gameType: "CUSTOM_GAME" };

handleLcuEvent(controller, { uri: root, eventType: "Update", data: [raw] });
assert.equal(calls[0].rows[0].id, "p-1", "joining must keep using partyId");
assert.equal(calls[0].rows[0].playerCount, 7);
assert.equal(calls[0].rows[0].browserId, 42, "numeric browser id must survive separately");
assert.equal(calls[0].rows[0].gameType, "CUSTOM_GAME");
assert.equal(calls[0].rows[0].gameMode, undefined, "gameType must not become gameMode");

handleLcuEvent(controller, { uri: `${root}/42`, eventType: "Delete" });
assert.equal(calls.at(-1).type, "list");
assert.equal(calls.at(-1).rows, undefined, "child events invalidate, never replace the entire list");

handleLcuEvent(controller, { uri: root, eventType: "Update", data: { games: [raw] } });
assert.equal(calls.at(-1).rows[0].id, "p-1");
handleLcuEvent(controller, { uri: root, eventType: "Update", data: [null, {}] });
assert.equal(calls.at(-1).rows, undefined, "malformed snapshots fall back to a list read");
handleLcuEvent(controller, { uri: root, eventType: "Update", data: [] });
assert.deepEqual(calls.at(-1).rows, [], "an empty complete snapshot is meaningful");

const before = calls.length;
handleLcuEvent(controller, { uri: `${root}/refresh`, eventType: "Update" });
handleLcuEvent(controller, { uri: "/lol-chat/v1/conversations", data: [] });
handleLcuEvent(controller, { uri: "/lol-lobby/v2/lobby", data: {} });
handleLcuEvent(undefined, { uri: root, data: [raw] });
assert.equal(calls.length, before, "unrelated or malformed events must not steer the controller");

handleLcuEvent(controller, { uri: "/lol-lobby/v2/lobby", eventType: "Update", data: {
  partyId: "p-1", gameConfig: { mapId: 12, gameMode: "KIWI", maxLobbySize: 10 },
  members: [{ summonerId: 1 }, { summonerId: 2 }], invitations: []
} });
assert.equal(calls.at(-1).lobby.playerCount, 2);
assert.equal(calls.at(-1).lobby.gameMode, "KIWI");
handleLcuEvent(controller, { uri: "/lol-lobby/v2/lobby", eventType: "Delete" });
assert.equal(calls.at(-1).type, "lobby");
assert.equal(calls.at(-1).lobby, undefined);
console.log("PASS LCU event routing: snapshots, child invalidation, malformed events, lobby updates");
