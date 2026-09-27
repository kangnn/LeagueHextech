import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 匿名使用统计：启动与每 5 分钟上报一次 {随机实例 ID, 版本号}，正常退出补发一次下线。
 * 不收集任何个人信息，请求失败一律静默——统计永远不能影响使用，也不能刷任何日志。
 * 实例 ID 存在 userData 自己的文件里（settings.json 有字段白名单，会被清洗掉）。
 */

// 发布后的统计服务地址（WorkBuddy 站点托管）。
const STATS_ENDPOINT = "https://lh-hextech-stats.example/stats-api-placeholder";

const REQUEST_TIMEOUT_MS = 8_000;

export function createStatsReporter({
  userDataPath,
  appVersion,
  endpoint = STATS_ENDPOINT,
  intervalMs = 5 * 60 * 1000,
  fetchImpl = fetch
}) {
  let timer;
  let idPromise;

  /** 首次生成随机 UUID 并落盘，之后一直复用同一个；文件坏了就当新实例，无伤大雅。 */
  function instanceId() {
    if (!idPromise) {
      idPromise = (async () => {
        const file = path.join(userDataPath, "stats-instance-id");
        try {
          const stored = (await readFile(file, "utf8")).trim();
          if (/^[0-9a-f-]{8,64}$/i.test(stored)) return stored;
        } catch { /* 首次运行或文件损坏 */ }
        const fresh = randomUUID();
        try {
          await mkdir(userDataPath, { recursive: true });
          await writeFile(file, `${fresh}\n`, "utf8");
        } catch { /* 只读环境也照常上报本次会话 */ }
        return fresh;
      })();
    }
    return idPromise;
  }

  /** 永不 reject：统计请求的任何失败都等于"没统计到"，仅此而已。 */
  function send(action) {
    return (async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          await fetchImpl(`${endpoint}/${action}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: await instanceId(), v: appVersion }),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeout);
        }
      } catch { /* 静默 */ }
    })();
  }

  return {
    start() {
      if (timer) return;
      void send("heartbeat");
      timer = setInterval(() => void send("heartbeat"), intervalMs);
      timer.unref?.();
    },
    /** 正常退出时尽力补发一次下线信号（进程可能先走完，收不到就靠心跳超时兜底）。 */
    stop() {
      if (timer) { clearInterval(timer); timer = undefined; }
      return send("offline");
    },
    _instanceId: instanceId
  };
}
