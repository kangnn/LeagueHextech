/**
 * Verifies the tray icon and the close-to-tray wiring.
 *
 * The icon is generated base64 inside a module, so a mistake there would silently produce no tray icon
 * at all - the PNG is therefore decoded and its pixels checked, not just its presence.
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The project root is one level up from this file.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { TRAY_ICON_16, TRAY_ICON_32 } = await import(new URL("../src/tray-icon.mjs", import.meta.url).href);

let failures = 0;
const check = (name, condition, detail = "") => {
  if (condition) console.log("PASS", name);
  else { failures += 1; console.log("FAIL", name, detail); }
};

/** Decodes a base64 PNG far enough to read its size and RGBA pixels back out. */
function decodePng(base64) {
  const buffer = Buffer.from(base64, "base64");
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error("not a PNG");

  let offset = 8;
  let header;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = data;
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  return {
    width,
    height,
    pixel(x, y) {
      const start = y * stride + 1 + x * 4;
      return { r: raw[start], g: raw[start + 1], b: raw[start + 2], a: raw[start + 3] };
    }
  };
}

const png16 = decodePng(TRAY_ICON_16);
const png32 = decodePng(TRAY_ICON_32);
check("the 16px icon decodes", png16.width === 16 && png16.height === 16, `${png16.width}x${png16.height}`);
check("the 32px icon decodes", png32.width === 32 && png32.height === 32, `${png32.width}x${png32.height}`);

const RING_CYAN = { r: 76, g: 194, b: 224 };
const CORE_GOLD = { r: 200, g: 170, b: 110 };
const near = (pixel, expected, tolerance = 6) =>
  Math.abs(pixel.r - expected.r) <= tolerance && Math.abs(pixel.g - expected.g) <= tolerance && Math.abs(pixel.b - expected.b) <= tolerance;

check("the corner is transparent (a flat square reads as a blob in the tray)",
  png32.pixel(0, 0).a === 0, JSON.stringify(png32.pixel(0, 0)));
check("the centre is the gold core", near(png32.pixel(16, 16), CORE_GOLD), JSON.stringify(png32.pixel(16, 16)));
check("the hextech ring is cyan",
  near(png32.pixel(16, 5), RING_CYAN), JSON.stringify(png32.pixel(16, 5)));
check("the gap between the ring and the core stays open",
  png32.pixel(16, 10).a === 0, JSON.stringify(png32.pixel(16, 10)));

// The icon is an outline, so most pixels are intentionally empty; this only guards against the drawing
// collapsing into nothing or flooding into a solid block.
let opaque = 0;
for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) if (png16.pixel(x, y).a > 200) opaque += 1;
check("the 16px icon still has enough ink to read", opaque > 40 && opaque < 150, String(opaque));
check("the two sizes are different drawings", TRAY_ICON_16 !== TRAY_ICON_32);

/* ---------- the exe icon container ---------- */
// Windows takes the exe's icon out of this file, so a malformed container silently means an unbranded
// download - exactly what makes an unsigned binary look untrustworthy.
const ico = readFileSync(path.join(root, "pictures", "icon.ico"));
check("the ico opens with an icon directory header",
  ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1, `${ico.readUInt16LE(0)}/${ico.readUInt16LE(2)}`);
const icoCount = ico.readUInt16LE(4);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const icoSizes = [];
let icoEntriesOk = true;
for (let i = 0; i < icoCount; i += 1) {
  const at = 6 + i * 16;
  const width = ico[at] === 0 ? 256 : ico[at];
  const length = ico.readUInt32LE(at + 8);
  const offset = ico.readUInt32LE(at + 12);
  icoSizes.push(width);
  if (!ico.subarray(offset, offset + 4).equals(PNG_SIGNATURE)) icoEntriesOk = false;
  if (offset + length > ico.length) icoEntriesOk = false;
}
check("it carries the sizes Explorer, the taskbar and Alt-Tab ask for",
  icoSizes.join("/") === "16/24/32/48/64/128/256", icoSizes.join("/"));
check("every entry is an in-bounds PNG payload", icoEntriesOk, icoSizes.join("/"));

