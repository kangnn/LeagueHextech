import { normalize } from "./lcu-provider.mjs";

const LIST_URI = "/lol-lobby/v1/custom-games";
const LOBBY_URIS = new Set(["/lol-lobby/v2/lobby", "/lol-lobby/v1/lobby"]);
const validId = (id) => (typeof id === "string" && id.length > 0) || Number.isFinite(id);

/** Routes client events at the API boundary; unknown payloads fall back to a fresh list GET. */
export function handleLcuEvent(controller, { uri, eventType, data } = {}) {
  if (!controller || typeof uri !== "string") return false;
  if (uri === LIST_URI) {
    const rows = Array.isArray(data) ? data : data?.games ?? data?.lobbies;
    if (eventType !== "Delete" && Array.isArray(rows) && rows.every((row) =>
      row && typeof row === "object" && validId(row.partyId ?? row.id))) {
      return controller.acceptLobbyListPush(rows.map(normalize));
    }
    return controller.acceptLobbyListPush();
  }
  if (uri.startsWith(`${LIST_URI}/`)) {
    const suffix = uri.slice(LIST_URI.length + 1);
    if (suffix && suffix !== "refresh" && !suffix.includes("/")) return controller.acceptLobbyListPush();
    return false;
  }
  if (!LOBBY_URIS.has(uri)) return false;
  if (eventType === "Delete" || data === null || data === undefined) return controller.acceptLobbyPush(undefined);
  if (typeof data !== "object" || Array.isArray(data) || !validId(data.partyId ?? data.id ?? data.gameConfig?.partyId)) return false;
  return controller.acceptLobbyPush(normalize(data));
}
