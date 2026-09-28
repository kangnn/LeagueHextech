import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

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
// Every check is collected and awaited before the verdict is printed. An async check that is merely
// fired off lets the run reach `process.exit` while assertions are still pending, which reports
// success without having verified anything.
const pending = [];
const check = (name, fn) => {
  pending.push((async () => {
    try { await fn(); console.log("PASS", name); }
    catch (error) { failures += 1; console.log("FAIL", name, "-", error.message); }
  })());
};

check("no client process means not connected, and no connection source is even consulted", async () => {
  // A leftover client log that still holds a perfectly usable port and token is the trap: with no
  // LeagueClientUx process alive those parameters are dead, and trusting them is what made the
  // status indicator claim "已连接客户端" on a machine with the game closed.
  const dir = await mkdtemp(path.join(tmpdir(), "lcu-nopid-"));
  try {
    const clientDir = path.join(dir, "LeagueClient");
    await mkdir(clientDir, { recursive: true });
    await writeFile(path.join(clientDir, "1_2_789_LeagueClientUx.log"),
      "--app-pid=789 --app-port=1234 --remoting-auth-token=staleTok", "utf8");
    const error = await discoverLcuConnection({
      env: { ...env, LEAGUE_INSTALL_PATH: dir },
      listPids: async () => []
    }).then(() => null, (e) => e);
    assert.ok(error, "a stale log must never be used while no client process is running");
    assert.equal(error.hasClient, false);
    assert.ok(error.fatal);
    assert.ok(error.message.includes("未检测到"), error.message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

check("a live process that yields no parameters is a different, reported-as-such failure", async () => {
  const error = await discoverLcuConnection({
    env,
    listPids: async () => [4242]
  }).then(() => null, (e) => e);
  assert.ok(error, "expected a rejection");
  assert.equal(error.hasClient, true);
  assert.ok(error.message.includes("读不到连接参数"), error.message);
});

check("failure messages stay human: no install paths or pid lists leak into the visible text", async () => {
  const cases = [
    { listPids: async () => [] },
    { listPids: async () => [4242] }
  ];
  for (const overrides of cases) {
    const error = await discoverLcuConnection({ env, ...overrides }).then(() => null, (e) => e);
    assert.ok(error, "expected a rejection");
    // The message is what a buyer reads in the error row and in a toast: it must be one sentence of
    // advice. Paths, pids and reader failures belong in `attempts`, shown only on hover.
    assert.ok(!/Program Files/.test(error.message), `paths leaked: ${error.message}`);
    assert.ok(!/LeagueClientUx\.exe/.test(error.message), `process name leaked: ${error.message}`);
    assert.ok(!/PID/.test(error.message), `pid list leaked: ${error.message}`);
    assert.ok(!/；/.test(error.message), `details joined into the message: ${error.message}`);
    assert.ok(Array.isArray(error.attempts) && error.attempts.length > 0, "details must still be available");
  }
});

check("a successful discovery is reused while the process list is unchanged, and recomputed when it changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lcu-disc-"));
  try {
    const clientDir = path.join(dir, "LeagueClient");
    await mkdir(clientDir, { recursive: true });
    const logPath = path.join(clientDir, "1_2_789_LeagueClientUx.log");
    const commandLine = (token) =>
      `--app-pid=789 --app-port=1234 --remoting-auth-token=${token}`;
    await writeFile(logPath, commandLine("tokA"), "utf8");
    const testEnv = { ...env, LEAGUE_INSTALL_PATH: dir };

    const discover = (pids) => discoverLcuConnection({ env: testEnv, listPids: async () => pids });

    const first = await discover([789]);
    assert.equal(first.token, "tokA");
    assert.equal(first.source, "client-log");

    // The same process list must serve the cached answer: the file now carries tokB, but a live
    // process never changes its port/token, so re-reading it would be pure cost.
    await writeFile(logPath, commandLine("tokB"), "utf8");
    const second = await discover([789]);
    assert.equal(second.token, "tokA", "expected the cached connection, got a re-read");

    // A different process list (restart) invalidates the cache and re-reads the sources.
    const third = await discover([789, 999]);
    assert.equal(third.token, "tokB", "expected a fresh read after the process list changed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await Promise.all(pending);
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
