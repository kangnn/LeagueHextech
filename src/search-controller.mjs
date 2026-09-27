import {
  DEFAULT_POLICY,
  evaluateJoinedLobby,
  isInviteBudgetExhausted,
  rankLobbies,
  summarizeLobby
} from "./eligibility.mjs";

export const STATES = Object.freeze({
  idle: "idle",
  connecting: "connecting",
  searching: "searching",
  joining: "joining",
  verifying: "verifying",
  joined: "joined"
});

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Reason codes are stable identifiers; the log shows the readable form so a leave is explainable. */
const REASON_LABELS = Object.freeze({
  "not-target-map": "地图不是嚎哭深渊",
  "not-5v5": "不是 10 人房间",
  "password-or-unknown": "需要密码或密码状态未知",
  "not-joinable": "房间已不可加入",
  full: "房间已满",
  "name-mismatch": "房间名不含关键词",
  "too-few-players": "人数不足",
  "mode-unknown": "无法确认模式",
  "not-mayhem-aram": "不是海克斯乱斗",
  "invites-exhausted": "邀请已达上限且人数仍然不足"
});

function describeReason(reason) {
  return REASON_LABELS[reason] ?? String(reason);
}

export class SearchController {
  #running = false;
  #timer = undefined;
  #delayMs;
  #state = STATES.idle;
  #abort;
  #lastRefreshAt;
  #candidateCount = 0;
  // How many of those rows survived the filters (map, password, full, name keywords). The raw list is
  // mostly other maps and rooms that have nothing to do with this search, so the two numbers are only
  // meaningful together.
  #eligibleCount = 0;
  #selected;
  #lastError;
  #diagnostics;
  // Lobby ids rejected during the current sweep. Cleared once a sweep is exhausted so the next
  // sweep retries them against a freshly fetched list.
  #rejectedThisSweep = new Set();
  // Rooms this run left because their invitation budget was spent while they were still too small.
  // A spent budget never refills, so the room is only re-entered once the browser shows a bigger
  // room than the one that was abandoned, or after the cooldown - otherwise the search would join
  // and leave the same hopeless room on every sweep.
  #exhaustedRooms = new Map();
  // Player counts of the newest browser snapshot, keyed by room id. Replaced on every sweep.
  #snapshotCounts = new Map();
  #seenLobbyIds = new Set();
  #sweepDelayMs;
  #sweepCount = 0;
  #lastForcedRefreshAt = Number.NEGATIVE_INFINITY;
  // A joined room is watched until it fills, spends its invitation budget, or stops growing below the
  // player floor. `#adoptedRoom` marks the one exception: a room the user was already in is watched the
  // same way but never vacated by the tool.
  #watchJoined = false;
  #watchingSummary;
  // Progress of the watched room: a room that keeps gaining players is never abandoned, while one
  // that sits below the player floor without growing is left again after `stallTimeoutMs`.
  #watchPlayerCount = 0;
  #watchProgressAt = 0;
  // Whether the watched room is currently under the player floor, and when it will be given up on.
  // Surfaced through `status()` so the UI can explain a wait instead of looking stuck.
  #belowFloor = false;
  #watchDeadlineAt;
  // Cadence for the watch loop while reads keep failing; 0 means "use the normal poll interval".
  #watchDelayMs = 0;
  // Trailing debounce for WebSocket lobby pushes, so a burst of client events coalesces into one
  // watch run instead of one run per event.
  #pushTimer = undefined;
  // A room the user was already sitting in when the search started. It is watched under the same rules
  // as a joined one, but never left automatically, because the tool did not put the user there.
  #adoptedRoom = false;

