#!/usr/bin/env node
/**
 * Draws the tray icon and writes it into `src/tray-icon.mjs` as base64 PNG.
 *
 * The icon is generated rather than shipped as a file so the portable build stays a plain copy of
 * `src/` - and so it works on a machine with no image tooling. Two sizes are drawn independently
 * (16px for 100% Windows scaling, 32px for 2x) instead of downscaling one bitmap, because a hexagon
 * ring turns to mush when it is resampled.
 *
 *   node scripts/make-tray-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(projectRoot, "src", "tray-icon.mjs");

// A cyan hextech ring around a gold core, on a transparent background: a flat coloured square reads as
// a blob in the tray, while an outline holds its shape down to 16px.
const RING = [76, 194, 224];
const CORE = [200, 170, 110];
// Hexagon apothems (distance from centre to a flat side). The gap between the ring and the core is what
// keeps the two shapes readable when the whole icon is only 16 pixels wide.
const RING_OUTER = 12.8;
const RING_INNER = 8.2;
const CORE_APOTHEM = 4.2;
// Hexagon axes at 0deg / 60deg / 120deg. A point is inside the hexagon when every projection is
// within the apothem, which makes a clean ring test: outer edge minus inner edge.
const AXES = [[1, 0], [0.5, 0.8660254], [-0.5, 0.8660254]];

function hexApotherm(x, y) {
  let d = 0;
  for (const [ax, ay] of AXES) d = Math.max(d, Math.abs(x * ax + y * ay));
  return d;
}

/** Colour of one point, in a fixed 32-unit design space; `undefined` means transparent. */
function sample(ux, uy) {
  const d = hexApotherm(ux - 16, uy - 16);
  if (d <= CORE_APOTHEM) return CORE;
  if (d <= RING_OUTER && d >= RING_INNER) return RING;
  return undefined;
}

function draw(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const sub = 3;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, coverage = 0;
      for (let sy = 0; sy < sub; sy += 1) {
        for (let sx = 0; sx < sub; sx += 1) {
          const ux = ((x + (sx + 0.5) / sub) * 32) / size;
          const uy = ((y + (sy + 0.5) / sub) * 32) / size;
          const colour = sample(ux, uy);
          if (!colour) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          coverage += 1;
        }
      }
      const index = (y * size + x) * 4;
      const samples = sub * sub;
      if (coverage > 0) {
        pixels[index] = Math.round(r / coverage);
        pixels[index + 1] = Math.round(g / coverage);
        pixels[index + 2] = Math.round(b / coverage);
      }
      pixels[index + 3] = Math.round((coverage / samples) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // colour type: RGBA
  // Rows are prefixed with filter type 0 (none); the icon is tiny, so filtering buys nothing.
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const target = y * (size * 4 + 1);
    raw[target] = 0;
    pixels.copy(raw, target + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const png16 = encodePng(16, draw(16));
const png32 = encodePng(32, draw(32));

/**
 * Packs PNGs into a Windows .ico container.
 *
 * The ICO format is a small directory followed by the image payloads, and since Vista an entry may hold
 * a PNG verbatim - so no BMP encoding is needed here. Every size is drawn independently (never scaled),
 * because a hexagon ring turns to mush when it is resampled.
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, buffer } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;     // width, 0 meaning 256
    entry[1] = size >= 256 ? 0 : size;     // height
    entry.writeUInt16LE(1, 4);             // colour planes
    entry.writeUInt16LE(32, 6);            // bits per pixel
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += buffer.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.buffer)]);
}

// The exe icon is picked by Windows from this file, so it carries every size Explorer, the taskbar and
// the Alt-Tab switcher may ask for.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPath = path.join(projectRoot, "pictures", "icon.ico");
writeFileSync(icoPath, encodeIco(icoSizes.map((size) => ({ size, buffer: encodePng(size, draw(size)) }))));
console.log(`wrote ${path.relative(projectRoot, icoPath)} (${icoSizes.join("/")})`);

// `--preview <file>` renders the same drawing large enough to actually look at, for eyeballing changes.
const previewIndex = process.argv.indexOf("--preview");
if (previewIndex !== -1 && process.argv[previewIndex + 1]) {
  const previewPath = path.resolve(process.argv[previewIndex + 1]);
  writeFileSync(previewPath, encodePng(160, draw(160)));
  console.log(`wrote preview ${previewPath}`);
}

const module = `/**
 * Tray icon as base64 PNG - generated by \`node scripts/make-tray-icon.mjs\`, do not edit by hand.
 *
 * Two sizes are embedded: 16px for 100% display scaling and 32px for 200%. Electron picks between
 * them through image representations, so the tray icon stays sharp on either.
 */
export const TRAY_ICON_16 = "${png16.toString("base64")}";
export const TRAY_ICON_32 = "${png32.toString("base64")}";
`;
writeFileSync(outputPath, module, "utf8");
console.log(`wrote ${path.relative(projectRoot, outputPath)} (16px ${png16.length}B, 32px ${png32.length}B)`);
