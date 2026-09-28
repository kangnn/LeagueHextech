import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const UX_PROCESS_NAME = "LeagueClientUx.exe";
const LOG_READ_LIMIT = 512 * 1024;

export function parseLockfile(contents) {
  const [name, pid, port, token, protocol] = contents.trim().split(":");
  if (!name || !/^\d+$/.test(pid) || !/^\d+$/.test(port) || !token || !/^https?$/.test(protocol)) {
    throw new Error("League Client lockfile 格式无效。");
  }
  return { port, token, protocol, pid: Number(pid) };
}

/** Parses the client's own command line; also used for `lockfile`-free startup paths. */
export function parseCommandLine(text) {
  const port = text.match(/--app-port=(\d+)/)?.[1];
  const token = text.match(/--remoting-auth-token=([\w-]+)/)?.[1];
  const pid = text.match(/--app-pid=(\d+)/)?.[1];
  if (!port || !token) return null;
  return { port, token, protocol: "https", pid: pid ? Number(pid) : undefined };
}

function decodeLog(buffer) {
  const utf8 = buffer.toString("utf8");
  if (parseCommandLine(utf8)) return utf8;
  const utf16 = buffer.toString("utf16le");
  return parseCommandLine(utf16) ? utf16 : utf8;
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

/** Well-known install locations, including Tencent/WeGame layouts used by the CN client. */
export function candidateInstallRoots(env = process.env) {
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const roots = [
    env.LEAGUE_INSTALL_PATH,
    "C:\\Riot Games\\League of Legends",
    path.join(programFiles, "Riot Games", "League of Legends"),
    path.join(programFilesX86, "Riot Games", "League of Legends"),
    "C:\\WeGameApps\\英雄联盟",
    path.join(programFilesX86, "腾讯游戏", "英雄联盟"),
    path.join(programFilesX86, "英雄联盟")
  ];
  if (env.LEAGUE_LOCKFILE_PATH) roots.unshift(path.dirname(env.LEAGUE_LOCKFILE_PATH));
  return uniq(roots);
}

/**
 * Discovered by scanning the usual install parents for folders such as `英雄联盟(26)`.
 *
 * The scan reads four directory listings, and install locations do not change while the app runs,
 * so the result is cached for the session. `env` shapes the parents list, which only varies between
 * processes in practice - the tests import the module fresh per run.
 */
let scannedRootsCache;
async function scannedInstallRoots(env = process.env) {
  if (scannedRootsCache) return scannedRootsCache;
  const parents = [
    env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    env.ProgramFiles ?? "C:\\Program Files",
    "C:\\WeGameApps",
    "C:\\Riot Games"
  ];
  const pattern = /英雄联盟|League of Legends|WeGame|Riot Games|腾讯游戏/i;
  const roots = [];
  for (const parent of uniq(parents)) {
    try {
      const entries = await readdir(parent, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && pattern.test(entry.name)) roots.push(path.join(parent, entry.name));
      }
    } catch {
      /* Missing or unreadable parent is expected on most machines. */
    }
  }
  scannedRootsCache = roots;
  return roots;
}

export async function resolveInstallRoots(env = process.env) {
  return uniq([...(await scannedInstallRoots(env)), ...candidateInstallRoots(env)]).filter(Boolean);
}

async function readLockfileAt(filePath) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseLockfile(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

/** Live PIDs without WMI, so it also works on anti-cheat hardened clients. */
export async function listClientPids() {
  // tasklist starts in ~0.1s; PowerShell needs ~1s of cold start. tasklist answers the question on
  // every machine, so it goes first and PowerShell stays only as a fallback for the rare case where
  // tasklist itself fails.
  const readers = [
    async () => {
      // A tasklist CSV row is `"LeagueClientUx.exe","1234","Console","1","500,000 K"`: only the
      // second column is a PID, so the row is matched rather than scraping every number in it.
      const { stdout } = await execFileAsync("tasklist", [
        "/FI", `IMAGENAME eq ${UX_PROCESS_NAME}`, "/FO", "CSV", "/NH"
      ], { windowsHide: true });
      return [...String(stdout).matchAll(/"LeagueClientUx\.exe"\s*,\s*"(\d+)"/gi)].map((match) => Number(match[1]));
    },
    async () => {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-Command", "(Get-Process -Name LeagueClientUx -ErrorAction SilentlyContinue).Id"
      ], { windowsHide: true });
      return String(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).map(Number);
    }
  ];
  for (const read of readers) {
    try {
      const pids = [...new Set(await read())];
      if (pids.length > 0) return pids;
    } catch {
      /* Try the next tool. */
    }
  }
  return [];
}

/**
 * The client writes its own CEF command line, including the LCU port and token, into
 * `<install>/LeagueClient/<timestamp>_<pid>_LeagueClientUx.log`. Tencent builds keep
 * `lockfile` empty under an exclusive anti-cheat lock, so this is the portable source.
 */
