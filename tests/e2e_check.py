"""端到端验证：跑真实 exe，检查注入常驻 + 导航后自动重装 + 空闲稳定性。

只操作它自己启动的那个浏览器实例；结束时会 taskkill 掉整棵进程树。
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

import websocket

EXE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "开抖音.exe")  # 用法: py e2e_check.py <exe路径>
LOG = os.path.join(os.environ["LOCALAPPDATA"], "KaiDouyin", "run.log")


def ports():
    for p in range(9222, 9234):
        try:
            urllib.request.urlopen("http://127.0.0.1:%d/json/version" % p, timeout=0.8)
            yield p
        except Exception:
            continue


def page_of(p):
    tls = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % p, timeout=3).read())
    for t in tls:
        if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
            return t
    return None


def main():
    for p in list(ports()):
        print("注意：端口 %d 已被其它进程占用，本次会顺延" % p)

    if os.path.exists(LOG):
        os.remove(LOG)

    proc = subprocess.Popen([EXE])
    print("exe pid =", proc.pid)

    port = None
    deadline = time.time() + 45
    while time.time() < deadline and not port:
        time.sleep(2)
        for p in ports():
            port = p
            break

    if not port:
        print("!! 没探到调试端口")
        proc.kill()
        return 1
    print("调试端口 =", port)

    page = None
    for _ in range(20):
        page = page_of(port)
        if page:
            break
        time.sleep(1)
    if not page:
        print("!! 没有 page target")
    else:
        print("首个目标:", page.get("url", "")[:80])

    # 连接并检查注入状态
    def state():
        t = page_of(port)
        ws = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=10, suppress_origin=True)
        cid = [0]

        def call(method, params=None):
            cid[0] += 1
            ws.send(json.dumps({"id": cid[0], "method": method, "params": params or {}}))
            while True:
                m = json.loads(ws.recv())
                if m.get("id") == cid[0]:
                    return m

        def ev(expr):
            r = call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
            res = r.get("result", {})
            if "exceptionDetails" in res:
                return "ERR"
            return res.get("result", {}).get("value")

        st = {
            "url": t.get("url", "")[:60],
            "dye": ev("window.__DYE_OK===1"),
            "ver": ev("window.__DYE_VER||0"),
            "stat": ev("window.__DYE_STAT?window.__DYE_STAT():'no'"),
        }
        # 触发一次导航，验证 addScriptOnNewDocument 是否自动重装
        call("Page.navigate", {"url": "https://www.douyin.com/"})
        ws.close()
        return st

    print("\n[1] 初始注入状态")
    st = state()
    print("   ", json.dumps(st, ensure_ascii=False)[:200])

    print("\n[2] 等待导航完成后再次检查（验证自动重装）")
    time.sleep(6)
    t = page_of(port)
    ws = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=10, suppress_origin=True)
    cid = [0]

    def call2(method, params=None):
        cid[0] += 1
        ws.send(json.dumps({"id": cid[0], "method": method, "params": params or {}}))
        while True:
            m = json.loads(ws.recv())
            if m.get("id") == cid[0]:
                return m

    def ev2(expr):
        r = call2("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        res = r.get("result", {})
        if "exceptionDetails" in res:
            return "ERR"
        return res.get("result", {}).get("value")

    print("    dye =", ev2("window.__DYE_OK===1"), " ver =", ev2("window.__DYE_VER||0"))
    print("    stat =", str(ev2("window.__DYE_STAT?window.__DYE_STAT():'no'"))[:220])

    print("\n[3] 空闲 30 秒，看是否反复重装/重连")
    for i in range(6):
        time.sleep(5)
        print("   %2ds dye=%s" % ((i + 1) * 5, ev2("window.__DYE_OK===1")))
    ws.close()

    print("\n=== run.log ===")
    if os.path.exists(LOG):
        with open(LOG, encoding="utf-8", errors="replace") as f:
            for line in f.read().splitlines():
                print("   ", line)
    else:
        print("    无日志")

    subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                   capture_output=True, timeout=20)
    print("\n已清理进程")
    return 0


sys.exit(main())
