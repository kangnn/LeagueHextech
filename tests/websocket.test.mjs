import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/**
 * Argument handling of the LCU WebSocket module. No socket is ever opened here: construction is
 * where the connection parameters are validated, and a throw from it once escaped through the
 * status refresh and froze the client indicator on "未检测到客户端" while the search itself was
 * still working.
 */
const root = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src")).href + "/";
const { createLcuWebsocket } = await import(root + "lcu-websocket.mjs");

let failures = 0;
const check = (name, condition, detail = "") => {
  if (condition) console.log("PASS", name);
  else { failures += 1; console.log("FAIL", name, detail); }
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

check("a numeric-string port is accepted (discovery reports strings)",
  !throws(() => createLcuWebsocket({ port: "13025", token: "abc" })));
check("a numeric port is accepted",
  !throws(() => createLcuWebsocket({ port: 13025, token: "abc" })));
check("a garbage port is rejected", throws(() => createLcuWebsocket({ port: "abc", token: "abc" })));
check("a zero port is rejected", throws(() => createLcuWebsocket({ port: 0, token: "abc" })));
check("a missing token is rejected", throws(() => createLcuWebsocket({ port: "13025", token: "" })));
check("no arguments at all are rejected", throws(() => createLcuWebsocket()));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
