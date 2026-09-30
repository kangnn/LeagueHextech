#!/usr/bin/env node
/**
 * Builds a double-clickable portable folder from the Electron distribution that `npm install`
 * already downloaded. No installer, no extra tooling, no network access.
 *
 * The result has the same shape as any packaged Electron app:
 *
 *   dist/LeagueHextech/LeagueHextech.exe   <- double click this
 *   dist/LeagueHextech/resources/app/...   <- this tool's own code
 *
 * Electron loads `<exe dir>/resources/app` when it exists, so replacing the bundled
 * `default_app.asar` with the app folder is all a portable build needs.
 */
import { cp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectPortablePackages, createPackageLocator, findUnresolvedImports } from "./portable-deps.mjs";

const APP_NAME = "LeagueHextech";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDist = path.join(projectRoot, "node_modules", "electron", "dist");
const distRoot = path.join(projectRoot, "dist");
const outputRoot = path.join(distRoot, APP_NAME);
const appRoot = path.join(outputRoot, "resources", "app");

/** Refuses to delete anything that is not the build output inside this project. */
function assertInsideDist(target) {
  const relative = path.relative(distRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`拒绝操作 dist 之外的路径：${target}`);
  }
}

async function directorySize(target) {
  let total = 0;
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    total += entry.isDirectory() ? await directorySize(child) : (await stat(child)).size;
  }
  return total;
}

/**
 * Writes the app icon and version metadata into the exe itself.
 *
 * The Electron runtime ships with its own logo and no product information, so without this step the
 * download is an unsigned file called LeagueHextech.exe that still wears the Electron logo - precisely the
 * combination that makes Windows and users distrust it. `rcedit` is the tool LeagueAkari uses for the same
 * job. It is a devDependency, so a machine without it still produces a working build, just an unbranded one.
 */
async function applyBranding(exePath, version) {
  try {
    const { rcedit } = await import("rcedit");
    await rcedit(exePath, {
      icon: path.join(projectRoot, "pictures", "icon.ico"),
      "product-version": `${version}.0`,
      "file-version": `${version}.0`,
      "version-string": {
        ProductName: APP_NAME,
        FileDescription: "LeagueHextech · 海克斯乱斗 5v5 房间搜索器",
        CompanyName: "LeagueHextech",
        LegalCopyright: "非官方粉丝工具，与 Riot Games 无关"
      }
    });
    console.log("已写入 exe 图标与版本信息。");
  } catch (error) {
    console.warn(`跳过 exe 图标与版本信息：rcedit 不可用（${error?.code ?? error?.message}）。`);
    console.warn("  执行 npm install 后重新打包即可带上图标。");
  }
}

/**
 * Proves the assembled folder can actually load itself.
 *
 * Copying `src/` and hoping is what produced a portable build that died with ERR_MODULE_NOT_FOUND before
 * a window opened - and the repository could not show it, because Node resolves `ws` out of the repo's own
 * `node_modules` when it walks up from `src/`. `findUnresolvedImports` confines its search to the copied
 * folder for exactly that reason, so this check sees what the user will get rather than what the clone
 * happens to provide.
 */
async function assertShippedImportsResolve(appRoot) {
  const missing = await findUnresolvedImports({ appRoot });
  if (missing.length > 0) {
    throw new Error(`产物缺少运行时代码依赖：${missing.join("、")}。请检查 scripts/portable-deps.mjs 的解析规则。`);
  }
}

async function main() {
  try {
    await stat(path.join(electronDist, "electron.exe"));
  } catch {
    throw new Error("找不到 Electron 运行时，请先执行 npm install。");
  }

  assertInsideDist(outputRoot);
  console.log(`清理旧产物：${path.relative(projectRoot, outputRoot)}`);
  await rm(outputRoot, { recursive: true, force: true });

  console.log("复制 Electron 运行时…");
  await cp(electronDist, outputRoot, { recursive: true });

  // The bundled placeholder app must go, otherwise it could be picked up instead of this one.
  await rm(path.join(outputRoot, "resources", "default_app.asar"), { force: true });

  console.log("写入应用代码…");
  await cp(path.join(projectRoot, "src"), path.join(appRoot, "src"), { recursive: true });
  const projectPackage = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

  // The runtime dependencies travel with the code. Without this the folder looks complete and then dies
  // at startup: `src/lcu-websocket.mjs` imports `ws`, and `src/main.mjs` imports that at the top level,
  // so a missing package is not a degraded feature - it is ERR_MODULE_NOT_FOUND before any window opens.
  // In the repository the bug cannot reproduce, because Node walks up out of `src/` into the repo's own
  // `node_modules`; it only shows up once the folder is moved, which is how a user runs it.
  const packages = await collectPortablePackages({
    dependencies: projectPackage.dependencies ?? {},
    locate: createPackageLocator({
      projectRoot,
      readManifest: async (dir) => JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"))
    })
  });
  for (const [name, { version, dir }] of packages) {
    await cp(dir, path.join(appRoot, "node_modules", name), { recursive: true });
    console.log(`  依赖 ${name}@${version}`);
  }
  if (packages.size === 0) console.warn("  警告：没有解析到任何运行时依赖，产物可能无法启动。");

  // A minimal manifest: the packaged app needs only its own entry point and the dependencies copied
  // above. `electron-updater` is deliberately absent (see scripts/portable-deps.mjs): the updater import
  // in main.mjs is guarded, and a portable copy has no installation directory to update in place.
  const appPackage = {
    name: projectPackage.name,
    version: projectPackage.version,
    description: projectPackage.description,
    main: "src/main.mjs",
    type: "module",
    dependencies: Object.fromEntries(
      [...packages].map(([name, { version }]) => [name, version ? `^${version}` : "*"])
    )
  };
  await writeFile(path.join(appRoot, "package.json"), `${JSON.stringify(appPackage, null, 2)}\n`, "utf8");

  // The folder is not "built" until it can load itself; see the helper for why this cannot be left to
  // a test run from inside the repository.
  await assertShippedImportsResolve(appRoot);
  console.log("  已校验：产物的所有 import 都能在文件夹内部解析。");

  const runtimeExe = path.join(outputRoot, "electron.exe");
  const appExe = path.join(outputRoot, `${APP_NAME}.exe`);
  await rename(runtimeExe, appExe);
  await applyBranding(appExe, projectPackage.version);

  const megabytes = ((await directorySize(outputRoot)) / 1_048_576).toFixed(1);
  console.log("");
  console.log("打包完成，双击即可运行（不需要 Node、不需要 npm start）：");
  console.log(`  ${appExe}`);
  console.log(`  体积 ${megabytes} MB，整个 ${APP_NAME} 文件夹可以随意移动或发给别人。`);
  console.log("");
  console.log("说明：应用窗口标题、设置与日志位置都不受影响。");
}

await main();