  constructor(provider, {
    policy = DEFAULT_POLICY,
    intervalMs = 2_000,
    maxIntervalMs = 15_000,
    // A sweep is one full pass over the current list. When a sweep is exhausted the list is
    // re-fetched and the pass repeats after `sweepIntervalMs`, backing off up to `maxSweepIntervalMs`
    // while the list keeps returning nothing new.
    sweepIntervalMs = 3_000,
    maxSweepIntervalMs = 15_000,
    // The client is asked to re-scan its lobby browser at most this often.
    refreshThrottleMs = 10_000,
    // How long a room abandoned for a spent invitation budget stays out of the running when the
    // browser still reports it as unchanged.
    exhaustedCooldownMs = 120_000,
    // How long a watched room may sit below the player floor without gaining a single player before
    // it is abandoned. A room that keeps filling never reaches this, because progress resets it.
    // 0 makes the floor a hard gate: such a room is left on the very first check.
    stallTimeoutMs = 30_000,
    // A party whose invitation list is already full refuses browser joins outright
    // (HTTP 400 / PARTY_INVITE_LIMIT), so it is set aside for far longer than a merely stale room.
    inviteLimitCooldownMs = 600_000,
    // The watch loop (holding a joined room) never polls faster than this, even when the browser
    // poll interval is small: every watch rule works on seconds, so a faster tick is pure load.
    // 0 disables the floor - the tests drive time with 10ms intervals.
    watchIntervalFloorMs = 1_000,
    // Pacing inside one sweep, so a long list of plausible rooms cannot flood the client.
    attemptGapMs = 500,
    // How long a burst of WebSocket lobby pushes is coalesced before the watch reacts.
    pushDebounceMs = 200,
    maxAttemptsPerSweep = 20,
    clock = () => Date.now(),
    emit = () => {}
  } = {}) {
    this.provider = provider;
    this.policy = { ...policy };
    this.intervalMs = intervalMs;
    this.maxIntervalMs = maxIntervalMs;
    this.sweepIntervalMs = sweepIntervalMs;
    this.maxSweepIntervalMs = Math.max(maxSweepIntervalMs, sweepIntervalMs);
    this.refreshThrottleMs = refreshThrottleMs;
    this.exhaustedCooldownMs = exhaustedCooldownMs;
    this.stallTimeoutMs = stallTimeoutMs;
    this.inviteLimitCooldownMs = inviteLimitCooldownMs;
    this.watchIntervalFloorMs = watchIntervalFloorMs;
    this.attemptGapMs = attemptGapMs;
    this.pushDebounceMs = pushDebounceMs;
    this.maxAttemptsPerSweep = maxAttemptsPerSweep;
    this.clock = clock;
    this.emit = emit;
    this.#delayMs = intervalMs;
    this.#sweepDelayMs = sweepIntervalMs;
  }

