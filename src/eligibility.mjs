/**
 * Candidate shape produced by the provider from either the public custom-game browser
 * (`partyId`, `filledPlayerSlots`, `hasPassword`, `mapId`, ...) or a joined lobby
 * (`gameConfig.gameMode`, `gameMutator`, ...).
 *
 * @typedef {object} Lobby
 * @property {string} id join key: `partyId` for browser rows, `partyId`/`id` for a joined lobby
 * @property {string} [name]
 * @property {number} [mapId]
 * @property {number} [teamSize]
 * @property {number} [maxHumanPlayers]
 * @property {boolean} [spectatorsAllowed] spectator gate of a joined lobby; undefined when the client reports none
 * @property {number} [maxSpectators] spectator seats the client reserves (4 for a 5v5 custom)
 * @property {number} [spectatorCount] spectators currently in a joined lobby
 * @property {number} playerCount
 * @property {number} [inviteCount] every invitation record of a joined lobby; the client caps it at 50
 * @property {number} [pendingInviteCount] how many of those are still waiting for an answer
 * @property {boolean|undefined} requiresPassword
 * @property {boolean} joinable
 * @property {string|number} [createdAt]
 * @property {string} [gameMode]
 * @property {string} [gameMutator]
 * @property {string} [displayName]
 */

export const ARAM_MAP_IDS = Object.freeze([12]);

export const DEFAULT_POLICY = Object.freeze({
  mapIds: ARAM_MAP_IDS,
  teamSize: 5,
  maxHumanPlayers: 10,
  // A room below this population is not entered at all: it may never fill, and the room browser
  // offers no way to tell a freshly created room from an abandoned one.
  minPlayers: 5,
  // The client caps a lobby's invitation list at 50 entries, declined and accepted ones included.
  // A room that has spent that budget while still below the player floor will not fill.
  maxInvites: 50,
  // Public rooms of this mode are conventionally named with markers such as `10钢`,
  // so a name keyword filter is the only pre-join signal the CN browser exposes.
  nameKeywords: Object.freeze([])
});

