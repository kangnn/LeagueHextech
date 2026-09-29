// Drives the preview page in the locally installed Chrome over CDP and writes screenshots.
// No extra packages: the DevTools protocol is plain WebSocket JSON, and `ws` is already a
// dependency of this repo.
//
//   node tests/preview/shoot.mjs
//
// Each scenario asserts the behaviour the UI is supposed to have, so this doubles as a visual
// regression check for the parts the DOM-stub tests can only approximate (real CSS, real layout,
// real animation timing).
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "shots");
fs.mkdirSync(outDir, { recursive: true });

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9223;
const SERVE_PORT = 17777;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lh-preview-"));
const URL_BASE = `http://127.0.0.1:${SERVE_PORT}/app.html`;

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png" };
/** Serves the preview directory so the page has a real http origin (file:// blocks the module script). */
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(here, rel === "/" ? "harness.html" : rel);
  if (!file.startsWith(here)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  });
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(ok ? `PASS ${name}` : `FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--window-size=1100,700",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], { stdio: "ignore" });

/** Chrome takes a moment to expose its debugging socket; poll rather than sleeping a fixed amount. */
async function endpoint() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await wait(250);
  }
  throw new Error("Chrome 调试端口一直没起来");
}

let ws;
let serial = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = ++serial;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function main() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SERVE_PORT, "127.0.0.1", resolve);
  });
  const browserWs = await endpoint();
  ws = new WebSocket(browserWs, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`));
      else resolve(msg.result);
    }
  });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride",
    { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false }, sessionId);

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "页面内求值失败");
    }
    return result.result.value;
  };

  const shoot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  };

  // Synthetic events (dispatchEvent) reach JS handlers but never flip CSS :hover, and the notice
  // fold is pure CSS - so hovering has to go through the real input pipeline.
  const hover = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
  };
  const moveTo = async (selector) => {
    const box = await evaluate(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await hover(box.x, box.y);
  };

  const open = async () => {
    await send("Page.navigate", { url: URL_BASE }, sessionId);
    // The module script resolves several awaited bridge calls before it binds any handler, so wait
    // for the buttons to be live rather than for the load event.
    for (let i = 0; i < 60; i += 1) {
      if (await evaluate("Boolean(document.getElementById('diagnose')?.onclick)")) return;
      await wait(100);
    }
    throw new Error("渲染层没有在预期时间内绑定事件");
  };

  await open();

  /* ---------- 0. 探测期间的灯色：用慢场景留出观察窗口 ---------- */
  await evaluate(`window.postMessage({scene:'slow'}, '*')`);
  const probeColor = await evaluate(`(async () => {
    const pill = document.getElementById('client');
    const neutralSample = document.createElement('div');
    neutralSample.className = 'pill';
    document.body.append(neutralSample);
    const neutralColor = getComputedStyle(neutralSample).color;
    neutralSample.remove();
    const priorState = pill.dataset.state;
    const click = document.getElementById('diagnose').onclick();
    await new Promise(r => setTimeout(r, 260)); // past the 180ms colour transition
    const during = { color: getComputedStyle(pill).color, state: pill.dataset.state, probing: pill.classList.contains('probing') };
    await click;
    return { neutralColor, priorState, during };
  })()`);
  check("探测期间灯不再钉着上一个结论的颜色",
    probeColor.during.probing === true && probeColor.during.color === probeColor.neutralColor &&
    probeColor.during.state === undefined,
    JSON.stringify(probeColor));
  await evaluate(`window.postMessage({scene:'fast'}, '*')`);

  /* ---------- 1. 快速探测：按钮自己转圈，全程无横幅 ---------- */
  const fast = await evaluate(`(async () => {
    const before = document.getElementById('toasts').children.length;
    const btn = document.getElementById('diagnose');
    const pill = document.getElementById('client');
    const glyphBefore = btn.textContent;
    const click = btn.onclick();
    await new Promise(r => setTimeout(r, 60));
    const mid = {
      working: btn.classList.contains('working'),
      busy: btn.dataset.working,
      disabled: btn.disabled,
      glyph: btn.textContent,
      glyphSpinning: getComputedStyle(btn.querySelector('.glyph')).animationName !== 'none',
      pillProbing: pill.classList.contains('probing'),
      pillText: document.getElementById('clientText').textContent,
      banners: [...document.getElementById('toasts').children].map(r => r.textContent),
    };
    await click;
    await new Promise(r => setTimeout(r, 80));
    return {
      before, glyphBefore, mid,
      after: {
        glyph: btn.textContent,
        working: btn.classList.contains('working'),
        banners: [...document.getElementById('toasts').children].map(r => r.textContent),
        pill: document.getElementById('clientText').textContent,
        pillState: document.getElementById('client').dataset.state,
        pillProbing: document.getElementById('client').classList.contains('probing'),
      },
    };
  })()`);

  check("按下瞬间按钮进入 working", fast.mid.working === true, JSON.stringify(fast.mid));
  check("图标按钮原地转动，不换成文字",
    fast.mid.glyphSpinning === true && fast.mid.glyph === fast.glyphBefore,
    `glyph=${fast.mid.glyph} before=${fast.glyphBefore} spinning=${fast.mid.glyphSpinning}`);
  check("按钮被锁定", fast.mid.disabled === true && fast.mid.busy === "1");
  check("指示灯进入探测态", fast.mid.pillProbing === true);
  check("探测中指示灯文字同步变为「检测中…」", fast.mid.pillText === "检测中…", fast.mid.pillText);
  check("探测中不弹横幅（先在按钮上转圈）", fast.mid.banners.length === fast.before, JSON.stringify(fast.mid.banners));
  check("指示灯给出结论", fast.after.pill === "未检测到客户端", fast.after.pill);
  check("结论也升起一条横幅", fast.after.banners.some((t) => t.includes("未检测到")), JSON.stringify(fast.after.banners));
  check("按钮解锁且图标保持原样", fast.after.glyph === fast.glyphBefore && fast.after.working === false, fast.after.glyph);
  check("灯探测态已结束", fast.after.pillProbing === false);

  // Screenshot the pill *while* the probe is in flight. The bridge's slow scene gives a 800ms window,
  // which is the only way to actually see the pulse state on a real frame.
  await evaluate(`window.postMessage({scene:'slow'}, '*')`);
  // Kick the click off without awaiting it: evaluate resolves promises, and awaiting the onclick
  // promise here would wait out the whole 800ms probe and shoot the finished state, not in-flight.
  await evaluate(`(async () => { document.getElementById('diagnose').onclick(); })()`);
  await wait(120);
  await shoot("01-probe-inflight");
  await wait(200);
  await shoot("01b-probe-inflight-later");
  await evaluate(`new Promise((resolve) => {
    const btn = document.getElementById('diagnose');
    const until = Date.now() + 3000;
    const poll = () => (btn.dataset.working ? (Date.now() < until ? setTimeout(poll, 20) : resolve()) : resolve());
    poll();
  })`);
  await evaluate(`window.postMessage({scene:'fast'}, '*')`);
  await evaluate(`document.getElementById('clearLog').onclick()`);
  await evaluate(`document.getElementById('diagnose').onclick()`);
  await evaluate(`new Promise((resolve) => {
    const btn = document.getElementById('diagnose');
    const until = Date.now() + 3000;
    const poll = () => (btn.dataset.working ? (Date.now() < until ? setTimeout(poll, 20) : resolve()) : resolve());
    poll();
  })`);
  await shoot("02-fast-probe-done");

  /* ---------- 2. 慢探测：全程不发「正在检测」，只在结束时给结论 ---------- */
  await evaluate(`document.getElementById('toasts').replaceChildren()`);
  await evaluate(`window.postMessage({scene:'slow'}, '*')`);
  const slow = await evaluate(`(async () => {
    const btn = document.getElementById('diagnose');
    const click = btn.onclick();
    const samples = [];
    for (const at of [200, 500]) {
      await new Promise(r => setTimeout(r, at === 200 ? 200 : 300));
      samples.push([...document.getElementById('toasts').children].map(r => r.textContent));
    }
    await click;
    return samples;
  })()`);
  check("探测中不发进行中的横幅",
    slow.every((rows) => rows.length === 0), JSON.stringify(slow));

  /* ---------- 3. 探测成功：绿灯 + 闪光环 + 一条成功横幅 ---------- */
  await evaluate(`document.getElementById('toasts').replaceChildren()`);
  await evaluate(`window.postMessage({scene:'connected'}, '*')`);
  const ok = await evaluate(`(async () => {
    await document.getElementById('diagnose').onclick();
    await new Promise(r => setTimeout(r, 60));
    return {
      text: document.getElementById('clientText').textContent,
      state: document.getElementById('client').dataset.state,
      flash: document.getElementById('client').classList.contains('flash'),
      banners: [...document.getElementById('toasts').children].map((r) => ({
        text: r.querySelector('.text')?.textContent ?? '',
        kind: r.className,
      })),
      log: document.querySelector('#log .line .msg')?.textContent ?? '',
    };
  })()`);
  check("连接成功绿灯亮起", ok.text === "已连接客户端" && ok.state === "on", JSON.stringify(ok));
  check("出结果时闪一圈光环", ok.flash === true);
  check("成功也升起一条 ok 横幅并写明来源与端口",
    ok.banners.some((r) => r.kind.includes("ok") && r.text.includes("端口")), JSON.stringify(ok.banners));
  check("检测结果不再写进事件日志",
    !ok.log.includes("已连接"), `log=${ok.log}`);
  await shoot("03-probe-connected");
  await evaluate(`document.getElementById('toasts').replaceChildren()`);
  await evaluate(`document.getElementById('clearLog').onclick()`);

  /* ---------- 4. 慢操作（检查更新）：先按钮转圈，超过阈值才升横幅 ---------- */
  await evaluate(`window.postMessage({scene:'slow-update'}, '*')`);
  const upd = await evaluate(`(async () => {
    const btn = document.getElementById('checkUpdate');
    const click = btn.onclick();
    await new Promise(r => setTimeout(r, 150));
    const early = {
      banners: [...document.getElementById('toasts').children].map(r => r.querySelector('.text')?.textContent ?? r.textContent),
      spinning: getComputedStyle(btn.querySelector('.glyph')).animationName !== 'none',
      glyph: btn.textContent,
    };
    await new Promise(r => setTimeout(r, 400));
    const late = {
      banners: [...document.getElementById('toasts').children].map(r => r.querySelector('.text')?.textContent ?? r.textContent),
      loud: btn.classList.contains('busy-loud'),
    };
    await click;
    await new Promise(r => setTimeout(r, 100));
    return { early, late, endBanners: [...document.getElementById('toasts').children].map(r => r.querySelector('.text')?.textContent ?? r.textContent) };
  })()`);
  check("慢操作起步时不弹横幅（先在按钮上转圈）",
    upd.early.banners.length === 0 && upd.early.spinning, JSON.stringify(upd.early));
  check("超过阈值后才升起横幅",
    upd.late.banners.some((t) => t.includes("正在检查更新")), JSON.stringify(upd.late));
  // The result banner is *supposed* to be there; what must be gone is the in-flight one, or the two
  // would stack exactly the way the client probe used to. Exactly ONE result banner: the verdict
  // arrives both as the invoke()'s return value and as a published event, and toasting from both is
  // how one click ended up showing "已是最新版本" twice.
  const resultBanners = upd.endBanners.filter((t) => t.includes("已是最新版本")).length;
  check("结果到达后「正在检查」的横幅撤走",
    !upd.endBanners.some((t) => t.includes("正在检查更新")) &&
    resultBanners === 1,
    JSON.stringify(upd.endBanners));

  await evaluate(`window.postMessage({scene:'slow-update'}, '*')`);
  await evaluate(`document.getElementById('checkUpdate').onclick()`);
  await wait(600);
  await shoot("04-slow-update-escalated");
  await wait(900);

  /* ---------- 5. 连点同一按钮只算一次 ---------- */
  await evaluate(`window.postMessage({scene:'fast'}, '*')`);
  await evaluate(`(() => {
    const original = window.searcher.diagnose;
    window.__calls = 0;
    window.searcher.diagnose = (...args) => { window.__calls += 1; return original(...args); };
  })()`);
  await evaluate(`(async () => {
    const btn = document.getElementById('diagnose');
    await Promise.all([btn.onclick(), btn.onclick()]);
  })()`);
  const diagnoseCalls = await evaluate("window.__calls");
  check("飞行中重复点击被忽略", diagnoseCalls === 1, String(diagnoseCalls));

  /* ---------- 5b. 手动检查发现新版本：先问用户，不替用户按下下载 ---------- */
  // A manual check used to start the download the moment it found a version, spending the user's
  // bandwidth without asking. It now raises the same 立即更新 / 跳过该版本 / 稍后 row a background
  // check does, and the download only starts from that row.
  await evaluate(`document.getElementById('toasts').replaceChildren()`);
  await evaluate(`(() => {
    window.__downloads = 0;
    const original = window.searcher.downloadUpdate;
    window.searcher.downloadUpdate = (...args) => { window.__downloads += 1; return original(...args); };
  })()`);
  await evaluate(`window.__updateResult = { supported: true, status: 'available', version: '0.1.7' }`);
  await evaluate(`document.getElementById('checkUpdate').onclick()`);
  await evaluate(`delete window.__updateResult`);
  await wait(480); // the 150ms fake round trip plus the .4s toast-in animation
  const ask = await evaluate(`({
    promptShown: !document.getElementById('updatePromptRow').hidden,
    promptText: document.getElementById('updatePromptText').textContent,
    downloads: window.__downloads,
    banner: [...document.getElementById('toasts').children].some(
      (r) => (r.querySelector('.text')?.textContent ?? '').includes('发现新版本 v0.1.7')),
  })`);
  check("手动检查发现新版本弹询问框而不是直接下载",
    ask.promptShown === true && ask.downloads === 0, JSON.stringify(ask));
  check("询问文案带上发现的版本号",
    ask.promptText === "发现新版本 v0.1.7，是否更新？", ask.promptText);
  check("横幅把用户引到这个选择上", ask.banner === true, JSON.stringify(ask));
  await shoot("04b-manual-check-asks");
  // Answering the question is the only thing that moves bytes.
  await evaluate(`document.getElementById('downloadUpdate').onclick()`);
  await wait(200);
  const answered = await evaluate(`({
    downloads: window.__downloads,
    promptHidden: document.getElementById('updatePromptRow').hidden,
  })`);
  check("点「立即更新」才开始下载并收起询问",
    answered.downloads === 1 && answered.promptHidden === true, JSON.stringify(answered));

  /* ---------- 6. 重复消息就是又一条横幅，而不是「N 次」汇总 ---------- */
  // Modelled on sonner, the toast library CC Switch uses: no counter, no progress bar, no expander.
  // A message that arrives three times is three sentences; collapsing them into "3 次" is a log
  // widget wearing a banner's clothes. Result banners only come from a *manual* check now, so the
  // repeats are driven through the real button with the bridge rigged to fail.
  await evaluate(`document.getElementById('toasts').replaceChildren()`);
  await evaluate(`window.__updateResult = { supported: true, status: 'error', message: '网络不可达' }`);
  await evaluate(`document.getElementById('checkUpdate').onclick()`);
  await evaluate(`document.getElementById('checkUpdate').onclick()`);
  await evaluate(`document.getElementById('checkUpdate').onclick()`);
  await evaluate(`delete window.__updateResult`);
  await wait(480); // the toast-in animation is .4s; shooting earlier catches rows mid-flight
  const dedupe = await evaluate(`[...document.getElementById('toasts').children].map(r => ({
    text: r.querySelector('.text')?.textContent,
    count: r.querySelector('.count')?.textContent ?? '',
    hasBar: Boolean(r.querySelector('.bar')),
    hasChev: Boolean(r.querySelector('.chev')),
    children: r.children.length,
  }))`);
  check("重复消息不再合并计数", dedupe.every((row) => row.count === ""), JSON.stringify(dedupe));
  check("横幅上没有进度条与展开箭头",
    dedupe.every((row) => !row.hasBar && !row.hasChev), JSON.stringify(dedupe));
  check("横幅只由图标与一句话组成", dedupe.every((row) => row.children === 2), JSON.stringify(dedupe));
  check("横幅堆叠数量有上限", dedupe.length <= 3, String(dedupe.length));
  // CC Switch tints the whole row by kind instead of putting a coloured stripe on a dark panel, so a
  // failure has to come out red-on-red-tint. The fill is a low-alpha tint over a dark page, so the
  // channels are compared as ratios rather than absolute levels - a neutral dark card has r≈g≈b.
  const paint = await evaluate(`(() => {
    const row = document.querySelector('.toast.bad');
    const s = getComputedStyle(row);
    const badge = getComputedStyle(row.querySelector('.badge'));
    return { bg: s.backgroundColor, fg: s.color, badge: badge.color, align: s.alignItems };
  })()`);
  const rgba = (c) => (c.match(/[\d.]+/g) ?? []).map(Number);
  const [br, bg, bb, ba = 1] = rgba(paint.bg);
  check("失败横幅整条为红色调底", br > bb * 1.1 && br > bg * 1.1, paint.bg);
  // The stack folds rows on top of each other; a translucent fill would let the covered rows' text
  // bleed through the front card and the fold would read as a smear of overlapping sentences.
  check("横幅底色不透明（折叠时不透出下层文字）", ba === 1, paint.bg);
  check("横幅文字与图标同色", paint.fg === paint.badge, `${paint.fg} / ${paint.badge}`);
  check("图标与多行文字顶部对齐", paint.align === "flex-start", paint.align);

  // Truncating a failure hides the one sentence the user needs, so the row must wrap instead.
  const wrapping = await evaluate(`(() => {
    const row = document.querySelector('.toast.bad');
    const text = row.querySelector('.text');
    return {
      wrap: getComputedStyle(text).whiteSpace,
      height: row.getBoundingClientRect().height,
      line: parseFloat(getComputedStyle(text).lineHeight),
      scrollW: text.scrollWidth, clientW: text.clientWidth,
    };
  })()`);
  check("长文案换行显示而不截断",
    wrapping.wrap !== "nowrap" && wrapping.scrollW <= wrapping.clientW + 1,
    JSON.stringify(wrapping));

  // CC Switch stacks its notices like a deck: only the newest is fully visible, the rest hide behind
  // it with their bottom edge peeking out, and the pointer deals the rows back out. The fold is
  // :hover-driven CSS, so this moves the real pointer - dispatchEvent reaches JS handlers but never
  // flips :hover.
  const margins = () => evaluate(`[...document.getElementById('toasts').children].slice(1)
    .map((r) => parseFloat(getComputedStyle(r).marginTop))`);
  const folded = await margins();
  await shoot("05a-fold-collapsed");
  await moveTo(".toast");
  await wait(400); // the margin transition is .25s; give it room to finish
  const expanded = await margins();
  await shoot("05b-fold-expanded");
  await hover(5, 400); // park the pointer away from the stack and watch it fold back
  await wait(400);
  const refolded = await margins();
  check("折叠时旧横幅藏在最新的后面（负外边距）",
    folded.length > 0 && folded.every((m) => m < 0), JSON.stringify(folded));
  check("鼠标放上去整叠展开",
    expanded.length > 0 && expanded.every((m) => m > 0), JSON.stringify(expanded));
  check("移开后重新折回", refolded.every((m) => m < 0), JSON.stringify(refolded));
  const zOrder = await evaluate(`(() => {
    const rows = [...document.getElementById('toasts').children];
    return { newest: rows[0].style.zIndex, oldest: rows.at(-1).style.zIndex };
  })()`);
  check("最新的横幅盖在最上面", Number(zOrder.newest) > Number(zOrder.oldest), JSON.stringify(zOrder));
  // A banner overlapping the titlebar would sit on the window buttons and swallow their clicks.
  const overlap = await evaluate(`(() => {
    const bar = document.querySelector('.titlebar').getBoundingClientRect();
    const toast = document.getElementById('toasts').getBoundingClientRect();
    return { titleBottom: bar.bottom, toastTop: toast.top };
  })()`);
  check("横幅不与标题栏重叠（不挡住窗口按钮）",
    overlap.toastTop >= overlap.titleBottom, JSON.stringify(overlap));
  await shoot("05-notice-stack");

  // The log reads like a console with the newest line on top and the view pinned to it. A short log
  // has nothing to scroll, so the honest assertion is "sits at the top" - the earlier wording
  // ("appends at the bottom, scrolls to the bottom") still passed by accident, because a log shorter
  // than its panel has scrollTop 0 and a maximum of 0.
  const logScroll = await evaluate(`(() => {
    const el = document.getElementById('log');
    return {
      count: el.children.length,
      top: el.scrollTop,
      first: el.firstElementChild?.querySelector('.msg')?.textContent ?? '',
      last: el.lastElementChild?.querySelector('.msg')?.textContent ?? '',
    };
  })()`);
  check("日志新行插在最上面并保持滚到顶",
    logScroll.count > 0 && logScroll.top === 0, JSON.stringify(logScroll));

  // A scrolled-down log must not leave its last line half cut: the panel itself has to stay inside
  // the window. It did not - the 38px titlebar sat above a `height: 100vh` app column, so the bottom
  // of the page fell outside the viewport and `overflow: hidden` on the body made it unreachable.
  const layout = await evaluate(`(() => {
    const el = document.getElementById('log');
    // Distinct player counts, or the renderer folds the identical lines into one ×N row and there is
    // nothing to scroll.
    for (let i = 0; i < 60; i += 1) {
      window.searcher.__emit({
        type: 'skipped',
        message: '房间与当前客户端的版本不一致，无法加入（INVALID_GAME_VERSION），已暂时跳过',
        lobby: { id: 'b0cad431-1111-2222-3333-444444444444', playerCount: i % 10, maxHumanPlayers: 10, inviteCount: 3 },
      });
    }
    el.scrollTop = el.scrollHeight;
    const panel = el.getBoundingClientRect();
    const last = el.lastElementChild.getBoundingClientRect();
    return {
      viewportH: window.innerHeight,
      bodyScrollH: document.body.scrollHeight,
      appBottom: document.querySelector('.app').getBoundingClientRect().bottom,
      panelBottom: panel.bottom,
      panelHeight: panel.height,
      scrollTop: el.scrollTop,
      max: Math.max(0, el.scrollHeight - el.clientHeight),
      lastLineBottom: last.bottom,
      rows: el.children.length,
    };
  })()`);
  check("日志面板底部留在窗口内（标题栏不再把整页顶出可视区）",
    layout.rows >= 60 && layout.appBottom <= layout.viewportH + 1 && layout.panelBottom <= layout.viewportH + 1,
    JSON.stringify(layout));
  check("日志滚到最下方时最后一行完整可见",
    layout.scrollTop === layout.max && layout.lastLineBottom <= layout.panelBottom + 1,
    JSON.stringify(layout));
  await shoot("05c-log-scroll");
  await evaluate(`document.getElementById('clearLog').onclick()`);
  await evaluate("document.getElementById('toasts').replaceChildren()");

  /* ---------- 7. 状态能在失败与成功之间来回切换 ---------- */
  await evaluate(`window.postMessage({scene:'fast'}, '*')`);
  await evaluate(`document.getElementById('diagnose').onclick()`);
  await wait(400);
  const off = await evaluate(`({ text: document.getElementById('clientText').textContent, state: document.getElementById('client').dataset.state })`);
  check("探测失败时灯转为未检测到", off.text === "未检测到客户端" && off.state === "off", JSON.stringify(off));

  await evaluate(`window.postMessage({scene:'connected'}, '*')`);
  await evaluate(`document.getElementById('diagnose').onclick()`);
  await wait(400);
  const back = await evaluate(`({ text: document.getElementById('clientText').textContent, state: document.getElementById('client').dataset.state })`);
  check("再探测成功时灯能切回已连接", back.text === "已连接客户端" && back.state === "on", JSON.stringify(back));
  await shoot("06-state-recovered");

  /* ---------- 8. 连点：横幅正在淡出时又来一条，界面不能被锁死 ---------- */
  // The freeze the dev build showed: three rows on the stack, the oldest one dismissed but still in
  // the document for its 400ms fade, and a fourth arriving inside that window. The stack cap used to
  // be a `while` over the live child list whose only way to make progress was `dismissToast`, which
  // refuses to touch a row that is already leaving - so nothing was ever removed, the loop spun
  // forever and the renderer stopped running timers (the banner froze on screen and every later
  // click went dead). Reported as "一直点「检测」就会卡死".
  //
  // A frozen renderer never answers Runtime.evaluate, so the step is raced against a timeout: a
  // regression has to fail the suite rather than hang it.
  const alive = await Promise.race([
    (async () => {
      await evaluate(`window.postMessage({scene:'fast'}, '*')`);
      await evaluate(`document.getElementById('toasts').replaceChildren()`);
      await evaluate(`window.__updateResult = { supported: true, status: 'uptodate', currentVersion: '0.1.6' }`);
      // Three notices on the stack, each one a real click on the real button.
      for (let i = 0; i < 3; i += 1) await evaluate(`document.getElementById('checkUpdate').onclick()`);
      await wait(200);
      const stacked = await evaluate(`document.getElementById('toasts').children.length`);
      // Dismiss the oldest row by clicking it: gone + .leaving, node stays for the 400ms fade.
      await evaluate(`(() => {
        const rows = document.getElementById('toasts').children;
        rows[rows.length - 1].onclick();
      })()`);
      const fading = await evaluate(`document.getElementById('toasts').children.length`);
      // A fourth notice arrives ~150ms later, inside that fade window: the cap has to take a row away.
      await evaluate(`document.getElementById('checkUpdate').onclick()`);
      await evaluate(`delete window.__updateResult`);
      await wait(600);
      const rows = await evaluate(`[...document.getElementById('toasts').children].map((r) => ({
        text: r.querySelector('.text')?.textContent ?? '', gone: r.dataset.gone ?? null,
      }))`);
      // The readout above only answers if the renderer is still executing anything at all.
      return { stacked, fading, rows };
    })(),
    wait(8000).then(() => undefined)
  ]);
  check("横幅淡出期间再来一条不会卡死界面", Boolean(alive), "渲染层已卡死（求值不再返回）");
  check("连点时横幅栈始终不超过三条",
    alive !== undefined && alive.stacked === 3 && alive.fading === 3 && alive.rows.length <= 3,
    JSON.stringify(alive));
  check("超限时最旧那条被摘掉，即使它正在淡出",
    alive !== undefined && alive.rows.length === 3 && alive.rows.every((row) => row.gone === null),
    JSON.stringify(alive?.rows));
  // Only touch the page again if it answered the readout: a frozen renderer never returns from an
  // evaluate, so an unconditional cleanup would hang the suite instead of failing it.
  if (alive) {
    await shoot("07-burst-dismiss");
    await evaluate("document.getElementById('toasts').replaceChildren()");
  }

  /* ---------- 9. 两个按钮同时在飞：检测客户端 + 检查更新 ---------- */
  // Two buttons never queue behind each other (the busy wrapper only guards its own button), so the
  // one place their clicks meet is the notice stack: 「检查更新」raises a sticky row at 350ms while
  // the probe answers with its own verdict. Both paths toast, so this is the other way the cap can be
  // asked to drop a row - and the answer must be the same: the interface stays alive.
  const concurrent = await Promise.race([
    (async () => {
      await evaluate(`window.postMessage({scene:'slow-update'}, '*')`);
      await evaluate(`document.getElementById('toasts').replaceChildren()`);
      // Both clicks land in their own task, because the fake bridge reads its delay when the call
      // lands: the update check has to start while the scene still says "slow-update", and the probe
      // one task later, when it says "slow". They then overlap for most of a second.
      await evaluate(`(() => {
        window.__pairDone = false;
        window.__update = document.getElementById('checkUpdate').onclick();
        return true;
      })()`);
      await evaluate(`window.postMessage({scene:'slow'}, '*')`);
      await evaluate(`(() => {
        window.__probe = document.getElementById('diagnose').onclick();
        Promise.all([window.__update, window.__probe]).then(() => { window.__pairDone = true; });
        return true;
      })()`);
      await wait(500); // both are still in flight, the update banner has just escalated
      const mid = await evaluate(`({
        rows: document.getElementById('toasts').children.length,
        escalated: [...document.getElementById('toasts').children].some((r) => r.querySelector('.text')?.textContent === '正在检查更新…'),
        probing: document.getElementById('client').classList.contains('probing'),
        updateBusy: document.getElementById('checkUpdate').dataset.working === '1',
        probeBusy: document.getElementById('diagnose').dataset.working === '1',
      })`);
      await wait(1600);
      const end = await evaluate(`({
        done: window.__pairDone === true,
        rows: [...document.getElementById('toasts').children].map((r) => r.querySelector('.text')?.textContent ?? ''),
        updateBusy: document.getElementById('checkUpdate').dataset.working ?? null,
        probeBusy: document.getElementById('diagnose').dataset.working ?? null,
        probing: document.getElementById('client').classList.contains('probing'),
        pill: document.getElementById('clientText').textContent,
      })`);
      return { mid, end };
    })(),
    wait(8000).then(() => undefined)
  ]);
  check("两个按钮同时操作不会卡死界面", Boolean(concurrent), "渲染层已卡死（求值不再返回）");
  check("飞行中：两个按钮各自忙碌，横幅不超过三条",
    concurrent?.mid.updateBusy === true && concurrent?.mid.probeBusy === true && concurrent?.mid.rows <= 3,
    JSON.stringify(concurrent?.mid));
  check("检查更新的「进行中」横幅按时升起",
    concurrent?.mid.escalated === true, JSON.stringify(concurrent?.mid));
  check("两个操作都收尾：按钮解锁、指示灯不再闪烁、进行中横幅撤走",
    concurrent !== undefined &&
    concurrent.end.done === true &&
    concurrent.end.updateBusy === null && concurrent.end.probeBusy === null &&
    concurrent.end.probing === false &&
    concurrent.end.pill === "未检测到客户端" &&
    !concurrent.end.rows.includes("正在检查更新…"),
    JSON.stringify(concurrent?.end));
  if (concurrent) {
    await shoot("08-both-buttons");
    await evaluate("document.getElementById('toasts').replaceChildren()");
  }

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ failures }, null, 2));
  console.log(`\n${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILED`} — 截图在 ${path.relative(process.cwd(), outDir)}`);
}

try {
  await main();
} catch (error) {
  console.error("harness error:", error.message);
  failures.push("harness");
} finally {
  try { ws?.close(); } catch { /* already gone */ }
  chrome.kill();
  await wait(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* windows may hold it */ }
  await new Promise((resolve) => server.close(resolve));
  process.exit(failures.length === 0 ? 0 : 1);
}