  get running() { return this.#running; }
  get state() { return this.#state; }

  /** Read-only snapshot for the renderer; contains no credentials or raw lobby payloads. */
  status() {
    return {
      state: this.#state,
      running: this.#running,
      lastRefreshAt: this.#lastRefreshAt,
      candidateCount: this.#candidateCount,
      eligibleCount: this.#eligibleCount,
      sweepCount: this.#sweepCount,
      sweepIntervalMs: this.sweepIntervalMs,
      selectedSummary: summarizeLobby(this.#selected),
      lastError: this.#lastError,
      pollIntervalMs: this.intervalMs,
      minPlayers: this.policy.minPlayers,
      // A watched room under the floor is being waited on; the deadline makes that wait legible.
      belowFloor: this.#belowFloor,
      watchDeadlineAt: this.#watchDeadlineAt,
      maxInvites: this.policy.maxInvites,
      nameKeywords: [...(this.policy.nameKeywords ?? [])],
      diagnostics: this.#diagnostics
    };
  }

  /**
   * Whether the client's WebSocket is currently connected and pushing lobby events. While it is,
   * the watch is driven by `acceptLobbyPush` and the periodic backstop widens to `maxIntervalMs`;
   * the main process flips this with the socket's up/down signal.
   */
  watchPushConnected = false;

  /**
   * Feeds a joined-lobby state that the client pushed over its WebSocket (`/lol-lobby/v2/lobby`).
   * A push makes the next scheduled watch fetch redundant - the data has already arrived - so the
   * pending timer is cancelled and the watch runs on the pushed payload after a short coalescing
   * debounce (a burst of client events then costs one run, not one per event). A `null`/`undefined`
   * payload means the room is gone (the client pushes a Delete with no data).
   *
   * Returns whether the push was consumed; anything but a watched joined room ignores it, since
   * search sweeps and verification must read fresh data for their own decisions.
   */
  acceptLobbyPush(lobby) {
    if (!this.#running || this.#state !== STATES.joined || !this.#watchJoined) return false;
    const signal = this.#abort?.signal;
    clearTimeout(this.#timer);
    clearTimeout(this.#pushTimer);
    this.#pushTimer = setTimeout(() => {
      this.#pushTimer = undefined;
      if (this.#stale(signal) || !this.#watchJoined) return;
      this.#watchWith(signal, lobby).catch((error) => this.#watchFailure(signal, error));
    }, this.pushDebounceMs);
    return true;
  }

  /** Applies non-sensitive settings without restarting an active search. */
  configure({ pollIntervalMs, minPlayers, nameKeywords, maxInvites, stallTimeoutMs } = {}) {    if (Number.isFinite(pollIntervalMs) && pollIntervalMs > 0) {
      this.intervalMs = pollIntervalMs;
      this.#delayMs = pollIntervalMs;
    }
    if (Number.isFinite(minPlayers) && minPlayers >= 0) this.policy.minPlayers = minPlayers;
    if (Array.isArray(nameKeywords)) this.policy.nameKeywords = [...nameKeywords];
    if (Number.isFinite(maxInvites) && maxInvites >= 0) this.policy.maxInvites = maxInvites;
    if (Number.isFinite(stallTimeoutMs) && stallTimeoutMs >= 0) this.stallTimeoutMs = stallTimeoutMs;
    this.#emit({ type: "configured" });
    return this.status();
  }

  async start() {
    if (this.#running) return;
    this.#running = true;
    this.#delayMs = this.intervalMs;
    this.#sweepDelayMs = this.sweepIntervalMs;
    this.#sweepCount = 0;
    this.#rejectedThisSweep.clear();
    this.#exhaustedRooms.clear();
    this.#snapshotCounts = new Map();
    this.#seenLobbyIds.clear();
    this.#lastForcedRefreshAt = Number.NEGATIVE_INFINITY;
    this.#watchJoined = false;
    this.#watchingSummary = undefined;
    this.#watchPlayerCount = 0;
    this.#watchProgressAt = 0;
    this.#belowFloor = false;
    this.#watchDeadlineAt = undefined;
    this.#adoptedRoom = false;
    this.#watchDelayMs = 0;
    this.#lastError = undefined;
    // The connection readout in the UI keys off this, so a new session must not inherit the old one.
    this.#lastRefreshAt = undefined;
    this.#abort = new AbortController();
    this.#transition(STATES.connecting);
    const signal = this.#abort.signal;

    // Already sitting in a room: verify it instead of joining another party. A room that already meets
    // the floor is the result; one below it is watched like any other, but is never vacated by the tool.
    let existing;
    try {
      existing = await this.provider.currentLobby({ signal });
    } catch (error) {
      if (this.#stale(signal)) return;
    }
    if (this.#stale(signal)) return;
    if (existing) {
      const verdict = evaluateJoinedLobby(existing, this.policy);
      // `evaluateJoinedLobby` accepts a room below the floor on purpose - being inside a room while it
      // fills is the point - so the floor has to be compared here, where the real member list is known.
      const floor = Number(this.policy.minPlayers) || 0;
      const belowFloor = (Number(existing.playerCount) || 0) < floor;
      if (verdict.eligible && !belowFloor) {
        this.#running = false;
        this.#selected = existing;
        return this.#transition(STATES.joined, {
          type: "joined",
          lobby: existing,
          alreadyInRoom: true,
          modeVerified: verdict.modeVerified === true,
          message: "已在房间内（非本工具加入），不会自动退出",
          selectedSummary: summarizeLobby(existing)
        });
      }
      if (verdict.eligible && belowFloor) {
        // Below the floor. Sitting in it is allowed, but only for the same bounded wait a room this
        // tool joined would get - reporting a half-empty room as the finished result forever, with the
        // player floor silently ignored, is what made the search look stuck.
        this.#selected = existing;
        this.#watchJoined = true;
        this.#adoptedRoom = true;
        this.#watchPlayerCount = Number(existing.playerCount) || 0;
        this.#watchProgressAt = this.clock();
        this.#rememberFloorWait();
        this.#watchingSummary = summarizeLobby(existing);
        this.#transition(STATES.joined, {
          type: "joined",
          lobby: existing,
          alreadyInRoom: true,
          modeVerified: verdict.modeVerified === true,
          message: `已在房间内（非本工具加入），人数 ${this.#watchPlayerCount} 低于下限 ${floor}，等待房间增长`,
          selectedSummary: this.#watchingSummary
        });
        return this.#scheduleWatch(signal);
      }
      this.#running = false;
      return this.#transition(STATES.idle, {
        type: "error",
        fatal: true,
        message: `当前已在其他房间中（${summarizeLobby(existing)}），请先离开该房间再开始搜索。`
      });
    }

    return this.#cycle(signal);
  }

  /** Stops polling and cancels in-flight requests; the client keeps whatever room it is in. */
  stop() {
    // An adopted room leaves no search running but still has a joined state and a watch timer to clear.
    if (!this.#running && this.#state !== STATES.joined) return;
    this.#running = false;
    this.#abort?.abort();
    clearTimeout(this.#timer);
    this.#timer = undefined;
    clearTimeout(this.#pushTimer);
    this.#pushTimer = undefined;
    this.#selected = undefined;
    this.#watchJoined = false;
    this.#watchingSummary = undefined;
    this.#belowFloor = false;
    this.#watchDeadlineAt = undefined;
    this.#adoptedRoom = false;
    this.#watchDelayMs = 0;
    this.#transition(STATES.idle, { type: "stopped" });
  }

  /** Explicit "leave room" for the joined state. */
  async leave() {
    this.stop();
    if (!this.provider.leaveLobby) return this.status();
    // Tearing a party down is the client's work, and it can take seconds when invitations are pending or
    // the client is busy. Saying so up front keeps the UI from showing "已停止" and then nothing at all
    // until the client finally answers.
    this.#emit({ type: "leaving", message: "正在通知客户端退出房间…" });
    const startedAt = this.clock();
    try {
      await this.provider.leaveLobby({});
      this.#transition(STATES.idle, { type: "left", elapsedMs: this.clock() - startedAt });
    } catch (error) {
      this.#lastError = describe(error);
      this.#emit({ type: "error", message: this.#lastError });
    }
    return this.status();
  }

  #transition(state, event = {}) {
    this.#state = state;
    this.#emit(event);
  }

  /** Every event carries the full status snapshot so the renderer never has to merge partial state. */
  #emit(event) {
    this.emit({ ...this.status(), ...event, type: event.type ?? this.#state });
  }

  /**
   * Ends the current sweep: the rejections are forgotten, the client is asked to re-scan its
   * browser, and the next pass starts after a backoff. This is what keeps the search alive once
   * every room of the current list has failed.
   */
  async #exhaustSweep(signal, { attempted } = {}) {
    this.#sweepCount += 1;
    this.#rejectedThisSweep.clear();
    // Expired entries are dropped here so an all-night run cannot accumulate dead room ids.
    for (const [id, record] of this.#exhaustedRooms) {
      if (this.clock() >= record.expiresAt) this.#exhaustedRooms.delete(id);
    }
    // Fire and forget, for the same reason as in `#cycle`: the client's rescan and the backoff
    // sleep now overlap instead of adding up before the next sweep.
    void this.#maybeRefresh(signal, { force: true });
    if (this.#stale(signal)) return;
    this.#delayMs = this.#sweepDelayMs;
    this.#sweepDelayMs = Math.min(this.#sweepDelayMs * 2, this.maxSweepIntervalMs);
    this.#transition(STATES.searching, { type: "sweep-exhausted", count: attempted, retryInMs: this.#delayMs });
    return this.#schedule(signal);
  }

  /** Best-effort forced re-scan of the public browser; throttled and never fatal. */
  async #maybeRefresh(signal, { force = false } = {}) {
    if (!this.provider.refreshLobbyList) return;
    const now = this.clock();
    if (!force && now - this.#lastForcedRefreshAt < this.refreshThrottleMs) return;
    this.#lastForcedRefreshAt = now;
    try {
      await this.provider.refreshLobbyList({ signal });
    } catch {
      // A client build without this endpoint is not an error; the previously fetched list is reused.
    }
  }

  /** Short pacing delay between join attempts; the caller re-checks `#stale` afterwards. */
  #sleep(ms) {
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  }

  #stale(signal) {
    return signal.aborted || !this.#running;
  }

  async #cycle(signal) {
    if (this.#stale(signal)) return;
    try {
      this.#transition(STATES.searching);
      // Ask the client to re-scan its browser, but do not wait for it: the refresh POST can take
      // seconds (5s was observed on a busy client), and serialising it in front of every list fetch
      // slowed the whole search loop by exactly that much every cycle. The rescan lands in time for
      // the next cycle's list read.
      void this.#maybeRefresh(signal);
      const lobbies = await this.provider.listLobbies({ signal });
      // The client answered, so whatever failed before is over. Without this a single stalled request
      // left "最近错误" showing for the rest of the session even though the search had recovered.
      this.#lastError = undefined;
      this.#diagnostics = undefined;
      if (this.#stale(signal)) return;
      this.#lastRefreshAt = this.clock();
      this.#candidateCount = lobbies.length;

      // An unseen room id means the list is moving: go back to the base cadence.
      this.#snapshotCounts = new Map(lobbies.map((lobby) => [String(lobby.id), Number(lobby.playerCount) || 0]));
      const ids = new Set(lobbies.map((lobby) => String(lobby.id)));
      if ([...ids].some((id) => !this.#seenLobbyIds.has(id))) this.#sweepDelayMs = this.sweepIntervalMs;
      this.#seenLobbyIds = ids;

      const ranked = rankLobbies(lobbies, this.policy);
      this.#eligibleCount = ranked.length;
      if (ranked.length === 0) {
        this.#selected = undefined;
        this.#delayMs = this.intervalMs;
        this.#emit({ type: "no-match", count: lobbies.length });
        return this.#schedule(signal);
      }

      const retryable = ranked.filter((candidate) =>
        !this.#rejectedThisSweep.has(String(candidate.lobby.id)) && !this.#isExhaustedRoom(candidate.lobby));
      if (retryable.length === 0) {
        // Nothing left to attempt: every room was rejected, or the rest are known-dead rooms.
        // Either way the next sweep starts over from a freshly fetched list.
        return this.#exhaustSweep(signal, { attempted: ranked.length });
      }

      // With more candidates than the per-sweep budget, rotate the start so the tail is not starved.
      const offset = retryable.length > this.maxAttemptsPerSweep ? this.#sweepCount % retryable.length : 0;
      const ordered = [...retryable.slice(offset), ...retryable.slice(0, offset)];

      let attempts = 0;
      let budgetSpent = false;
      for (const candidate of ordered) {
        if (this.#stale(signal)) return;
        if (attempts >= this.maxAttemptsPerSweep) {
          budgetSpent = true;
          break;
        }
        if (attempts > 0) {
          await this.#sleep(this.attemptGapMs);
          if (this.#stale(signal)) return;
        }
        attempts += 1;
        this.#selected = candidate.lobby;
        this.#transition(STATES.joining, {
          type: "joining",
          lobby: candidate.lobby,
          reason: candidate.result.reason,
          message: "尝试加入",
          selectedSummary: summarizeLobby(candidate.lobby)
        });
        try {
          await this.provider.joinLobby(candidate.lobby.id, { signal });
        } catch (error) {
          if (this.#stale(signal)) return;
          if (error?.skip) {
            // A full, locked or revoked room is not retried until the next sweep.
            this.#rejectedThisSweep.add(String(candidate.lobby.id));
            // The client reports rejections as errorCode "RPC_ERROR" with the meaningful code in
            // the message body, so matching the code field alone never fired - every rejection
            // showed the raw HTTP line instead of an explanation.
            const blob = `${error?.errorCode ?? ""} ${error?.message ?? ""}`.toUpperCase();
            const inviteLimit = blob.includes("PARTY_INVITE_LIMIT");
            // PARTY_SIZE_LIMIT means the party behind the listing has no seat left, however many
            // slots the browser snapshot still claims to show. Waiting cannot make seats appear
            // on a 3-second cadence, so these rooms are parked for the same long cooldown as
            // invite-limit ones instead of burning a join attempt on every sweep.
            if (inviteLimit || blob.includes("PARTY_SIZE_LIMIT")) {
              this.#rememberExhausted(candidate.lobby, this.inviteLimitCooldownMs);
            }
            // INVALID_WHILE_PARTY_IN_ACTION is the client mid-transition (a leave or join that has
            // not fully settled), so the room itself is fine and the next sweep simply succeeds.
            const partyBusy = blob.includes("INVALID_WHILE_PARTY_IN_ACTION");
            this.#emit({
              type: "skipped",
              lobby: candidate.lobby,
              reason: inviteLimit ? "invite-limit" : "not-joinable",
              message: inviteLimit
                ? "邀请名额已满（上限 50），无法加入"
                : partyBusy
                  ? "客户端正忙（上一步操作还没完成），稍后自动重试"
                  : blob.includes("PARTY_SIZE_LIMIT")
                    ? "房间人数已满，无法加入"
                    : describe(error),
              selectedSummary: summarizeLobby(candidate.lobby)
            });
            continue;
          }
          throw error;
        }

        this.#transition(STATES.verifying, { type: "verifying", lobby: candidate.lobby, message: "已进入房间，核对模式与邀请额度" });
        const current = await this.provider.currentLobby({ signal });
        if (this.#stale(signal)) return;
        const verification = this.#verify(current, candidate.lobby.id);
        if (verification.ok) {
          this.#selected = current;
          this.#delayMs = this.intervalMs;
          this.#watchJoined = true;
          // Progress is counted from the join, so a room that is still small only gets a stall timeout.
          this.#watchPlayerCount = Number(current.playerCount) || 0;
          this.#watchProgressAt = this.clock();
          this.#rememberFloorWait();
          const summary = summarizeLobby(current);
          this.#watchingSummary = summary;
          this.#transition(STATES.joined, {
            type: "joined",
            lobby: current,
            modeVerified: verification.modeVerified,
            // Saying "waiting for the room to grow" up front is what separates a deliberate wait from
            // the tool looking stuck on a half-empty room.
            message: this.#belowFloor
              ? `人数 ${this.#watchPlayerCount} 低于下限 ${Number(this.policy.minPlayers) || 0}，等待房间增长`
              : "已在房间内，持续确认人数变化",
            selectedSummary: summary
          });
          return this.#scheduleWatch(signal);
        }

        await this.provider.leaveLobby({ signal });
        if (this.#stale(signal)) return;
        this.#selected = undefined;
        this.#delayMs = this.intervalMs;
        // Without this the same wrong-mode room would be joined and left on every sweep.
        this.#rejectedThisSweep.add(String(candidate.lobby.id));
        if (verification.reason === "invites-exhausted") {
          // This room's invitation list is already at the cap, which is the same dead end the browser
          // refuses outright with PARTY_INVITE_LIMIT. Remembering it only for the current sweep was not
          // enough: the next sweep forgot it and joined the same hopeless room again, burning a join
          // attempt, a leave, and an extra LCU round trip every minute.
          this.#rememberExhausted(current ?? candidate.lobby, this.inviteLimitCooldownMs);
        }
        this.#emit({ type: "rejected-after-join", lobby: current ?? candidate.lobby, message: `${describeReason(verification.reason)}，已退出`, reason: verification.reason, modeVerified: verification.modeVerified });
        return this.#schedule(signal);
      }

      this.#delayMs = this.intervalMs;
      if (budgetSpent) return this.#schedule(signal);
      return this.#exhaustSweep(signal, { attempted: attempts });
    } catch (error) {
      if (this.#stale(signal)) return;
      const message = describe(error);
      this.#lastError = message;
      if (Array.isArray(error?.attempts)) this.#diagnostics = error.attempts;
      if (error?.fatal) {
        this.#running = false;
        clearTimeout(this.#timer);
        this.#timer = undefined;
        return this.#transition(STATES.idle, { type: "error", message, fatal: true });
      }
      this.#emit({ type: "error", message, retryInMs: this.#delayMs });
      this.#delayMs = Math.min(this.#delayMs * 2, this.maxIntervalMs);
      return this.#schedule(signal);
    }
  }

  /**
   * Re-checks a joined room so a room that goes stale is abandoned instead of sat in. The fetch
   * and the judgment are split (`#watchWith`) so a WebSocket push can run the judgment on data
   * the client already delivered, without another round trip.
   */
  async #watch(signal) {
    if (this.#stale(signal) || !this.#watchJoined) return;
    let current;
    try {
      current = await this.provider.currentLobby({ signal });
      // Same as in the sweep: a successful read clears whatever the previous failure left behind.
      this.#lastError = undefined;
      this.#diagnostics = undefined;
      this.#watchDelayMs = 0;
    } catch (error) {
      return this.#watchFailure(signal, error);
    }
    return this.#watchWith(signal, current);
  }

  /** Watch rules applied to lobby data, whether it was fetched or pushed in. */
  async #watchWith(signal, current) {
    if (this.#stale(signal) || !this.#watchJoined) return;
    if (current) {
      this.#lastError = undefined;
      this.#diagnostics = undefined;
      this.#watchDelayMs = 0;
    }
    if (!current) {
      // The lobby is gone: the game started, or the room was closed or left. Nothing to watch.
      this.#watchJoined = false;
      this.#running = false;
      this.#belowFloor = false;
      this.#watchDeadlineAt = undefined;
      this.#selected = undefined;
      return this.#transition(STATES.idle, { type: "room-gone", message: "已不在该房间中（对局可能已开始）" });
    }
    const playerCount = Number(current.playerCount) || 0;
    if (playerCount > this.#watchPlayerCount) {
      this.#watchPlayerCount = playerCount;
      this.#watchProgressAt = this.clock();
    }
    // The room spent its invite budget without filling, so it is left and the search resumes.
    if (isInviteBudgetExhausted(current, this.policy)) {
      return this.#abandonRoom(signal, current, {
        type: "left-stale-room",
        message: `邀请已达上限，人数仍为 ${playerCount}，已退出`
      });
    }
    this.#rememberFloorWait();
    if (this.#belowFloor) {
      // The invitation rule cannot catch a room whose owner simply invited nobody, so the floor is
      // enforced on a clock as well: `stallTimeoutMs` without a single new player means the room is not
      // filling. At 0 the wait is skipped entirely and the floor acts as a hard gate.
      const floor = Number(this.policy.minPlayers) || 0;
      const waited = this.clock() - this.#watchProgressAt;
      if (this.stallTimeoutMs === 0 || waited >= this.stallTimeoutMs) {
        if (this.#adoptedRoom) {
          // The user is in this room by their own choice, so the tool reports instead of kicking them
          // out of it - but it no longer pretends the floor was met either.
          this.#watchJoined = false;
          this.#running = false;
          this.#adoptedRoom = false;
          this.#belowFloor = false;
          this.#watchDeadlineAt = undefined;
          this.#selected = undefined;
          return this.#transition(STATES.idle, {
            type: "left-stalled-room",
            lobby: current,
            message: `人数 ${playerCount} 未达下限 ${floor}，本工具不会退出你自己所在的房间，请手动离开后重新开始`,
            selectedSummary: summarizeLobby(current)
          });
        }
        return this.#abandonRoom(signal, current, {
          type: "left-stalled-room",
          message: this.stallTimeoutMs === 0
            ? `人数 ${playerCount} 低于下限 ${floor}，按设置不等待，已退出`
            : `人数 ${playerCount} 停滞 ${Math.round(this.stallTimeoutMs / 1000)}s 未达下限 ${floor}，已退出`
        });
      }
    }
    this.#selected = current;
    // Only emitted when the room actually changed, so a long wait cannot flood the log.
    const summary = summarizeLobby(current);
    if (summary !== this.#watchingSummary) {
      this.#watchingSummary = summary;
      this.#transition(STATES.joined, {
        type: "watching",
        lobby: current,
        message: this.#belowFloor
          ? `人数 ${playerCount} 仍低于下限 ${Number(this.policy.minPlayers) || 0}，继续等待`
          : "房间人数有变化",
        selectedSummary: summary
      });
    }
    return this.#scheduleWatch(signal);
  }

