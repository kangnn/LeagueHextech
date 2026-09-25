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

/* ---------- wiring ---------- */
const main = readFileSync(path.join(root, "src", "main.mjs"), "utf8");
const renderer = readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");

check("a tray is created", /new Tray\(createTrayImage\(\)\)/.test(main));
check("the icon is supplied at both scale factors",
  /scaleFactor: 1,[\s\S]{0,120}TRAY_ICON_16/.test(main) && /scaleFactor: 2,[\s\S]{0,120}TRAY_ICON_32/.test(main));
check("closing the window hides it instead of destroying it",
  /window\.on\("close", \(event\) => \{[\s\S]{0,200}preventDefault\(\)[\s\S]{0,120}window\.hide\(\)/.test(main));
check("the close handler still lets a real quit through", /if \(isQuitting\) return;/.test(main));
check("quitting is flagged before the window closes", /app\.on\("before-quit", \(\) => \{ isQuitting = true; \}\)/.test(main));
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
