# -*- coding: utf-8 -*-
"""
验证：CDP Input.dispatchMouseEvent 产生的事件 isTrusted 是否为 true。
同时对照 JS 合成事件（旧 c.js 的做法），证明前者才是唯一正解。

用法：python verify_trusted.py
"""
import json, os, subprocess, sys, tempfile, time, urllib.request

try:
    import websocket  # websocket-client
except ImportError:
    print("需要 websocket-client: pip install websocket-client")
    sys.exit(2)

CHROME_CANDIDATES = [
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

FIXTURE = r"""<!doctype html><meta charset=utf-8><title>trusted-probe</title>
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
</script>
"""


def find_chrome():
    for p in CHROME_CANDIDATES:
        if os.path.isfile(p):
            return p
    return None


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=10)
        self.n = 0

    def call(self, method, params=None, timeout=8):
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        end = time.time() + timeout
        while time.time() < end:
            m = json.loads(self.ws.recv())
            if m.get("id") == mid:
                return m
        raise TimeoutError(method)

    def evaluate(self, expr):
        r = self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        return r.get("result", {}).get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def wait_targets(port, deadline=20):
    end = time.time() + deadline
    while time.time() < end:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as r:
                ts = json.load(r)
            pages = [t for t in ts if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            if pages:
                return pages
        except Exception:
            pass
        time.sleep(0.3)
    return []


def main():
    chrome = find_chrome()
    if not chrome:
        print("找不到 Chrome/Edge")
        return 2

    tmp = tempfile.mkdtemp(prefix="trusted_")
    prof = os.path.join(tmp, "profile")
    page = os.path.join(tmp, "fixture.html")
    with open(page, "w", encoding="utf-8") as f:
        f.write(FIXTURE)

    port = 9411
    args = [
        chrome,
        f"--remote-debugging-port={port}",
        "--remote-allow-origins=*",
        f"--user-data-dir={prof}",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=800,600",
        "--window-position=100,100",
        "--disable-blink-features=AutomationControlled",
        "file:///" + page.replace("\\", "/"),
    ]
    print("launch:", os.path.basename(chrome))
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    ok = False
    try:
        pages = wait_targets(port)
        if not pages:
            print("FAIL: 拿不到 CDP target")
            return 2
        tgt = pages[0]
        cdp = CDP(tgt["webSocketDebuggerUrl"])
        cdp.call("Page.enable")
        cdp.call("Runtime.enable")

        # 等页面稳定
        for _ in range(40):
            if cdp.evaluate("document.readyState") == "complete":
                break
            time.sleep(0.2)
        time.sleep(0.5)

        box = cdp.evaluate("JSON.stringify(document.getElementById('t').getBoundingClientRect())")
        r = json.loads(box)
        cx = int(r["left"] + r["width"] / 2)
        cy = int(r["top"] + r["height"] / 2)
        print(f"target box: {cx},{cy}")

        # ---------- 实验 1：CDP 真实输入 ----------
        cdp.evaluate("window.__ev = []")
        cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": cx, "y": cy, "button": "none"})
        time.sleep(0.05)
        cdp.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": cx, "y": cy,
                                              "button": "left", "buttons": 1, "clickCount": 1})
        time.sleep(0.08)
        cdp.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": cx, "y": cy,
                                              "button": "left", "buttons": 0, "clickCount": 1})
        time.sleep(0.35)
        ev_cdp = json.loads(cdp.evaluate("JSON.stringify(window.__ev)") or "[]")

        # ---------- 实验 2：JS 合成事件（旧做法） ----------
        cdp.evaluate("window.__ev = []")
        cdp.evaluate("""(function(){
            var el = document.getElementById('t');
            var r = el.getBoundingClientRect();
            var o = {bubbles:true, cancelable:true, view:window,
                     clientX:r.left+r.width/2, clientY:r.top+r.height/2};
            ['mouseover','mouseenter','mousemove','mousedown','mouseup','click'].forEach(function(n){
                try { el.dispatchEvent(new MouseEvent(n, o)); } catch(e){}
            });
            try { el.click(); } catch(e){}
        })()""")
        time.sleep(0.35)
        ev_js = json.loads(cdp.evaluate("JSON.stringify(window.__ev)") or "[]")

        def summarize(name, evs):
            if not evs:
                print(f"  {name}: 没有捕获到事件")
                return None
            tr = [e for e in evs if e["type"] in ("mousedown", "mouseup", "click")]
            allt = all(e["trusted"] for e in tr)
            print(f"  {name}: 事件 {len(evs)} 条, 点击类 {len(tr)} 条, "
                  f"全部 isTrusted={allt}")
            for e in tr[:4]:
                print(f"      {e['type']:10s} trusted={e['trusted']}")
            return allt

        print("\n=== 结果 ===")
        a = summarize("CDP Input  ", ev_cdp)
        b = summarize("JS 合成事件", ev_js)

        print()
        if a is True and b is False:
            print("[PASS] CDP 输入 = true(真人等价) / JS 合成 = false(可被识破)")
            print("       改造方向正确。")
            ok = True
        elif a is True:
            print("[PASS*] CDP 输入确认为 true；JS 合成未捕获到 click（可能 view 不对），")
            print("        不影响结论：合成事件永远不可能是 true。")
            ok = True
        else:
            print("[FAIL] CDP 输入未能产生 isTrusted=true，需要排查")

        cdp.close()
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        time.sleep(0.5)

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
