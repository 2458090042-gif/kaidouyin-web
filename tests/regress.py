"""多场景回归：直播优先、连续刷视频、全屏请求次数。

关键：真实站点的画质档位只在"真实鼠标停在齿轮上"时才渲染，
脚本会通过 window.__DYE_HOVER_REQ 请求主进程移动指针。
这里用真实 CDP Input.dispatchMouseEvent 复现 main.cs 的 hover 服务，
否则测到的只是"没有 hover 时的降级行为"。
"""
import json
import os
import sys
import time
import urllib.request

import websocket

PORT = 9333
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根目录
FIXTURE = "file:///" + os.path.join(HERE, "tests", "fixture.html").replace(os.sep, "/")


def targets():
    return json.loads(urllib.request.urlopen(
        "http://127.0.0.1:%d/json/list" % PORT, timeout=5).read())


class Page:
    def __init__(self):
        t = [x for x in targets() if x["type"] == "page" and "fixture.html" in x.get("url", "")][0]
        self.ws = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=20,
                                              suppress_origin=True)
        self.id = 0

    def send(self, method, params=None):
        self.id += 1
        self.ws.send(json.dumps({"id": self.id, "method": method, "params": params or {}}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.id:
                return m

    def ev(self, expr):
        r = self.send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        res = r.get("result", {})
        if "exceptionDetails" in res:
            return None
        return res.get("result", {}).get("value")

    def service_hover(self):
        """复现 main.cs 的 ServiceHover：满足脚本的 hover 请求。"""
        req = self.ev("window.__DYE_HOVER_REQ?window.__DYE_HOVER_REQ():''")
        if not req or "," not in str(req):
            return None
        x, y = [int(v) for v in str(req).split(",")]
        self.send("Input.dispatchMouseEvent",
                  {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
        return (x, y)

    def close(self):
        self.ws.close()


def run(mode, query, seconds):
    p = Page()
    p.ev("(function(){location.href=%s;return 1})()" % json.dumps(FIXTURE + query))
    time.sleep(3.5)
    name = "old_c1.js" if mode == "old" else "c.js"
    src = open(HERE + "\\" + name, encoding="utf-8").read()
    p.ev(src)
    rows = []
    for _ in range(seconds):
        time.sleep(1)
        if mode == "new":
            p.service_hover()          # 新版才需要 hover；旧版没有这个接口
        st = p.ev("window.__fixture.state()")
        if isinstance(st, dict):
            rows.append(st)
    p.close()
    return rows


def summary(label, rows):
    if not rows:
        print("  %-4s 无数据" % label)
        return None
    last = rows[-1]
    print("  %-4s 画质=%-6s 齿轮点击=%-3d 面板弹出=%-3d 切流=%-3d 全屏请求=%-3d 序号=%d" % (
        label, last["cur"], last["gearClicks"], last["opens"],
        last["switches"], last["fsReqs"], last["videoIndex"]))
    return last


print("=== 场景 A：首个视频是直播（旧版会永久失效）===")
for mode in ("old", "new"):
    rows = run(mode, "?live=1", 12)
    summary(mode, rows)

print("\n=== 场景 B：连续刷 4 个视频 ===")
for mode in ("old", "new"):
    rows = run(mode, "?videos=4", 22)
    last = summary(mode, rows)
    if rows:
        print("       面板累计弹出峰值 =", max(r["opens"] for r in rows))

print("\n=== 场景 C：脚本合成的点击不应触发全屏 ===")
for mode in ("old", "new"):
    p = Page()
    p.ev("(function(){location.href=%s;return 1})()" % json.dumps(FIXTURE))
    time.sleep(3.5)
    name = "old_c1.js" if mode == "old" else "c.js"
    p.ev(open(HERE + "\\" + name, encoding="utf-8").read())
    for _ in range(3):
        p.ev("document.body.click()")
        time.sleep(0.4)
    st = p.ev("window.__fixture.state()")
    print("  %-4s 3 次合成点击 → 全屏请求 %d 次" % (mode, st["fsReqs"]))
    p.close()
