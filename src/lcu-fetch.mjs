import { Agent, request } from "node:https";
import { RIOT_CERTIFICATE } from "./riot-certificate.mjs";

/**
 * The LCU serves HTTPS on 127.0.0.1 with a self-signed certificate that chains to Riot's
 * own CA. Electron's `net.fetch` rejects it (`ERR_CERT_AUTHORITY_INVALID`) because it uses
 * Chromium's trust store, so the LCU is spoken to through this pinned node:https client.
 */
const CERTIFICATE_ERRORS = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_SIGNATURE_FAILURE"
]);

/** The error code and message a stalled request produces; retry policy keys off the code, not the text. */
export const TIMEOUT_CODE = "LCU_TIMEOUT";
export const TIMEOUT_MESSAGE = "LCU 请求超时";

/** A request that answered, but only after a wait the user can feel. */
export const SLOW_REQUEST_MS = 3_000;

/**
 * Message for a successful-but-slow request, or undefined when it was quick enough.
 *
 * The LCU is a local server, so anything above a second is the client taking its time rather than the
 * network. Saying so - with the exact method, path and duration - is what makes "it took 13 seconds to
 * leave the room" answerable instead of mysterious.
 */
export function slowRequestWarning({ method = "GET", path, elapsedMs, thresholdMs = SLOW_REQUEST_MS } = {}) {
  if (!(elapsedMs >= thresholdMs)) return undefined;
  return `LCU 响应慢：${method} ${path} 用了 ${(elapsedMs / 1000).toFixed(1)}s`;
}

/**
 * Whether a failed LCU request may be sent again.
 *
 * The client goes quiet for a moment now and then - while it loads a game, or right after a join - and a
 * timeout on a read is harmless to repeat. A write is never repeated: the request that timed out may
 * already have been applied, and joining or leaving a room twice is not the same as doing it once.
 */
export function shouldRetryRequest({ method = "GET", error, attempt = 0, aborted = false } = {}) {
  if (attempt >= 1) return false;
  if (method !== "GET") return false;
  if (aborted) return false;
  return error?.code === TIMEOUT_CODE;
}

/**
 * Builds a fetch-shaped client for the LCU. Certificate pinning against Riot's CA is the
 * default; only a loopback request that fails that check falls back to an unverified
 * handshake, and the decision is remembered for the rest of the session.
 */
export function createLcuFetch({ certificate = RIOT_CERTIFICATE, timeoutMs = 15_000, onWarning = () => {}, maxSockets = 4 } = {}) {
  let pinningFailed = false;
  // Connections are deliberately NOT kept alive. The LCU is a small embedded server that closes idle
  // sockets on its own schedule, and a pooled socket that the server has already closed fails the
  // classic way: the request is written into a dying socket and then waits out the full timeout
  // instead of erroring, which surfaced as sporadic "LCU 请求超时" on reads and writes alike. A fresh
  // loopback connection costs a handshake measured in microseconds, so it is the cheaper trade.
  const agent = new Agent({ keepAlive: false, maxSockets });

  const send = (url, { method = "GET", headers = {}, signal, rejectUnauthorized, ca }) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      if (target.hostname !== "127.0.0.1" && target.hostname !== "localhost") {
        reject(new Error(`拒绝向非本地地址发送凭据：${target.hostname}`));
        return;
      }
      const startedAt = Date.now();
      const outgoing = request(
        {
          host: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method,
          headers,
          timeout: timeoutMs,
          rejectUnauthorized,
          ca,
          agent
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            text: async () => body,
            json: async () => (body.length === 0 ? undefined : JSON.parse(body))
          }));
        }
      );
      outgoing.on("timeout", () => {
        // The wait time and whether the socket ever connected separate "the client is not accepting
        // connections" from "the client accepted and then went silent". The two have different causes,
        // and until now they produced an identical log line.
        const phase = outgoing.socket?.connecting ? "连接未建立" : "已连接但无响应";
        const error = new Error(`${TIMEOUT_MESSAGE}（等待 ${Date.now() - startedAt}ms，${phase}）`);
        error.code = TIMEOUT_CODE;
        outgoing.destroy(error);
      });
      // The search reuses one AbortSignal for its whole session, so a listener left behind by every
      // request would pile up (Node warns from eleven onwards) and keep finished requests reachable.
      const onAbort = () => outgoing.destroy(new Error("aborted"));
      const detach = () => signal?.removeEventListener?.("abort", onAbort);
      outgoing.on("close", detach);
      outgoing.on("error", (error) => { detach(); reject(error); });
      if (signal) {
        if (signal.aborted) outgoing.destroy(new Error("aborted"));
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      outgoing.end();
    });

  /** One request, with the certificate-pinning fallback applied at most once per session. */
  const attemptOnce = async (url, options) => {
    if (!pinningFailed) {
      try {
        return await send(url, { ...options, rejectUnauthorized: true, ca: certificate });
      } catch (error) {
        if (!CERTIFICATE_ERRORS.has(error?.code)) throw error;
        pinningFailed = true;
        onWarning(`LCU 证书与内置 Riot CA 不匹配（${error.code}），本次运行改用未校验的本地回环连接。`);
      }
    }
    return send(url, { ...options, rejectUnauthorized: false, ca: undefined });
  };

  const lcuFetch = async function lcuFetch(url, options = {}) {
    const startedAt = Date.now();
    let attempt = 0;
    for (;;) {
      try {
        const response = await attemptOnce(url, options);
        const warning = slowRequestWarning({
          method: options.method ?? "GET",
          path: new URL(url).pathname,
          elapsedMs: Date.now() - startedAt
        });
        if (warning) onWarning(warning);
        return response;
      } catch (error) {
        const aborted = Boolean(options.signal?.aborted);
        if (!shouldRetryRequest({ method: options.method ?? "GET", error, attempt, aborted })) throw error;
        attempt += 1;
      }
    }
  };

  /** Closes pooled sockets; called when the app shuts down so nothing keeps the process alive. */
  lcuFetch.dispose = () => agent.destroy();
  return lcuFetch;
}
