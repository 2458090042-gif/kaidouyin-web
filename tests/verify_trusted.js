/**
 * verify_trusted.js —— 验证 CDP Input.dispatchMouseEvent 产生的事件 isTrusted 是否为 true
 * 对照：JS 合成事件（旧 c.js 做法）必然是 false。
 *
 * 零依赖：直接用 Node 24 内置 WebSocket（Node >= 22 有全局 WebSocket）
 * 用法：node verify_trusted.js
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = [
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => p && fs.existsSync(p));

const FIXTURE = `<!doctype html><meta charset=utf-8><title>trusted-probe</title>
<style>html,body{margin:0;height:100%;background:#111}
#t{position:absolute;left:200px;top:150px;width:260px;height:120px;background:#2a7}</style>
<div id=t></div>
<script>
window.__ev = [];
['mousemove','mousedown','mouseup','click'].forEach(function(n){
  document.addEventListener(n, function(e){
    window.__ev.push({t:e.type, trusted:e.isTrusted, x:e.clientX, y:e.clientY});
  }, true);
});
</script>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTargets(port, deadlineMs = 20000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const ts = await r.json();
      const pages = ts.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (pages.length) return pages;
    } catch {}
    await sleep(300);
  }
  return [];
}

class CDP {
  constructor(ws, url) {
    this.ws = ws;
    this.url = url;
    this.n = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("ws open timeout")), 8000);
      ws.addEventListener("open", () => { clearTimeout(to); res(); }, { once: true });
      ws.addEventListener("error", (e) => { clearTimeout(to); rej(new Error("ws error")); }, { once: true });
    });
    return new CDP(ws, url);
  }
  call(method, params = {}, timeoutMs = 8000) {
    const id = ++this.n;
    return new Promise((res, rej) => {
      const to = setTimeout(() => { this.pending.delete(id); rej(new Error("timeout " + method)); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(to); res(m); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expr) {
    const r = await this.call("Runtime.evaluate", { expression: expr, returnByValue: true });
    return r?.result?.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

function summarize(name, evs) {
  if (!evs || !evs.length) {
    console.log(`  ${name}: 没有捕获到事件`);
    return null;
  }
  const clicks = evs.filter((e) => ["mousedown", "mouseup", "click"].includes(e.t));
  const allTrusted = clicks.length > 0 && clicks.every((e) => e.trusted === true);
  console.log(`  ${name}: 事件 ${evs.length} 条, 点击类 ${clicks.length} 条, 全部 isTrusted=${allTrusted}`);
  for (const e of clicks.slice(0, 4)) {
    console.log(`      ${e.t.padEnd(10)} trusted=${e.trusted}`);
  }
  return allTrusted;
}

(async () => {
  if (!CHROME) {
    console.error("找不到 Chrome/Edge");
    process.exit(2);
  }
  if (typeof WebSocket === "undefined") {
    console.error("需要 Node >= 22（内置 WebSocket）。当前:", process.version);
    process.exit(2);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trusted_"));
  const prof = path.join(tmp, "profile");
  const page = path.join(tmp, "fixture.html");
  fs.writeFileSync(page, FIXTURE, "utf8");

  const port = 9411;
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${prof}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=800,600",
    "--window-position=100,100",
    "--disable-blink-features=AutomationControlled",
    "file:///" + page.replace(/\\/g, "/"),
  ];

  console.log("launch:", path.basename(CHROME));
  const proc = spawn(CHROME, args, { stdio: "ignore", windowsHide: false });

  let ok = false;
  try {
    const pages = await waitTargets(port);
    if (!pages.length) { console.error("FAIL: 拿不到 CDP target"); process.exit(2); }

    const cdp = await CDP.connect(pages[0].webSocketDebuggerUrl);
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");

    for (let i = 0; i < 40; i++) {
      if ((await cdp.evaluate("document.readyState")) === "complete") break;
      await sleep(200);
    }
    await sleep(500);

    const box = JSON.parse(
      await cdp.evaluate("JSON.stringify(document.getElementById('t').getBoundingClientRect())")
    );
    const cx = Math.round(box.left + box.width / 2);
    const cy = Math.round(box.top + box.height / 2);
    console.log(`target box: ${cx},${cy}`);

    // ---------- 实验 1：CDP 真实输入 ----------
    await cdp.evaluate("window.__ev = []");
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy, button: "none" });
    await sleep(50);
    await cdp.call("Input.dispatchMouseEvent", {
      type: "mousePressed", x: cx, y: cy, button: "left", buttons: 1, clickCount: 1,
    });
    await sleep(80);
    await cdp.call("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: cx, y: cy, button: "left", buttons: 0, clickCount: 1,
    });
    await sleep(350);
    const evCdp = JSON.parse((await cdp.evaluate("JSON.stringify(window.__ev)")) || "[]");

    // ---------- 实验 2：JS 合成事件（旧做法） ----------
    await cdp.evaluate("window.__ev = []");
    await cdp.evaluate(`(function(){
      var el = document.getElementById('t');
      var r = el.getBoundingClientRect();
      var o = {bubbles:true, cancelable:true, view:window,
               clientX:r.left+r.width/2, clientY:r.top+r.height/2};
      ['mouseover','mouseenter','mousemove','mousedown','mouseup','click'].forEach(function(n){
        try { el.dispatchEvent(new MouseEvent(n, o)); } catch(e){}
      });
      try { el.click(); } catch(e){}
    })()`);
    await sleep(350);
    const evJs = JSON.parse((await cdp.evaluate("JSON.stringify(window.__ev)")) || "[]");

    console.log("\n=== 结果 ===");
    const a = summarize("CDP Input   ", evCdp);
    const b = summarize("JS 合成事件 ", evJs);

    console.log("");
    if (a === true && b === false) {
      console.log("[PASS] CDP 输入 = true（真人等价） / JS 合成 = false（可被识破）");
      console.log("       改造方向正确。");
      ok = true;
    } else if (a === true) {
      console.log("[PASS*] CDP 输入确认为 true；JS 合成未捕获到 click，不影响结论。");
      ok = true;
    } else {
      console.log("[FAIL] CDP 输入未能产生 isTrusted=true，需要排查");
    }

    cdp.close();
  } catch (e) {
    console.error("ERROR:", e.message);
  } finally {
    try { proc.kill(); } catch {}
    await sleep(600);
  }

  process.exit(ok ? 0 : 1);
})();
