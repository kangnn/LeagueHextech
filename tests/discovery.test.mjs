import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/**
 * LCU discovery gating. Runs on plain Node: the process probe is injected, so nothing here needs a
 * real client, and the stale-log case is exercised without touching the filesystem (no process means
 * no read attempt at all - that is the contract under test).
 */
const root = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src")).href + "/";
const { discoverLcuConnection } = await import(root + "lcu-discovery.mjs");

// An environment that points the install-root scan at an empty temp dir keeps the FS work trivial.
const env = { LEAGUE_INSTALL_PATH: undefined, ProgramFiles: "Z:\\nonexistent", "ProgramFiles(x86)": "Z:\\nonexistent" };

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log("PASS", name); }
  catch (error) { failures += 1; console.log("FAIL", name, "-", error.message); }
};

check("no client process means not connected, and no connection source is even consulted", async () => {
  let consulted = false;
  const error = await discoverLcuConnection({
    env,
    // A reader that would "find" parameters must never be reached when the process probe says none.
    listPids: async () => { consulted = true; return []; }
  }).then(() => null, (e) => e);
  assert.ok(error, "expected a rejection");
  assert.equal(error.hasClient, false);
  assert.ok(error.fatal);
  assert.ok(!consulted, "stale sources (client log / lockfile) must not be read without a live process");
  assert.ok(error.message.includes("未检测到"), error.message);
});

check("a live process that yields no parameters is a different, reported-as-such failure", async () => {
  const error = await discoverLcuConnection({
    env,
    listPids: async () => [4242]
  }).then(() => null, (e) => e);
  assert.ok(error, "expected a rejection");
  assert.equal(error.hasClient, true);
  assert.ok(error.message.includes("无法获取连接参数"), error.message);
});

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
