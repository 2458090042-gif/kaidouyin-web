"""实验：用 CDP 直接注入 c.js，验证能否恢复自动选画质/全屏功能。"""
import json
import time
import urllib.request

import websocket

import os
SCRIPT = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "c.js"), encoding="utf-8").read()

TARGETS = json.loads(urllib.request.urlopen('http://127.0.0.1:9222/json/list', timeout=5).read())
page = next((t for t in TARGETS if t['type'] == 'page' and 'douyin.com' in t.get('url', '')), None)
ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=10, suppress_origin=True)
_id = [0]


def send(method, params=None):
    _id[0] += 1
    ws.send(json.dumps({'id': _id[0], 'method': method, 'params': params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get('id') == _id[0]:
            return msg


def ev(expr):
    r = send('Runtime.evaluate', {'expression': expr, 'returnByValue': True})
    res = r.get('result', {})
    if 'exceptionDetails' in res:
        return 'ERR: ' + json.dumps(res['exceptionDetails'], ensure_ascii=False)[:300]
    return res.get('result', {}).get('value')


print('注入前 __DYE_OK :', ev('window.__DYE_OK'))
r = send('Runtime.evaluate', {'expression': SCRIPT, 'returnByValue': True})
print('注入返回        :', json.dumps(r.get('result', {}), ensure_ascii=False)[:200])
print('注入后 __DYE_OK :', ev('window.__DYE_OK'))
print('注入后 data-dye :', ev("document.documentElement.getAttribute('data-dye')"))

print('\n--- 观察 25 秒，看画质是否自动切换 ---')
for i in range(5):
    time.sleep(5)
    info = ev("""(function(){
      var g=document.querySelector('.xgplayer div.gear');
      var v=document.querySelector('video');
      return JSON.stringify({
        gear: g? (g.innerText||'').replace(/\\s+/g,' ').trim() : '无齿轮',
        paused: v? v.paused : '无视频',
        t: v? Math.round(v.currentTime*10)/10 : 0,
        w: v? v.videoWidth : 0
      });
    })()""")
    print('  [%2ds]' % ((i + 1) * 5), info)
ws.close()