function modeText(lobby) {
  return [lobby.gameMode, lobby.gameMutator, lobby.displayName]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

/** The CN client reports ARAM: Mayhem (海克斯大乱斗/海克斯乱斗) as game mode `KIWI`. */
export function isMayhemAram(lobby) {
  const text = modeText(lobby);
  if (!text) return false;
  if (/\bkiwi\b/.test(text)) return true;
  if (text.includes("海克斯")) return true;
  return text.includes("mayhem") || text.includes("hextech");
}

export function hasKnownMode(lobby) {
  return Boolean(lobby.gameMode || lobby.gameMutator || lobby.displayName);
}

export function matchesNameKeywords(lobby, keywords = []) {
  if (!keywords || keywords.length === 0) return true;
  const name = String(lobby.name ?? "");
  return keywords.some((keyword) => name.includes(keyword));
}

/**
 * A room that has spent its whole invite budget while still sitting below the player floor will not
 * fill, so it is abandoned. Only a joined lobby reports invitations, so this never fires before
 * joining.
 */
export function isInviteBudgetExhausted(lobby, policy = DEFAULT_POLICY) {
  const cap = Number(policy.maxInvites);
  return cap > 0 && Number(lobby.inviteCount) >= cap && Number(lobby.playerCount) < Number(policy.minPlayers);
}

export function evaluateLobby(lobby, policy = DEFAULT_POLICY) {
  if (!policy.mapIds.includes(lobby.mapId)) return { eligible: false, reason: "not-target-map" };
  if (lobby.maxHumanPlayers !== policy.maxHumanPlayers) return { eligible: false, reason: "not-5v5" };
  // Undefined is deliberately rejected for candidates: an unknown password state is not safe to
  // join. An already joined lobby is exempt because membership proves the gate was passed.
  if (lobby.requiresPassword !== false && !lobby.joined) return { eligible: false, reason: "password-or-unknown" };
  if (!lobby.joinable) return { eligible: false, reason: "not-joinable" };
  if (lobby.playerCount >= policy.maxHumanPlayers) return { eligible: false, reason: "full" };

  const keywordFiltered = (policy.nameKeywords ?? []).length > 0;
  if (keywordFiltered && !matchesNameKeywords(lobby, policy.nameKeywords)) {
    return { eligible: false, reason: "name-mismatch" };
  }

  // The slot count is deliberately not a gate here. It is a snapshot of a room that is filling up
  // right now, and the rooms this tool targets sit at 1/10 until their invitations are accepted, so
  // filtering on it would reject exactly the rooms worth entering. It is still useful for ranking
  // and for "full". The player floor is applied after joining, where the real member list is
  // readable - see `evaluateJoinedLobby` and the watch rules in the search controller.
  if (isInviteBudgetExhausted(lobby, policy)) return { eligible: false, reason: "invites-exhausted" };
  const reason = keywordFiltered ? "name-keyword" : "target-map";

  // The public browser never reports a mode - `normalizeBrowserRow` leaves `gameMode` undefined for every
  // row - so an unverifiable candidate is entered and judged from the inside. A room whose mode the
  // client does report is judged here, before a join is spent on it.
  if (hasKnownMode(lobby) && !isMayhemAram(lobby)) return { eligible: false, reason: "not-mayhem-aram" };
  return { eligible: true, reason, modeVerified: hasKnownMode(lobby) };
}

/**
 * Acceptance rules for a lobby that has already been joined: target map, target mode, and an
 * invitation budget that is not spent while the room is still too small. Membership proves the
 * password gate was passed and a lobby that just filled up is the goal rather than a rejection, so
 * the browser-only rules (`password-or-unknown`, `full`) do not apply here. A room that is merely
 * below the player floor is *not* rejected: being inside a room while it fills is the point, and the
 * search controller leaves such a room once it stops growing.
 */
export function evaluateJoinedLobby(lobby, policy = DEFAULT_POLICY) {
  if (!policy.mapIds.includes(lobby.mapId)) return { eligible: false, reason: "not-target-map" };
  if (hasKnownMode(lobby) && !isMayhemAram(lobby)) return { eligible: false, reason: "not-mayhem-aram" };
  if (isInviteBudgetExhausted(lobby, policy)) return { eligible: false, reason: "invites-exhausted" };
  return { eligible: true, reason: "joined", modeVerified: hasKnownMode(lobby) };
}

/** Closest to a full room first: that is the game about to start. */
export function rankLobbies(lobbies, policy = DEFAULT_POLICY) {
  return lobbies
    .map((lobby) => ({ lobby, result: evaluateLobby(lobby, policy) }))
    .filter(({ result }) => result.eligible)
    .sort((a, b) => {
      const distance = Math.abs(policy.maxHumanPlayers - (a.lobby.playerCount ?? 0))
        - Math.abs(policy.maxHumanPlayers - (b.lobby.playerCount ?? 0));
      if (distance) return distance;
      const created = new Date(b.lobby.createdAt ?? 0).getTime() - new Date(a.lobby.createdAt ?? 0).getTime();
      if (created) return created;
      return String(a.lobby.id).localeCompare(String(b.lobby.id));
    });
}

export function selectLobby(lobbies, policy = DEFAULT_POLICY) {
  return rankLobbies(lobbies, policy)[0];
}

export function summarizeLobby(lobby) {
  if (!lobby) return undefined;
  const parts = [`${lobby.playerCount ?? "?"}/${lobby.maxHumanPlayers ?? "?"} 人`];
  if (lobby.mapId !== undefined) parts.push(`地图 ${lobby.mapId}`);
  if (lobby.gameMode) parts.push(`模式 ${lobby.gameMode}`);
  if (lobby.inviteCount !== undefined) parts.push(`邀请 ${lobby.inviteCount}`);
  // Spectator state only exists for a joined lobby, and an unknown gate is not worth a log line.
  if (lobby.spectatorsAllowed === true) {
    parts.push(`观战 ${lobby.spectatorCount ?? 0}/${lobby.maxSpectators ?? "?"}`);
  }
  return `房间 ${lobby.id}（${parts.join("，")}）`;
}
