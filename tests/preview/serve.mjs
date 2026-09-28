// Static server for the preview harness: http://127.0.0.1:17777
// Run `npm run preview` and open that URL to click through the real renderer in a normal browser.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PREVIEW_PORT ?? 17777);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png" };

http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(here, rel === "/" ? "harness.html" : rel);
  // Keep the server inside its own directory: a preview helper has no business reading the repo.
  if (!file.startsWith(here)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`预览已启动： http://127.0.0.1:${PORT}/  （Ctrl+C 结束）`);
});
