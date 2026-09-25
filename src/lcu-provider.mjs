import { discoverLcuConnection, parseCommandLine, parseLockfile } from "./lcu-discovery.mjs";

export { parseCommandLine, parseLockfile };

const SESSION_LOST = "League Client 会话已失效，请确认客户端已登录后重试。";
const UNSUPPORTED = "当前 League Client 版本未提供可用的公开自定义房间列表接口。";

/** Error flags drive the search state machine: fatal stops, skip advances, plain retries with backoff. */
function lcuError(message, { status = 0, skip = false, fatal = false } = {}) {
  const error = new Error(message);
  error.status = status;
  error.skip = skip;
  error.fatal = fatal;
  return error;
}

/**
 * Surfaces the client's own error code so a rejection is diagnosable instead of just "HTTP 400",
 * and so the caller can tell "this room is full" from "this party cannot take anyone at all".
 */
async function describeRejection(response) {
  try {
    const text = await response.text?.();
    if (!text) return { errorCode: undefined, detail: "" };
    const parsed = JSON.parse(text);
    const errorCode = typeof parsed.errorCode === "string" ? parsed.errorCode : undefined;
    const detail = [parsed.errorCode, parsed.message].filter(Boolean).join("：");
    return { errorCode, detail: detail ? ` ${detail}` : "" };
  } catch {
    return { errorCode: undefined, detail: "" };
  }
}

function normalizeBrowserRow(raw) {
  return {
    id: String(raw.partyId ?? raw.id),
    name: raw.lobbyName ?? raw.name,
    mapId: raw.mapId,
    // The browser exposes slot counts; a 10-slot ARAM room is the 5v5 variant.
    teamSize: raw.teamSize ?? (raw.maxPlayerSlots === 10 ? 5 : undefined),
    maxHumanPlayers: raw.maxPlayerSlots ?? raw.maxHumanPlayers,
    playerCount: Number(raw.filledPlayerSlots ?? raw.playerCount ?? 0),
    requiresPassword: raw.hasPassword === false ? false : raw.hasPassword === true ? true : undefined,
    joinable: raw.filledPlayerSlots === undefined || raw.maxPlayerSlots === undefined
      ? true
      : Number(raw.filledPlayerSlots) < Number(raw.maxPlayerSlots),
    createdAt: raw.createdAt ?? raw.creationDate,
    gameMode: undefined,
    gameMutator: undefined,
    displayName: undefined
  };
}

/** A joined lobby reports its mode through `gameConfig`, which is what mode verification reads. */
/**
 * A joined lobby lists every invitation it ever sent, declined and accepted ones included. That
 * total is what the client displays and what the client caps at 50, so it is the number to compare
 * against the invite budget. `pendingInviteCount` is the subset still waiting for an answer.
 */
function countInvitations(invitations) {
  if (!Array.isArray(invitations)) return { inviteCount: undefined, pendingInviteCount: undefined };
  return {
    inviteCount: invitations.length,
    pendingInviteCount: invitations.filter((invitation) =>
      String(invitation?.state ?? "").toLowerCase() === "pending").length
  };
}

function normalizeJoinedLobby(raw) {
  const config = raw.gameConfig ?? raw.configuration ?? {};
  const players = raw.members ?? raw.participants ?? [];
  const passwordFlag = raw.hasPassword ?? config.passwordRequired ?? config.hasPassword;
  // A joined lobby reports its limit through `maxLobbySize`; `maxHumanPlayers` is 0 there.
  const maxHumanPlayers = Number(config.maxHumanPlayers) > 0
    ? Number(config.maxHumanPlayers)
    : config.maxLobbySize;
  return {
    id: String(raw.partyId ?? raw.id ?? config.partyId),
    name: raw.lobbyName ?? config.customLobbyName ?? raw.name,
    mapId: config.mapId ?? raw.mapId,
    teamSize: config.teamSize ?? config.maxTeamSize ?? config.numPlayersPerTeam ?? raw.teamSize,
    maxHumanPlayers,
    playerCount: Number(players.length || config.playerCount || 0),
    requiresPassword: passwordFlag === undefined ? undefined : passwordFlag === true,
    joinable: true,
    // Membership is proof the password gate no longer applies, so verification must not reject on it.
    joined: true,
    // Only a joined lobby reports invitations; browser rows carry no invite data at all.
    ...countInvitations(raw.invitations),
    createdAt: raw.createdAt ?? raw.creationDate,
    gameMode: config.gameMode,
    gameMutator: config.gameMutator ?? config.customMutatorName ?? config.mutator,
    displayName: config.gameModeDisplayName ?? raw.gameModeDisplayName
  };
}

export function normalize(raw) {
  return "filledPlayerSlots" in raw || "hasPassword" in raw
    ? normalizeBrowserRow(raw)
    : normalizeJoinedLobby(raw);
}

