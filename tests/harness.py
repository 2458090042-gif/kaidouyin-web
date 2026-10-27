"""对比旧/新注入脚本在 fixture 上的行为。

必须显式指定端口，避免误连到用户正在使用的真实浏览器（默认 9222）。
    py -3 harness.py new --port 9333
"""
import argparse
import json
import os
import sys
import time
import urllib.request

import websocket

ap = argparse.ArgumentParser()
ap.add_argument("mode", choices=["old", "new", "none"], nargs="?", default="new")
ap.add_argument("--port", type=int, default=9333)
ap.add_argument("--seconds", type=int, default=40)
ap.add_argument("--reload", action="store_true")
args = ap.parse_args()

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根目录
TARGETS = json.loads(urllib.request.urlopen(
    "http://127.0.0.1:%d/json/list" % args.port, timeout=5).read())
page = next((t for t in TARGETS if t["type"] == "page" and "fixture.html" in t.get("url", "")), None)
if page is None:
    print("NO_FIXTURE_PAGE on port", args.port)
    for t in TARGETS:
        if t["type"] == "page":
            print("   candidate:", t["url"][:100])
    raise SystemExit(1)
print("PAGE:", page["url"])

ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=20, suppress_origin=True)
_id = [0]


def send(method, params=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _id[0]:
            return msg


def ev(expr):
    r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
    res = r.get("result", {})
    if "exceptionDetails" in res:
        return {"__error": str(res["exceptionDetails"])[:300]}
    return res.get("result", {}).get("value")


if args.reload:
    ev("(function(){location.reload();return 1})()")
    time.sleep(3)

if args.mode != "none":
    name = "old_c1.js" if args.mode == "old" else "c.js"
    src = open(HERE + "\\" + name, encoding="utf-8").read()
    r = send("Runtime.evaluate", {"expression": src, "returnByValue": True})
    print("inject:", json.dumps(r.get("result", {}), ensure_ascii=False)[:150])
    print("__DYE_OK:", ev("window.__DYE_OK"), "ver:", ev("window.__DYE_VER"))

print("\n时间  画质   齿轮点击 面板弹出 切流次数 面板开着 全屏请求")
rows = []
for i in range(args.seconds):
    time.sleep(1)
    st = ev("window.__fixture.state()")
    if not isinstance(st, dict) or "__error" in st:
        print("  fixture state err:", st)
        break
    rows.append(st)
    print("%3ds  %-6s %-8d %-8d %-8d %-8s %d" % (
        i + 1, st["cur"], st["gearClicks"], st["opens"], st["switches"],
        "是" if st["panelOpen"] else "否", st["fsReqs"]))

print("\n=== 汇总 ===")
if rows:
    last = rows[-1]
    print("最终画质        :", last["cur"])
    print("齿轮点击次数    :", last["gearClicks"], "(首个视频反复弹 -> 数值大)")
    print("面板弹出次数    :", last["opens"])
    print("实际切流次数    :", last["switches"])
    print("面板停留(ms)    :", round(last.get("panelOpenMs", 0)))
    print("全屏请求次数    :", last["fsReqs"])
stat = ev("window.__DYE_STAT ? window.__DYE_STAT() : 'no stat'")
print("DYE_STAT        :", stat)
ws.close()