async function fromClientLog(roots, pids) {
  for (const root of roots) {
    const directory = path.join(root, "LeagueClient");
    let entries;
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    const logs = entries.filter((name) => name.endsWith("_LeagueClientUx.log"));
    const ordered = [];
    for (const name of logs) {
      const filePath = path.join(directory, name);
      // File name layout is `<timestamp>_<leagueClientPid>_<uxPid>_LeagueClientUx.log`.
      const uxPid = Number(name.split("_")[2]);
      try {
        ordered.push({ filePath, uxPid, mtime: (await stat(filePath)).mtimeMs });
      } catch {
        /* Ignore files that vanish mid-scan. */
      }
    }
    ordered.sort((a, b) => b.mtime - a.mtime);

    for (const { filePath, uxPid } of ordered) {
      // A stale log from a previous session must not be used for a live client.
      if (pids.length > 0 && !pids.includes(uxPid)) continue;
      const handle = await open(filePath, "r").catch(() => undefined);
      if (!handle) continue;
      let parsed;
      const buffer = Buffer.alloc(LOG_READ_LIMIT);
      try {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        parsed = parseCommandLine(decodeLog(buffer.subarray(0, bytesRead)));
      } catch {
        parsed = undefined;
      } finally {
        await handle.close();
      }
      if (!parsed) continue;
      return { ...parsed, uxPid, source: "client-log", detail: filePath };
    }
  }
  return undefined;
}

async function fromLockfile(roots, env) {
  const candidates = uniq([
    env.LEAGUE_LOCKFILE_PATH,
    ...roots.map((root) => path.join(root, "LeagueClient", "lockfile")),
    ...roots.map((root) => path.join(root, "lockfile"))
  ]);
  for (const filePath of candidates) {
    try {
      return { ...(await readLockfileAt(filePath)), source: "lockfile", detail: filePath };
    } catch {
      /* Try the next candidate. */
    }
  }
  return undefined;
}

async function fromProcessCommandLine() {
  const attempts = [
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoProfile", "-Command", "(Get-Process -Name LeagueClientUx -ErrorAction SilentlyContinue).CommandLine"]],
    ["powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object -First 1 -ExpandProperty CommandLine)"]]
  ];
  for (const [file, args] of attempts) {
    try {
      const { stdout } = await execFileAsync(file, args, { windowsHide: true });
      const parsed = parseCommandLine(String(stdout));
      if (parsed) return { ...parsed, source: "process-command-line", detail: file };
    } catch {
      /* Try the next reader. */
    }
  }
  return undefined;
}

/**
 * Resolves LCU connection parameters from the running client alone - its own log first (Tencent
 * builds keep `lockfile` empty under an exclusive anti-cheat lock), then the lockfile, then the
 * client process command line. Nothing is ever taken from a hand-typed value.
 */
/**
 * A successful discovery is remembered keyed by the process list that produced it: the same
 * LeagueClientUx process always serves the same port and token, so the periodic client-status
 * check can skip the log read and the command-line spawn entirely. A changed pid set (client
 * restarted, or closed) recomputes from scratch, which is exactly when the old answer is invalid.
 */
let discoveryCache;

export async function discoverLcuConnection({ env = process.env, listPids = listClientPids } = {}) {
  const attempts = [];

  const roots = await resolveInstallRoots(env);
  attempts.push(`安装目录候选：${roots.length ? roots.join("；") : "未找到"}`);

  const pids = await listPids();
  attempts.push(pids.length ? `检测到客户端进程 PID：${pids.join(", ")}` : "未检测到 LeagueClientUx.exe 进程");

  // LeagueAkari 的判定基准是活进程：没有任何 LeagueClientUx.exe 在跑时，残留的客户端日志和
  // lockfile 一律不可信——上一次会话的端口和令牌会让状态指示器谎报"已连接"。
  if (pids.length === 0) {
    // 面向用户只说结论和该做什么；目录候选、进程列表这些排障细节留在 attempts 里，
    // 只在悬停"详情"时出现——直接甩给用户一长串安装路径既看不懂也没用。
    const error = new Error("未检测到游戏客户端：请先启动英雄联盟客户端并登录到大厅，然后点「重新检测」。");
    error.fatal = true;
    error.attempts = attempts;
    error.hasClient = false;
    throw error;
  }

  const pidKey = pids.join(",");
  if (discoveryCache?.pidKey === pidKey) return discoveryCache.value;

  // Only a success is cached, so every early return below funnels through `finish`.
  const finish = (result) => {
    discoveryCache = { pidKey, value: result };
    return result;
  };

  const log = await fromClientLog(roots, pids);
  if (log) return finish(log);
  attempts.push("客户端日志中未找到可用的连接参数");

  const lockfile = await fromLockfile(roots, env);
  if (lockfile) return finish(lockfile);
  attempts.push("lockfile 不存在、为空或被反作弊独占锁定");

  // Reading a process command line costs a shell spawn; a client process is known to exist here.
  const commandLine = await fromProcessCommandLine();
  if (commandLine) return finish(commandLine);
  attempts.push("无法读取客户端进程命令行（WMI 被拒绝或需要管理员权限）");

  // Reaching here means a client process exists but none of the three sources yielded parameters -
  // a different problem from "no client at all", with a different fix (permissions, admin rights).
  const error = new Error("客户端已在运行，但读不到连接参数：请确认已登录到大厅，并以普通权限重试（不要管理员身份运行本软件）。");
  error.fatal = true;
  error.attempts = attempts;
  error.hasClient = true;
  throw error;
}
