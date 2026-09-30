#!/usr/bin/env node
/**
 * Verifies that a built portable folder is self-contained.
 *
 * `scripts/build-portable.mjs` runs the same check as part of the build, but it reads the folder **in
 * place** - and in place means inside the checkout, where Node can still walk up and find the
 * repository's own `node_modules`. That is exactly how a portable build missing `ws` was published: the
 * folder looked healthy for as long as it sat next to the source it was built from, and only fell over
 * once a user moved it somewhere else.
 *
 * So this script is meant to be pointed at a folder that has already been moved away from the repository.
 * The check itself is confined to the folder (`findUnresolvedImports` never resolves outside it), which is
 * what makes the result meaningful.
 *
 *   node scripts/verify-portable.mjs <path-to-LeagueHextech-folder>
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { findUnresolvedImports } from "./portable-deps.mjs";

const target = process.argv[2];
if (!target) {
  console.error("用法：node scripts/verify-portable.mjs <免安装版文件夹>");
  process.exit(2);
}

const root = path.resolve(target);
const appRoot = path.join(root, "resources", "app");

const present = await stat(appRoot).then(() => true, () => false);
if (!present) {
  console.error(`不是有效的免安装版文件夹（缺少 resources/app）：${root}`);
  process.exit(2);
}

const missing = await findUnresolvedImports({ appRoot });
if (missing.length > 0) {
  console.error(`免安装版缺少运行时代码依赖：${missing.join("、")}`);
  console.error("这个文件夹在别人机器上会在窗口出现之前就崩溃。请检查 scripts/portable-deps.mjs 的解析规则。");
  process.exit(1);
}

console.log(`免安装版自包含检查通过：${root}`);
