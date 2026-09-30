/**
 * Works out which runtime packages the portable build has to ship.
 *
 * The portable folder is assembled by hand (`scripts/build-portable.mjs`) rather than by
 * electron-builder, so nothing bundles its `dependencies` for it: the folder used to contain a copy of
 * `src/` and nothing else. That was fine until `src/lcu-websocket.mjs` started importing `ws`, at which
 * point every portable build died at startup with ERR_MODULE_NOT_FOUND - `src/main.mjs` imports that
 * module at the top level, so the failure took the whole app down before a window ever appeared. The
 * bug was invisible in the repository, because Node finds the repo's own `node_modules` when walking up
 * from `src/`; it only appeared once the folder was moved somewhere else, which is exactly how a user
 * runs it.
 *
 * The rule is "ship what the app declares as a runtime dependency", walked transitively - plus one
 * deliberate exception, `electron-updater`, which the portable build must *not* contain. Its absence is
 * load-bearing: the updater import in `src/main.mjs` is wrapped in a try/catch precisely so that a build
 * with no updater degrades to "download a new version from the release page" instead of trying to
 * replace files it has no installation directory for.
 */
import path from "node:path";
import { builtinModules } from "node:module";

/** Packages the portable folder must not contain; see the module comment for why. */
export const PORTABLE_OMITTED = Object.freeze(["electron-updater"]);

