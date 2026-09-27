import WebSocket from "ws";
import { RIOT_CERTIFICATE } from "./riot-certificate.mjs";

/**
 * The LCU speaks a small WebSocket protocol on the same port as its REST API:
 * subscribe by sending `[5, "OnJsonApiEvent"]` (5 = subscribe), and the client pushes every
 * state change as `[8, uri, { data, uri, eventType }]` (8 = push). This is how the client UI
 * itself stays live, so it is the earliest possible signal for both "the client is gone"
 * (the socket closes) and "the joined room changed" (the lobby endpoint pushes).
 */
const OP_SUBSCRIBE = 5;
const OP_PUSH = 8;
const SUBSCRIPTION = "OnJsonApiEvent";

/** Reconnect pacing for a socket that keeps failing; reset to the first step on success. */
const RECONNECT_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * A supervised LCU WebSocket session for one client connection.
 *
 * The socket's lifecycle *is* the client-liveness signal: when it closes, the client is gone -
 * no probing needed. That is why a close is reported immediately (`onDown`) while reconnect
 * attempts keep running in the background; if the same client is still there, the socket simply
 * comes back and `onUp` fires. A client restart changes the port/token, which the caller handles
 * by `stop()`-ing this session and building a new one from the fresh discovery result.
 *
 * The certificate policy mirrors `lcu-fetch`: pinned against Riot's CA first, falling back to an
 * unverified loopback handshake at most once per session when the pin does not hold.
 */
export function createLcuWebsocket({ port, token, onEvent = () => {}, onDown = () => {}, onUp = () => {} } = {}) {
  // Discovery reports the port as a string (parsed out of the lockfile or the client log), so the
  // type is normalized here instead of pushing a cast onto every caller. A rejected constructor
  // used to escape through refreshClientStatus and take the whole status readout down with it,
  // which is why the coercion lives in the module rather than in the call sites.
  const normalizedPort = Number(port);
  if (!Number.isFinite(normalizedPort) || normalizedPort <= 0 || typeof token !== "string" || token.length === 0) {
    throw new Error(`无效的 LCU 连接参数（port=${port}）`);
  }
  port = normalizedPort;

  let socket;
  let stopped = true;
  let up = false;
  let pinningFailed = false;
  let reconnectAttempt = 0;
  let reconnectTimer;
  let generation = 0;

  const connectOptions = () => pinningFailed
    ? { rejectUnauthorized: false, ca: undefined }
    : { rejectUnauthorized: true, ca: RIOT_CERTIFICATE };

  const clearReconnect = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };

  /** One connection attempt; resolves when the socket is open, rejects on any failure. */
  const connectOnce = (myGeneration) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://riot:${token}@127.0.0.1:${port}`, connectOptions());
      let settled = false;
      const bail = (error) => {
        if (settled) return;
        settled = true;
        try { ws.terminate(); } catch { /* already dead */ }
        reject(error);
      };
      ws.on("open", () => {
        if (myGeneration !== generation || stopped) {
          try { ws.close(); } catch { /* already dead */ }
          return;
        }
        settled = true;
        resolve(ws);
      });
      ws.on("error", bail);
      ws.on("unexpected-response", (_request, response) =>
        bail(new Error(`LCU WebSocket 握手被拒绝（HTTP ${response.statusCode}）`)));
    });

  const attach = (ws) => {
    ws.on("message", (raw) => {
      let parsed;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      if (!Array.isArray(parsed) || parsed[0] !== OP_PUSH) return;
      const payload = parsed[2];
      if (!payload || typeof payload.uri !== "string") return;
      onEvent({ uri: payload.uri, eventType: payload.eventType, data: payload.data });
    });
    ws.on("close", () => {
      socket = undefined;
      if (up) {
        up = false;
        onDown();
      }
      scheduleReconnect();
    });
    ws.on("error", () => { /* 'close' follows; nothing to do here */ });
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    clearReconnect();
    const delay = RECONNECT_STEPS_MS[Math.min(reconnectAttempt, RECONNECT_STEPS_MS.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => { void run(); }, delay);
    reconnectTimer.unref?.();
  };

  const run = async () => {
    if (stopped || socket) return;
    const myGeneration = generation;
    try {
      const ws = await connectOnce(myGeneration);
      if (myGeneration !== generation || stopped) {
        try { ws.close(); } catch { /* already dead */ }
        return;
      }
      socket = ws;
      reconnectAttempt = 0;
      attach(ws);
      ws.send(JSON.stringify([OP_SUBSCRIBE, SUBSCRIPTION]));
      if (!up) {
        up = true;
        onUp();
      }
    } catch (error) {
      if (myGeneration !== generation || stopped) return;
      const code = error?.code ?? "";
      if (/CERT|SELF_SIGNED|DEPTH_ZERO|UNABLE_TO/.test(code)) pinningFailed = true;
      scheduleReconnect();
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void run();
    },
    stop() {
      stopped = true;
      generation += 1;
      clearReconnect();
      const ws = socket;
      socket = undefined;
      if (ws) {
        try { ws.close(); } catch { /* already dead */ }
      }
      if (up) {
        up = false;
        onDown();
      }
    },
    isUp() { return up; }
  };
}
