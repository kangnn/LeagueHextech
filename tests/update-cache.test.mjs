/**
 * Verifies the update-cache cleanup that keeps differential (incremental) updates working.
 *
 * Why this exists: electron-updater prefers the blockmap cached at `<cacheDir>/current.blockmap`
 * over the real blockmap of the installed version. Once that cache describes a *different* build
 * than `<cacheDir>/installer.exe`, every differential attempt copies blocks out of the wrong
 * offsets and dies with "sha512 checksum mismatch" - a 92 MB download where 780 KB would do. The
 * real 0.1.6-ci.56 -> 0.1.6-ci.57 rebuild was reproduced byte-for-byte from that cache over the
 * module under test here, so the assertions below guard the one thing that keeps it honest: the
 * cached blockmaps are gone, and nothing that still has a use is.
 *
 * Runs in plain Node against a scratch directory - no Electron, no updater, no network.
 */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetStaleUpdateCache } from "../src/update-cache.mjs";

let failures = 0;
const check = (name, condition, detail = "") => {
  if (condition) console.log("PASS", name);
  else { failures += 1; console.log("FAIL", name, detail); }
};

const exists = async (file) => stat(file).then(() => true, () => false);

/** A scratch updater cache laid out the way electron-updater leaves one. */
async function makeCache() {
  const dir = await mkdtemp(path.join(tmpdir(), "lh-update-cache-"));
  await mkdir(path.join(dir, "pending"), { recursive: true });
  await writeFile(path.join(dir, "installer.exe"), "the installer that is actually installed");
  await writeFile(path.join(dir, "current.blockmap"), "a blockmap of some older build");
  await writeFile(path.join(dir, "pending", "current.blockmap"), "the blockmap of a build never installed");
  await writeFile(path.join(dir, "pending", "temp-LeagueHextech-Setup-1.2.0.exe"), "partial download");
  await writeFile(path.join(dir, "pending", "temp-LeagueHextech-Setup-1.1.0.exe"), "partial download");
  await writeFile(path.join(dir, "pending", "LeagueHextech-Setup-1.3.0.exe"), "a finished download");
  await writeFile(path.join(dir, "pending", "update-info.json"), "{\"fileName\":\"LeagueHextech-Setup-1.3.0.exe\"}");
  return dir;
}

const updaterFor = (cacheDir) => ({ getOrCreateDownloadHelper: async () => ({ cacheDir }) });

/* ---------- the stale blockmaps go, everything with a use stays ---------- */
{
  const dir = await makeCache();
  const removed = await resetStaleUpdateCache(updaterFor(dir));

  check("缓存里的旧 blockmap 被清掉（否则差分按错误偏移拼文件）",
    await exists(path.join(dir, "current.blockmap")) === false);
  check("pending 里那份也要清（它会被拷回上面的位置，等于没清）",
    await exists(path.join(dir, "pending", "current.blockmap")) === false);
  check("差分基准 installer.exe 必须原样保留",
    await exists(path.join(dir, "installer.exe")) === true);
  check("下载了一半的临时安装器被清掉（没人会续传）",
    await exists(path.join(dir, "pending", "temp-LeagueHextech-Setup-1.2.0.exe")) === false &&
    await exists(path.join(dir, "pending", "temp-LeagueHextech-Setup-1.1.0.exe")) === false);
  check("已下载完成等待安装的包保留（否则点「稍后」再装还要重下 92MB）",
    await exists(path.join(dir, "pending", "LeagueHextech-Setup-1.3.0.exe")) === true);
  check("它配套的记账文件也保留",
    await exists(path.join(dir, "pending", "update-info.json")) === true);
  check("返回值列出被清掉的路径，方便日志与排查",
    removed.length === 4 && removed.every((file) => !file.endsWith("installer.exe")),
    JSON.stringify(removed));
  await rm(dir, { recursive: true, force: true });
}

/* ---------- a first run has nothing to clear and must not throw ---------- */
{
  const dir = await mkdtemp(path.join(tmpdir(), "lh-update-cache-empty-"));
  await writeFile(path.join(dir, "installer.exe"), "installed");
  const warnings = [];
  const removed = await resetStaleUpdateCache(updaterFor(dir), { warn: (m) => warnings.push(m) });
  check("首次运行（还没有任何缓存）不报错，只是无事可做",
    removed.length === 0 && warnings.length === 0, JSON.stringify({ removed, warnings }));
  check("没有 pending 目录也不影响 installer.exe",
    await exists(path.join(dir, "installer.exe")) === true);
  await rm(dir, { recursive: true, force: true });
}

/* ---------- a failing cleanup is reported, never thrown ---------- */
{
  const warnings = [];
  const broken = { getOrCreateDownloadHelper: async () => { throw new Error("app-update.yml 读不出来"); } };
  const removed = await resetStaleUpdateCache(broken, { warn: (m) => warnings.push(m) });
  check("清理失败降级成一条提示，不让启动链炸掉",
    removed.length === 0 && warnings.length === 1 && warnings[0].includes("app-update.yml"),
    JSON.stringify(warnings));
  // Portable builds answer undefined for the helper; that is "no updater", not an error.
  const noneRemoved = await resetStaleUpdateCache(undefined, {});
  check("没有更新器时静默返回", noneRemoved.length === 0);
}

/* ---------- main.mjs must actually wire it in, before any download can start ---------- */
{
  const main = await readFile(new URL("../src/main.mjs", import.meta.url), "utf8");
  check("主进程导入了这张清理逻辑",
    /import \{ resetStaleUpdateCache \} from "\.\/update-cache\.mjs";/.test(main));
  const callAt = main.indexOf("resetStaleUpdateCache(updater");
  const autoDownloadAt = main.indexOf("updater.autoDownload = false");
  const listenerAt = main.indexOf('updater.on("checking-for-update"');
  check("清理接在更新器就绪之后、且早于任何检查（事件监听之前）",
    callAt !== -1 && autoDownloadAt !== -1 && listenerAt !== -1 && callAt > autoDownloadAt && callAt < listenerAt,
    `autoDownload=${autoDownloadAt} call=${callAt} listener=${listenerAt}`);
  check("清理不被 await，启动不会等它",
    /resetStaleUpdateCache\(updater[\s\S]{0,200}?\.catch\(\(\) => \{\}\)/.test(main));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
