/**
 * Makes electron-updater's differential (incremental) download trustworthy again.
 *
 * A differential update rebuilds the new installer by **copying unchanged blocks out of the old
 * installer** plus downloading the changed ranges. Where the old blocks live in the old file comes
 * from the *old version's blockmap*, and the copy source is `<updaterCacheDir>/installer.exe` - the
 * copy of itself that the NSIS installer drops there on every install. Those two have to describe
 * the **same build**.
 *
 * electron-updater keeps its own copy of that blockmap at `<updaterCacheDir>/current.blockmap` and
 * prefers it over the real one for the installed version. The cached copy is only refreshed when a
 * differential attempt gets as far as downloading the new blockmap, so it silently goes stale
 * whenever the installed build changes without that happening - a manual install from the release
 * page, or an attempt that downloaded but was never installed. A stale blockmap has the old file's
 * *layout* wrong, so the copied blocks come out of the wrong offsets and the rebuilt installer fails
 * its own integrity check: "Cannot download differentially, fallback to full download: sha512
 * checksum mismatch".
 *
 * Dropping the cache costs one ~95 KB request and makes the updater fetch the blockmap of the
 * version that is actually installed - which always matches `installer.exe`. Measured on the real
 * 0.1.6-ci.56 -> 0.1.6-ci.57 pair: with the stale cache the rebuild mismatched after 0 bytes of
 * savings; with the correct blockmap it matched exactly while downloading 780 KB instead of 92 MB.
 *
 * `pending/current.blockmap` is cleared too, and for a reason: it is what gets copied into
 * `current.blockmap` when an update finishes downloading, so leaving a stale one behind would
 * re-introduce the very cache this function just removed. Partially downloaded installers
 * (`pending/temp-*.exe`) are dead weight nobody ever resumes, so they go as well - they had piled
 * up to tens of megabytes here. A **completed** download in `pending/` is deliberately kept: it is
 * what lets "later" reinstall without downloading the whole package again.
 */
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * @param updater the resolved electron-updater instance.
 * @param {{ warn?: (message: string) => void }} [hooks] where a failure is reported; cleanup must
 *   never break startup, so every error is swallowed into that callback.
 * @returns {Promise<string[]>} the paths that were actually removed (useful for logging and tests).
 */
export async function resetStaleUpdateCache(updater, hooks = {}) {
  const warn = hooks.warn ?? (() => {});
  try {
    // Reaching for the updater's own helper keeps the directory identical to the one electron-updater
    // will read; duplicating the rule here (LOCALAPPDATA + `updaterCacheDirName` from app-update.yml)
    // is exactly how the two silently drift apart.
    const helper = await updater?.getOrCreateDownloadHelper?.();
    const cacheDir = helper?.cacheDir;
    if (!cacheDir) return [];
    const removed = [];
    // Only files that are really there are reported: on a first run there is nothing to clear, and a
    // cleanup log that names files it never saw is worse than no log.
    const drop = async (file) => {
      const there = await stat(file).then(() => true, () => false);
      if (!there) return false;
      // `force` keeps a race (something else removed it in between) from throwing.
      await rm(file, { force: true });
      removed.push(file);
      return true;
    };
    for (const file of [path.join(cacheDir, "current.blockmap"), path.join(cacheDir, "pending", "current.blockmap")]) {
      await drop(file);
    }
    // A missing `pending/` is normal (nothing was ever downloaded); a name that cannot be read is not
    // worth failing over either.
    for (const name of await readdir(path.join(cacheDir, "pending")).catch(() => [])) {
      if (!name.startsWith("temp-")) continue;
      await drop(path.join(cacheDir, "pending", name));
    }
    return removed;
  } catch (error) {
    warn(`无法清理更新缓存：${error?.message ?? error}`);
    return [];
  }
}