/** Every `node_modules` a lookup from `fromDir` may consult, nearest first (Node's own search order). */
function lookupDirs(projectRoot, fromDir) {
  const dirs = [];
  let dir = fromDir ?? projectRoot;
  for (;;) {
    dirs.push(dir);
    if (dir === projectRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs.map((base) => path.join(base, "node_modules"));
}

/**
 * Builds a package locator that resolves like Node does, so a dependency npm left nested under another
 * package is found rather than mistaken for a missing install. It reports only where it looked; naming
 * the package is the collector's job, so there is exactly one place that words that error.
 *
 * @param {object} options
 * @param {string} options.projectRoot the app root; its `node_modules` is searched last.
 * @param {(dir: string) => Promise<object>} options.readManifest reads a package manifest by directory.
 * @returns {(name: string, fromDir?: string) => Promise<{ manifest: object, dir: string }>}
 */
export function createPackageLocator({ projectRoot, readManifest }) {
  return async (name, fromDir) => {
    const searched = [];
    for (const modulesDir of lookupDirs(projectRoot, fromDir)) {
      const candidate = path.join(modulesDir, name);
      searched.push(candidate);
      try {
        return { manifest: await readManifest(candidate), dir: candidate };
      } catch { /* try the next candidate, exactly like Node */ }
    }
    throw new Error(`在 ${searched.join("、")} 均未找到`);
  };
}

/**
 * Resolves the packages to copy, following each package's own `dependencies` so a dependency with
 * dependencies of its own still arrives complete.
 *
 * @param {object} options
 * @param {Record<string, string>} [options.dependencies] the app's `package.json` dependencies.
 * @param {string[]} [options.omitted] packages to leave out even though they are declared.
 * @param {(name: string, fromDir?: string) => Promise<{ manifest: object, dir: string }>} options.locate
 * @returns {Promise<Map<string, { version: string, dir: string }>>} name -> source, in dependency order.
 */
export async function collectPortablePackages({
  dependencies = {},
  omitted = PORTABLE_OMITTED,
  locate
} = {}) {
  if (typeof locate !== "function") throw new Error("collectPortablePackages 需要一个 locate 实现。");
  const skip = new Set(omitted);
  const resolved = new Map();
  const queue = Object.keys(dependencies)
    .filter((name) => !skip.has(name))
    .map((name) => ({ name, fromDir: undefined }));

  while (queue.length > 0) {
    const { name, fromDir } = queue.shift();
    if (resolved.has(name) || skip.has(name)) continue;
    let found;
    try {
      found = await locate(name, fromDir);
    } catch (error) {
      // A folder that starts and then cannot import is far worse than a build that stops with a
      // sentence, so a dependency that is declared but not installed is fatal here, by name.
      throw new Error(`找不到运行时依赖 ${name}，请先执行 npm install（${error?.message ?? error}）。`);
    }
    resolved.set(name, { version: found.manifest?.version ?? "", dir: found.dir });
    for (const nested of Object.keys(found.manifest?.dependencies ?? {})) {
      if (!skip.has(nested) && !resolved.has(nested)) queue.push({ name: nested, fromDir: found.dir });
    }
  }
  return resolved;
}

/** Bare specifiers the app imports; relative paths and builtins are not packages. */
const BARE_IMPORT = /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?["']([^"'.][^"']*)["']/g;
const DYNAMIC_IMPORT = /import\(\s*["']([^"'.][^"']*)["']\s*\)/g;

/**
 * Node's own builtins (`node:fs`, and the bare `fs` form), which are never packages in `node_modules`.
 * Taken from the runtime rather than a hand-written list so it cannot drift.
 */
const BUILTIN_MODULES = new Set(builtinModules);
const isBuiltin = (specifier) =>
  specifier.startsWith("node:") || BUILTIN_MODULES.has(specifier.split("/")[0]);

/** Specifiers the runtime supplies itself, so they are never expected in `node_modules`. */
export const RUNTIME_PROVIDED_SPECIFIERS = Object.freeze(["electron"]);

/**
 * Specifiers whose absence is genuinely safe, because the code that imports them handles it.
 *
 * This list is deliberately **written out literally** rather than derived from `PORTABLE_OMITTED`. Deriving
 * it made the shipped-import check circular: anything wrongly added to the omission list excused itself
 * from the very check meant to catch it, so a build missing `ws` still reported success. Adding a name
 * here is now a separate, deliberate act from deciding not to ship it.
 */
export const GUARDED_OPTIONAL_SPECIFIERS = Object.freeze(["electron-updater"]);

async function defaultExists(target) {
  const { stat } = await import("node:fs/promises");
  return stat(target).then(() => true, () => false);
}

/**
 * Lists the packages the shipped code imports that the folder does not contain.
 *
 * Resolution is deliberately confined to `appRoot`. Node would happily walk *up* out of the folder and
 * find the repository's own `node_modules` - which is exactly how a portable build missing `ws` managed
 * to ship looking healthy, and why a test run from inside the clone proves nothing. A user's extracted
 * folder has nothing above it, so nothing above it may be consulted here.
 *
 * @param {object} options
 * @param {string} options.appRoot the assembled `resources/app` directory.
 * @param {(target: string) => Promise<boolean>} [options.exists] injected for tests.
 * @returns {Promise<string[]>} `包名（文件）` per unresolved import; empty means the folder is sound.
 */
export async function findUnresolvedImports({ appRoot, exists = defaultExists } = {}) {
  const { readdir, readFile } = await import("node:fs/promises");
  const allowed = new Set([...RUNTIME_PROVIDED_SPECIFIERS, ...GUARDED_OPTIONAL_SPECIFIERS]);
  const missing = [];

  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(full); continue; }
      if (!/\.(mjs|cjs)$/.test(entry.name)) continue;
      const text = await readFile(full, "utf8");
      for (const pattern of [BARE_IMPORT, DYNAMIC_IMPORT]) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          const specifier = match[1];
          const name = specifier.startsWith("@")
            ? specifier.split("/").slice(0, 2).join("/")
            : specifier.split("/")[0];
          if (allowed.has(name) || isBuiltin(specifier)) continue;
          if (!(await exists(path.join(appRoot, "node_modules", name)))) {
            missing.push(`${name}（${path.relative(appRoot, full)}）`);
          }
        }
      }
    }
  };

  await visit(path.join(appRoot, "src"));
  return missing;
}