  /**
   * Leaves a watched room that cannot pay off, remembers it, and resumes the search. The tool only
   * ever does this to a room it joined itself; a room the user was already sitting in is never left.
   */
  async #abandonRoom(signal, current, { type, message }) {
    await this.provider.leaveLobby({ signal });
    if (this.#stale(signal)) return;
    this.#rejectedThisSweep.add(String(current.id));
    this.#rememberExhausted(current);
    this.#watchJoined = false;
    this.#watchingSummary = undefined;
    this.#belowFloor = false;
    this.#watchDeadlineAt = undefined;
    this.#adoptedRoom = false;
    this.#selected = undefined;
    this.#sweepDelayMs = this.sweepIntervalMs;
    this.#delayMs = this.intervalMs;
    this.#transition(STATES.searching, {
      type,
      lobby: current,
      message,
      selectedSummary: summarizeLobby(current),
      retryInMs: this.#delayMs
    });
    return this.#schedule(signal);
  }

  /**
   * Recomputes whether the watched room sits under the player floor and when it will be given up on.
   * The deadline is what the UI shows, so a deliberate wait never looks like the tool being stuck.
   */
  #rememberFloorWait() {
    this.#belowFloor = this.#watchPlayerCount < (Number(this.policy.minPlayers) || 0);
    this.#watchDeadlineAt = this.#belowFloor && this.stallTimeoutMs > 0
      ? this.#watchProgressAt + this.stallTimeoutMs
      : undefined;
  }

  /**
   * Remembers a room that has no way of filling: its invitation budget is spent, or the party
   * refuses new invitations altogether. The browser snapshot is the recovery signal, but it lags the
   * room, so a room only counts as recovered once it reports more players than either source saw.
   */
  #rememberExhausted(lobby, cooldownMs = this.exhaustedCooldownMs) {
    const id = String(lobby.id);
    this.#exhaustedRooms.set(id, {
      playerCount: Math.max(Number(lobby.playerCount) || 0, this.#snapshotCounts.get(id) ?? 0),
      expiresAt: this.clock() + cooldownMs
    });
  }

  /**
   * Watching a joined room needs ~1s granularity, not the user's poll cadence: it halves the request
   * rate while a room is being held without delaying any decision the watch actually makes, since
   * every watch rule (invite budget, stall timeout) works on seconds anyway. While the client's
   * WebSocket is pushing lobby events, the timer demotes to a backstop against a silent push loss:
   * one fetch per `maxIntervalMs` instead of one per second.
   */
  #watchIntervalMs() {
    if (this.watchPushConnected) return Math.max(this.maxIntervalMs, this.watchIntervalFloorMs);
    return Math.max(this.intervalMs, this.watchIntervalFloorMs);
  }

  #scheduleWatch(signal) {
    if (this.#stale(signal) || !this.#watchJoined) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#watch(signal).catch((error) => this.#watchFailure(signal, error));
    }, this.#watchDelayMs || this.#watchIntervalMs());
  }

  /** A failure while watching a joined room: retried, unless the client session itself is gone. */
  #watchFailure(signal, error) {
    if (this.#stale(signal)) return;
    this.#lastError = describe(error);
    if (error?.fatal) {
      this.#watchJoined = false;
      this.#running = false;
      return this.#transition(STATES.idle, { type: "error", message: this.#lastError, fatal: true });
    }
    // A failing watch must not retry at the poll cadence. Leaving a room that keeps timing out would
    // otherwise fire a DELETE every interval - at a 500ms poll that is two futile writes a second aimed
    // at a client that is already not answering.
    this.#watchDelayMs = Math.min(Math.max(this.#watchDelayMs || this.#watchIntervalMs(), this.intervalMs) * 2, this.maxIntervalMs);
    this.#emit({ type: "error", message: this.#lastError, retryInMs: this.#watchDelayMs });
    return this.#scheduleWatch(signal);
  }

  /**
   * Post-join verification. The browser snapshot that led here cannot be trusted on the two things
   * only a joined lobby reports - the game mode and the invitation record count - and a room that
   * emptied out between the snapshot and the join is not worth sitting in either.
   */
  #verify(lobby, expectedId) {
    if (!lobby) return { ok: false, reason: "加入后未读取到当前房间" };
    if (String(lobby.id) !== String(expectedId)) {
      return { ok: false, reason: `当前房间与目标不一致（${String(lobby.id)} ≠ ${String(expectedId)}）` };
    }
    const result = evaluateJoinedLobby(lobby, this.policy);
    if (!result.eligible) return { ok: false, reason: result.reason, modeVerified: result.modeVerified };
    return { ok: true, modeVerified: result.modeVerified === true };
  }

  /**
   * True while a room abandoned for a spent invitation budget still looks no better than it did
   * when it was left. A room that has genuinely recovered reports more players, so it is retried.
   */
  #isExhaustedRoom(lobby) {
    const id = String(lobby.id);
    const record = this.#exhaustedRooms.get(id);
    if (!record) return false;
    if (this.clock() >= record.expiresAt) {
      this.#exhaustedRooms.delete(id);
      return false;
    }
    return Number(lobby.playerCount) <= record.playerCount;
  }

  #schedule(signal) {
    if (this.#stale(signal)) return;
    this.#timer = setTimeout(() => this.#cycle(signal), this.#delayMs);
  }
}