const build = readFileSync(path.join(root, "scripts", "build-portable.mjs"), "utf8");
check("the build writes the icon into the exe", /applyBranding\(appExe/.test(build));
check("the build points rcedit at the generated ico", /"pictures", "icon\.ico"/.test(build));
check("the build also stamps product and file version", /"product-version"/.test(build) && /"file-version"/.test(build));
check("a missing rcedit only warns instead of failing the build", /跳过 exe 图标/.test(build));

/* ---------- the portable build ships its runtime dependencies ---------- */
// Regression: the folder was assembled by hand with a copy of `src/` and no `node_modules`, which was
// fine until `src/lcu-websocket.mjs` began importing `ws`. `src/main.mjs` imports that module at the top
// level, so every portable build died with ERR_MODULE_NOT_FOUND before a window could open - and the bug
// was invisible in the repository, because Node finds the repo's own `node_modules` when resolving from
// `src/`. These checks assert the resolution rule itself, and that the built folder is not left to luck.
const { collectPortablePackages, createPackageLocator, PORTABLE_OMITTED, findUnresolvedImports,
  RUNTIME_PROVIDED_SPECIFIERS, GUARDED_OPTIONAL_SPECIFIERS } =
  await import(new URL("../scripts/portable-deps.mjs", import.meta.url).href);

check("the build copies the runtime dependencies into the folder",
  /collectPortablePackages\(/.test(build) && /node_modules/.test(build));

// The shipped-import check must not excuse whatever the omission list happens to contain: deriving its
// exemptions from `PORTABLE_OMITTED` made it circular, so a build missing `ws` passed its own check.
check("the shipped-import check does not derive its exemptions from the omission list",
  GUARDED_OPTIONAL_SPECIFIERS.join() === "electron-updater" &&
  !GUARDED_OPTIONAL_SPECIFIERS.some((name) => name === "ws"),
  JSON.stringify(GUARDED_OPTIONAL_SPECIFIERS));
check("ws is never treated as safe to omit", !PORTABLE_OMITTED.includes("ws"));
check("electron is exempt because the runtime supplies it, not because it is omitted",
  RUNTIME_PROVIDED_SPECIFIERS.includes("electron"));

// The check itself has to actually notice a missing package. `exists` is injected so this runs without
// building the whole folder.
const scanRoot = path.join(root, "src");
const everythingMissing = await findUnresolvedImports({ appRoot: root, exists: async () => false });
check("the shipped-import check reports a package that is not in the folder",
  everythingMissing.some((entry) => entry.startsWith("ws（")), JSON.stringify(everythingMissing));
check("it does not report node builtins as missing packages",
  !everythingMissing.some((entry) => /^node:/.test(entry)), JSON.stringify(everythingMissing.slice(0, 5)));
check("it does not report the guarded updater as missing",
  !everythingMissing.some((entry) => entry.startsWith("electron-updater（")), JSON.stringify(everythingMissing));
const everythingPresent = await findUnresolvedImports({ appRoot: root, exists: async () => true });
check("a complete folder reports nothing missing", everythingPresent.length === 0, JSON.stringify(everythingPresent));
check("the check only scans the app's own source, not node_modules",
  scanRoot.endsWith("src") && /await visit\(path\.join\(appRoot, "src"\)\)/.test(
    readFileSync(path.join(root, "scripts", "portable-deps.mjs"), "utf8")));

// The CI step points this script at a folder moved OUT of the checkout, because the build's own check
// reads it in place - where the repository's node_modules can still satisfy a missing package.
const verifyScript = readFileSync(path.join(root, "scripts", "verify-portable.mjs"), "utf8");
check("a standalone verifier exists for a folder moved out of the checkout",
  /findUnresolvedImports/.test(verifyScript) && /resources.*app/.test(verifyScript));
check("the verifier fails the build rather than warning",
  /process\.exit\(1\)/.test(verifyScript) && /缺少运行时代码依赖/.test(verifyScript));
check("the release workflow moves the folder away before verifying it",
  /Move-Item "\$PWD\/dist\/LeagueHextech" \$probe/.test(
    readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8")));

// Every declared runtime dependency must arrive, not just the one that happens to be imported today.
const pkgForBuild = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const planned = await collectPortablePackages({
  dependencies: pkgForBuild.dependencies,
  locate: async (name) => {
    const versions = { ws: "8.22.0", "electron-updater": "6.8.9" };
    if (!(name in versions)) throw new Error(`ENOENT ${name}`);
    return { manifest: { version: versions[name], dependencies: {} }, dir: `/nm/${name}` };
  }
});
check("every declared runtime dependency is planned into the folder",
  Object.keys(pkgForBuild.dependencies).every((name) => planned.has(name) || PORTABLE_OMITTED.includes(name)),
  JSON.stringify([...planned.keys()]));
check("ws - the package whose absence crashed the app - is planned",
  planned.has("ws"), JSON.stringify([...planned.keys()]));
check("electron-updater is deliberately left out of the portable folder",
  PORTABLE_OMITTED.includes("electron-updater") && !planned.has("electron-updater"),
  JSON.stringify([...planned.keys()]));
check("the planned manifest records the real version, not a placeholder",
  planned.get("ws")?.version === "8.22.0", String(planned.get("ws")?.version));

// Transitive dependencies have to be followed, or a future package with its own deps ships broken.
const transitive = await collectPortablePackages({
  dependencies: { outer: "1.0.0" },
  omitted: [],
  locate: async (name) => ({
    manifest: name === "outer"
      ? { version: "1.0.0", dependencies: { inner: "^2.0.0" } }
      : { version: "2.3.4", dependencies: {} },
    dir: `/nm/${name}`
  })
});
check("a dependency's own dependencies are followed too",
  transitive.has("outer") && transitive.get("inner")?.version === "2.3.4", JSON.stringify([...transitive.keys()]));

// A package that is declared but not installed must stop the build with a sentence, not produce a
// folder that starts and then cannot import.
const missing = await collectPortablePackages({
  dependencies: { ghost: "1.0.0" },
  omitted: [],
  locate: async () => { throw new Error("ENOENT"); }
}).then(() => null, (error) => error);
check("a declared but uninstalled dependency fails the build loudly",
  missing instanceof Error && /ghost/.test(missing.message), String(missing?.message));

// The locator has to resolve like Node, including a dependency npm left nested under another package.
const locateNested = createPackageLocator({
  projectRoot: path.join(path.sep, "app"),
  readManifest: async (dir) => {
    if (dir === path.join(path.sep, "app", "node_modules", "outer", "node_modules", "nested")) {
      return { version: "9.9.9" };
    }
    throw new Error("ENOENT");
  }
});
const nested = await locateNested("nested", path.join(path.sep, "app", "node_modules", "outer"))
  .then((r) => r.manifest, () => null);
check("a nested dependency is found instead of reported missing", nested?.version === "9.9.9", JSON.stringify(nested));

check("the build refuses to ship a folder with no runtime dependencies at all",
  /没有解析到任何运行时依赖/.test(build));
check("the shipped manifest declares the copied dependencies",
  /dependencies: Object\.fromEntries/.test(build));

/* ---------- wiring ---------- */
const main = readFileSync(path.join(root, "src", "main.mjs"), "utf8");
const renderer = readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");
const controllerSource = readFileSync(path.join(root, "src", "search-controller.mjs"), "utf8");

check("a tray is created", /new Tray\(createTrayImage\(\)\)/.test(main));
check("the icon is supplied at both scale factors",
  /scaleFactor: 1,[\s\S]{0,120}TRAY_ICON_16/.test(main) && /scaleFactor: 2,[\s\S]{0,120}TRAY_ICON_32/.test(main));
check("closing the window hides it instead of destroying it",
  /window\.on\("close", \(event\) => \{[\s\S]{0,200}preventDefault\(\)[\s\S]{0,120}window\.hide\(\)/.test(main));
check("the close handler still lets a real quit through", /if \(isQuitting\) return;/.test(main));
check("quitting is flagged before the window closes", /app\.on\("before-quit", \(\) => \{\s*isQuitting = true;/m.test(main));
check("the tray has a context menu with a quit entry",
  /setContextMenu/.test(main) && /label: "退出"/.test(main));
check("the tray can start and stop the search", /label: running \? "停止搜索" : "开始搜索"/.test(main));
check("the tray can bring the window back", /label: "显示主窗口", click: showWindow/.test(main));
check("left-clicking the tray toggles the window", /tray\.on\("click", toggleWindow\)/.test(main));
check("the tray tooltip follows the search state", /tray\.setToolTip\(/.test(main));
check("the tray menu is not rebuilt on every single event", /if \(signature === traySignature\) return;/.test(main));
check("a second launch focuses the running window instead of duplicating the searcher",
  /requestSingleInstanceLock/.test(main) && /"second-instance", showWindow/.test(main));
check("the app does not quit while it is only hiding", /if \(!isQuitting\) return;/.test(main));
check("the window is only disposed on a real quit", /lcuFetch\?\.dispose\?\.\(\)/.test(main));
check("a tray failure cannot take the search down", /托盘图标创建失败/.test(main));
check("the default Electron menu bar is removed", /Menu\.setApplicationMenu\(null\)/.test(main));
check("the tray headline reports the rooms that qualified, not the whole browser list",
  /合格 \$\{status\.eligibleCount\}/.test(main));
// The footer hint was removed on request: the tray behaviour is discoverable from the tray itself, and
// the line was just noise above the log.
check("no footer hint is rendered any more", !/缩到托盘/.test(renderer));

/* ---------- settings actually reach the controller ---------- */
// Regression guard: the controller was constructed with the policy only, so a saved stall timeout was
// ignored from startup and the tool sat in a half-empty room as if the player floor did not exist.
check("the saved stall timeout is handed to the controller",
  /stallTimeoutMs: settings\.settings\.stallTimeoutMs/.test(main));
check("the settings panel still exposes the stall timeout", /id="stallTimeoutSec"/.test(renderer));
check("the stall explanation still says 0 means no waiting", /填 0 = 不等待/.test(renderer));
check("the mode setting is gone from the UI", !/modePolicy/.test(renderer));

// Regression guard: the 「继续搜索」 handler guarded on `state !== "idle"`, but `leave()` stops the
// search before it asks the client, so a failed DELETE also ended at `idle` and the guard let the new
// search re-adopt the very room the user asked to leave. The guard must key off the leave verdict.
check("restart keys off whether the leave actually happened, not off the state",
  /if \(!afterLeave\.left\) return afterLeave;/.test(main) && !/afterLeave\.state !== "idle"/.test(main));
check("a leave reports its verdict rather than only the state",
  /return \{ \.\.\.this\.status\(\), left: true \}/.test(controllerSource) &&
  /return \{ \.\.\.this\.status\(\), left: false \}/.test(controllerSource));

/* ---------- the updater wiring ---------- */
// The updater must never be able to stop the app from starting: electron-updater only exists in the
// installed build, and the portable folder has no node_modules at all.
const preload = readFileSync(path.join(root, "src", "preload.cjs"), "utf8");
const builder = readFileSync(path.join(root, "electron-builder.yml"), "utf8");
const workflow = readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

check("electron-updater is a runtime dependency, so it is bundled into the installed app",
  Boolean(pkg.dependencies?.["electron-updater"]), JSON.stringify(pkg.dependencies));
check("electron-builder is only a development dependency",
  Boolean(pkg.devDependencies?.["electron-builder"]) && !pkg.dependencies?.["electron-builder"]);
check("the updater is loaded lazily and its absence is tolerated",
  /await import\("electron-updater"\)/.test(main) && /catch \{[\s\S]{0,200}portable/i.test(main));
check("a development run does not pretend to have an updater", /if \(!app\.isPackaged\) return undefined;/.test(main));
check("a downloaded update can be applied on request", /quitAndInstall/.test(main));
check("updates are checked at startup and twice a day",
  /scheduleUpdateCheck\(\)/.test(main) && /6 \* 60 \* 60 \* 1000/.test(main));
check("the tray offers the restart-and-update entry", /重启并更新到 v\$\{updateState\.version\}/.test(main));
check("the renderer can check, apply and read update state",
  /updates:check/.test(main) && /updates:install/.test(main) && /updates:status/.test(main) &&
  /updateStatus: \(\) => ipcRenderer\.invoke\("updates:status"\)/.test(preload) &&
  /installUpdate: \(\) => ipcRenderer\.invoke\("updates:install"\)/.test(preload));
check("the installed app knows where to look for updates",
  /provider: github/.test(builder) && /repo: LeagueHextech/.test(builder));
check("the installer is an nsis build with a chosen install directory",
  /target: nsis/.test(builder) && /allowToChangeInstallationDirectory: true/.test(builder));
check("uninstalling keeps the user's settings", /deleteAppDataOnUninstall: false/.test(builder));
check("latest.yml is only published with a stable release",
  /release\/latest\.yml/.test(workflow) && /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(workflow));
check("the dev channel publishes prereleases only",
  /--prerelease/.test(workflow) && /if: \$\{\{ !startsWith\(github\.ref, 'refs\/tags\/v'\) \}\}/.test(workflow));
check("a tag that disagrees with package.json fails the build",
  /does not match package\.json/.test(workflow));

/* ---------- the updater must never be able to break startup ---------- */
// 0.1.1 shipped a window that could do nothing: `import("electron-updater")` has no `autoUpdater` named
// export under ESM, the resulting `undefined.autoDownload = true` threw, and because the setup ran before
// the IPC handlers were registered, every button answered "No handler registered".
const { resolveAutoUpdater } = await import(new URL("../src/updater-loader.mjs", import.meta.url).href);
const fakeUpdater = { on: () => {} };
check("autoUpdater is found on the default export (the shape ESM actually provides)",
  resolveAutoUpdater({ default: { autoUpdater: fakeUpdater } }) === fakeUpdater);
check("autoUpdater is still found as a named export (the CommonJS shape)",
  resolveAutoUpdater({ autoUpdater: fakeUpdater }) === fakeUpdater);
check("a module without autoUpdater resolves to nothing instead of throwing",
  resolveAutoUpdater({ AppUpdater: class {} }) === undefined && resolveAutoUpdater(undefined) === undefined);

const startHandlerAt = main.indexOf('ipcMain.handle("search:start"');
const updaterCallAt = main.indexOf("\n    setUpdates()");
check("the window's IPC handlers are registered before the updater is touched",
  startHandlerAt !== -1 && updaterCallAt !== -1 && startHandlerAt < updaterCallAt,
  `handler=${startHandlerAt} updater=${updaterCallAt}`);
check("the updater setup is not awaited, so it cannot stall or abort startup",
  !/await setUpdates\(\)/.test(main) && /setUpdates\(\)[\s\S]{0,120}\.catch\(/.test(main));
check("a missing autoUpdater is treated as 'no updater' rather than as an error",
  /if \(!updater\) return undefined;/.test(main));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
