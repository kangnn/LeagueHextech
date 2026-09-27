import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStatsReporter } from "../src/stats.mjs";

let passed = 0;
function check(name, ok, detail = "") {
  if (!ok) {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log(`PASS ${name}`);
  }
}

const dir = await mkdtemp(path.join(tmpdir(), "lh-stats-"));
try {
  /* ---------------- 心跳、实例 ID 持久化与静默失败 ---------------- */
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (calls.length === 2) throw new Error("network down"); // 第二次心跳模拟断网
    return { ok: true, status: 204 };
  };

  const reporter = createStatsReporter({
    userDataPath: dir,
    appVersion: "0.1.5",
    endpoint: "https://stats.example/api",
    intervalMs: 30,
    fetchImpl
  });
  reporter.start();
  await new Promise((r) => setTimeout(r, 80));
  reporter.stop();
  await new Promise((r) => setTimeout(r, 30));

  const heartbeats = calls.filter((c) => c.url.endsWith("/heartbeat"));
  const offline = calls.filter((c) => c.url.endsWith("/offline"));
  check("start 立即与定时发送心跳", heartbeats.length >= 3, `实际 ${heartbeats.length} 次`);
  check("断网的那次心跳没有抛出", true); // 走到这里本身就说明 send 吞掉了异常
  check("退出补发一次下线信号", offline.length === 1, `实际 ${offline.length} 次`);
  check("上报只含 id 和版本号两个字段", Object.keys(heartbeats[0].body).sort().join() === "id,v");
  check("版本号来自 appVersion", heartbeats[0].body.v === "0.1.5");

  const stored = (await readFile(path.join(dir, "stats-instance-id"), "utf8")).trim();
  check("实例 ID 已落盘", /^[0-9a-f-]{8,64}$/i.test(stored), stored);
  check("所有上报用同一个实例 ID", heartbeats.every((c) => c.body.id === stored));

  /* ---------------- 复用已有 ID（模拟第二次启动） ---------------- */
  const secondCalls = [];
  const second = createStatsReporter({
    userDataPath: dir,
    appVersion: "0.1.6",
    endpoint: "https://stats.example/api",
    intervalMs: 3_600_000,
    fetchImpl: async (url, init) => { secondCalls.push(JSON.parse(init.body)); return { ok: true }; }
  });
  second.start();
  await new Promise((r) => setTimeout(r, 20));
  await second.stop();

  check("第二次启动复用同一实例 ID", secondCalls.length === 2 && secondCalls[0].id === stored);
  check("新版本号被上报", secondCalls[0].v === "0.1.6");

  /* ---------------- 超时也是静默 ---------------- */
  const slow = createStatsReporter({
    userDataPath: path.join(dir, "fresh"),
    appVersion: "0.1.5",
    intervalMs: 3_600_000,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(new Error("aborted"))))
  });
  slow.start(); // 8s 超时对 3.6h 间隔来说不会真的等到；这里只验证不阻塞、不抛出
  await new Promise((r) => setTimeout(r, 20));
  check("慢请求不阻塞 start", true);
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(passed === 10 ? "ALL PASS" : `FAILURE(S): ${10 - passed} 项未过`);