export class LcuCustomLobbyProvider {
  constructor({ fetchImpl = fetch, credentials } = {}) {
    this.fetchImpl = fetchImpl;
    this.credentials = credentials ?? (() => discoverLcuConnection());
    this.connection = undefined;
    // Tencent/CN clients serve the v1 browser; the v2 variants are kept for other builds.
    this.listPaths = ["/lol-lobby/v1/custom-games", "/lol-lobby/v2/custom-games"];
    // Asks the client to re-scan its public browser instead of serving a cached list.
    this.refreshPaths = ["/lol-lobby/v1/custom-games/refresh", "/lol-lobby/v2/custom-games/refresh"];
    // The CN client only supports joining by party id; the v1 route takes an unusable numeric id.
    this.joinPaths = ["/lol-lobby/v2/party/{id}/join", "/lol-lobby/v1/custom-games/{id}/join"];
    this.lobbyPaths = ["/lol-lobby/v2/lobby", "/lol-lobby/v1/lobby"];
  }

  /** Drops cached credentials so the next call re-discovers them after a client restart. */
  invalidate() {
    this.connection = undefined;
  }

  async #connect() {
    if (this.connection) return this.connection;
    try {
      this.connection = await this.credentials();
    } catch (error) {
      throw lcuError(error instanceof Error ? error.message : String(error), { fatal: error?.fatal ?? true });
    }
    return this.connection;
  }

  async #request(pathname, { method = "GET", signal } = {}) {
    const { port, token, protocol = "https" } = await this.#connect();
    const authorization = `Basic ${Buffer.from(`riot:${token}`).toString("base64")}`;
    let response;
    try {
      response = await this.fetchImpl(`${protocol}://127.0.0.1:${port}${pathname}`, {
        method,
        signal,
        headers: { Authorization: authorization, "Content-Type": "application/json" }
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      this.invalidate();
      throw lcuError(`无法连接 League Client（${method} ${pathname}）：${error instanceof Error ? error.message : error}`);
    }
    if (response.ok) return response.status === 204 ? undefined : response.json();

    const status = response.status;
    if (status === 401 || status === 403) {
      this.invalidate();
      throw lcuError(SESSION_LOST, { status, fatal: true });
    }
    const rejection = await describeRejection(response);
    const error = lcuError(`LCU 请求被拒绝（${method} ${pathname}，HTTP ${status}）${rejection.detail}`, { status });
    error.errorCode = rejection.errorCode;
    throw error;
  }

  async listLobbies({ signal } = {}) {
    for (const pathname of this.listPaths) {
      try {
        const data = await this.#request(pathname, { signal });
        const rows = Array.isArray(data) ? data : data?.games ?? data?.lobbies ?? [];
        return rows.map(normalize);
      } catch (error) {
        // A missing endpoint on this client build is not an actionable search failure.
        if (error?.status === 404) continue;
        throw error;
      }
    }
    throw lcuError(UNSUPPORTED, { status: 404, fatal: true });
  }

  /**
   * Best-effort forced re-scan of the public browser. Returns false when this client build does
   * not expose the endpoint, in which case the caller keeps using the list it already has.
   */
  async refreshLobbyList({ signal } = {}) {
    for (const pathname of this.refreshPaths) {
      try {
        await this.#request(pathname, { method: "POST", signal });
        return true;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error?.status === 404) continue;
        return false;
      }
    }
    return false;
  }

  async joinLobby(id, { signal } = {}) {
    let lastStatus = 0;
    for (const template of this.joinPaths) {
      const pathname = template.replace("{id}", encodeURIComponent(id));
      try {
        await this.#request(pathname, { method: "POST", signal });
        return pathname;
      } catch (error) {
        if (error?.fatal || error?.skip) throw error;
        if (error?.status === 404) {
          lastStatus = 404;
          continue;
        }
        const status = error?.status ?? 0;
        // Rejections mean this specific room is not joinable; remember it and move on.
        const rejection = lcuError(error.message, { status, skip: status > 0 && status < 500 });
        rejection.errorCode = error?.errorCode;
        throw rejection;
      }
    }
    throw lcuError(`未找到可用的加入房间接口（HTTP ${lastStatus}）。`, { status: lastStatus });
  }

  /** Returns undefined when the client is simply not in a lobby, which is not an error. */
  async currentLobby({ signal } = {}) {
    for (const pathname of this.lobbyPaths) {
      try {
        const data = await this.#request(pathname, { signal });
        if (!data) return undefined;
        return normalize(data);
      } catch (error) {
        if (error?.status === 404) continue;
        throw error;
      }
    }
    return undefined;
  }

  async leaveLobby({ signal } = {}) {
    for (const pathname of this.lobbyPaths) {
      try {
        await this.#request(pathname, { method: "DELETE", signal });
        return;
      } catch (error) {
        if (error?.status === 404) continue;
        throw error;
      }
    }
    // Already gone: not an actionable failure.
  }
}
