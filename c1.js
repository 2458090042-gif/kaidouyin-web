/* 抖音网页版增强脚本 —— 自动最高画质 + 单击进入全屏
 * 说明：c1.js 由本文件生成，只把下面 CAP 改成 60（画质上限 1080P）。
 *
 * 相对旧版修掉的问题：
 *  1) 首个视频反复弹出画质菜单：同一视频只开一次面板，点完立刻标记完成，
 *     不再拿“齿轮文字变化”当成功条件（智能模式下文字一直不变，旧版因此死循环）。
 *  2) 直播首条之后画质全部失效：旧版用 currentSrc 当视频身份，MSE 复用的
 *     blob: 地址会让 giveup 永久锁死后续所有视频；改用播放器节点 + 时长 + 分辨率。
 *  3) 卡顿：不再每 3 秒全页扫描 DOM，起播稳定后再切一次流，同一节点 6 秒内不重复。
 *  4) 点一下灰屏几秒：全屏只对真人点击（isTrusted）触发，最多 3 次即锁定。
 */
(function () {
  'use strict';
  if (window.__DYE_OK === 1) { return; }
  window.__DYE_OK = 1;
  window.__DYE_VER = 3;

  /* ================= 可调参数 ================= */
  var CAP = 60;        // 画质上限分：1000 = 不限；c1.js 用 60 (=1080P)
  var TICK = 1000;       // 巡检间隔
  var PANEL_WAIT = 1700; // 点齿轮后等菜单出现的最长时间
  var OPEN_GAP = 5000;   // 两次开面板之间的硬间隔
  var MAX_TRIES = 3;

  /* ================= 画质打分 ================= */
  var RANKS = [
    ['8k', 95], ['4k', 90], ['2k', 85], ['原画', 82], ['蓝光', 80], ['极致', 78],
    ['超清', 75], ['1080', 60], ['高清', 55], ['720', 50], ['540', 40],
    ['480', 35], ['标清', 30], ['360', 25], ['流畅', 20]
  ];

  function score(text) {
    var t = (text || '').toLowerCase();
    if (!t || t.length > 16) { return 0; }
    var best = 0;
    for (var i = 0; i < RANKS.length; i++) {
      if (t.indexOf(RANKS[i][0]) >= 0 && RANKS[i][1] > best) { best = RANKS[i][1]; }
    }
    return best;
  }

  /* ================= 小工具 ================= */
  var LOG = [];
  function now() {
    return (window.performance && performance.now) ? performance.now() : new Date().getTime();
  }
  function log(m) {
    try {
      LOG.push(Math.round(now()) + ' ' + m);
      if (LOG.length > 80) { LOG.shift(); }
    } catch (e) { }
  }
  function clean(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

  /* ================= 真实输入桥 =================
   * 站点用 e.isTrusted 判真人（本文件顶部注释第 4 条已经印证：全屏只认真人点击）。
   * 所以这里一律不再自己派发任何 PointerEvent / MouseEvent / el.click() ——
   * 那类事件 isTrusted 恒为 false，等于在风控面前自己举手。
   *
   * 改成"只登记坐标"：页面把想点的位置写进 window.__DYE_CLICK / __DYE_HOVER，
   * 由 main.cs 读走后用 CDP Input.dispatchMouseEvent 真正发出去，
   * 走浏览器原生输入管线，isTrusted === true，与真人点击不可区分。
   *
   * 代价：点击是异步的，本文件不会立刻知道"点成了没有"，
   * 只能靠下一轮巡检观察 videoHeight / 选中项来确认。
   */
  var ASK_HOVER = null;
  var ASK_CLICK = null;
  var CLICK_SEQ = 0;
  var CLICK_LAST = 0;
  var CLICK_PENDING = 0;   // 已登记但还没被主进程取走的次数
  var CLICK_MIN_GAP = 900; // 两次真实点击之间至少隔这么久，别像连发

  function esc(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  // 把一个元素换算成"人类会点在哪里"：不做正中，做元素内偏置随机点
  function pointOf(el) {
    if (!el || !el.getBoundingClientRect) { return null; }
    var r = el.getBoundingClientRect();
    if (!(r.width > 1) || !(r.height > 1)) { return null; }
    return {
      x: Math.round(r.left + r.width * (0.30 + Math.random() * 0.40)),
      y: Math.round(r.top + r.height * (0.34 + Math.random() * 0.32))
    };
  }

  function askHover(el) {
    var p = pointOf(el);
    if (!p) { return false; }
    ASK_HOVER = { x: p.x, y: p.y };
    return true;
  }

  function visible(el) {
    if (!el) { return false; }
    if (!el.getClientRects || el.getClientRects().length === 0) { return false; }
    return el.clientWidth > 4 && el.clientHeight > 4;
  }

  var _seq = 0;
  function idOf(node) {
    if (!node) { return 0; }
    if (!node.__dyId) {
      try { node.__dyId = ++_seq; } catch (e) { return 0; }
    }
    return node.__dyId;
  }

  /* ================= 播放器定位 ================= */
  function activeVideo() {
    var vs = document.querySelectorAll('video');
    if (!vs.length) { return null; }
    var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
    var best = null, bestArea = 0;
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      var r = v.getBoundingClientRect();
      var area = r.width * r.height;
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) { area = 0; }
      if (v.paused) { area -= 1e6; }
      if (area > bestArea) { bestArea = area; best = v; }
    }
    return best;
  }

  function playerScope(v) {
    if (!v) { return document.body; }
    if (v.__dyScope && v.__dyScope.isConnected) { return v.__dyScope; }
    var n = v.parentNode, depth = 0;
    while (n && n !== document.body && depth++ < 14) {
      var c = n.className;
      if (typeof c === 'string' && c.indexOf('xgplayer') >= 0) {
        v.__dyScope = n;
        return n;
      }
      n = n.parentNode;
    }
    var scope = v.parentNode || document.body;
    v.__dyScope = scope;
    return scope;
  }

  // 真实站点的 .gear 里就装着菜单项；鼠标一旦移上去，它的 innerText 会拼上整段
  // 菜单文字（"标清 540P 智能…"），所以 findGear 必须挑"文字短且等于一个 preset"的那个，
  // 不能只看有没有 .item。
  function findGear(scope) {
    var list = scope.querySelectorAll('.gear');
    var best = null, bestLen = 1e9;
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      if (!visible(g)) { continue; }
      var t = clean(g.innerText);
      // preset 名很短（智能/高清/超清…），被污染的文字会明显更长
      if (t.length > 8) { continue; }
      if (t.length < bestLen) { bestLen = t.length; best = g; }
    }
    return best;
  }

  function revealControls(v) {
    try {
      var r = v.getBoundingClientRect();
      if (!r.width || !r.height) { return; }
      // 旧版往播放器上派发合成的 mousemove —— 站点能看出是假的，
      // 而且假的 mousemove 根本唤不醒 CSS :hover。改成请求真实指针移动。
      ASK_HOVER = {
        x: Math.round(r.left + r.width * 0.5),
        y: Math.round(r.top + r.height * 0.5)
      };
    } catch (e) { }
  }

  /* ================= 画质菜单 ================= */
  // 抖音播放器（xgplayer）的关键机制（实测）：
  //   .xgplayer-playclarity-setting 一直存在，里面的 .item 也一直在，
  //   只有当鼠标**停在齿轮上**时这些 .item 才有真实尺寸（87x28）；
  //   鼠标一移开，item 立刻塌成 0x0。
  // 因此"点开菜单再回头找选项"这条路走不通 —— 点完鼠标不在齿轮上，
  // 选项全是 0x0，永远点不到，菜单还留在那儿反复闪。
  // 正确做法：先把鼠标移上去（hover），趁 item 有尺寸时直接点它。
  var PANEL_SEL = [
    '.xgplayer-playclarity-setting', '.xgplayer-playback-setting',
    '.xgplayer-setting-content', '.xgplayer-settings', '.xgplayer-setting',
    '[class*="playclarity"]', '[class*="playback-setting"]', '[class*="clarity"]'
  ].join(',');

  // 页面上有多个播放器（预加载的、滑走的），每个都带一份画质面板。
  // 必须挑"当前正在播的那个"对应的面板：优先挑选项真的有尺寸的那份，
  // 否则会对着隐藏播放器的面板扫描，永远看不到 1080P。
  function focusPanel(scope) {
    var all = [];
    var inner = scope.querySelectorAll(PANEL_SEL);
    for (var i = 0; i < inner.length; i++) { all.push(inner[i]); }
    var outer = document.querySelectorAll(PANEL_SEL);
    for (var j = 0; j < outer.length; j++) {
      if (all.indexOf(outer[j]) < 0) { all.push(outer[j]); }
    }
    var best = null, bestScore = -1;
    for (var k = 0; k < all.length; k++) {
      var p = all[k];
      var its = p.querySelectorAll(ITEM_SEL);
      if (!its.length) { continue; }
      var s = 0;
      for (var m = 0; m < its.length; m++) {
        var t = clean(its[m].innerText);
        if (!score(t)) { continue; }
        var r = its[m].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { s += 2; }   // 真的有尺寸 -> 这份是激活的
        else { s += 0.1; }
      }
      if (s > bestScore) { bestScore = s; best = p; }
    }
    return best;
  }

  // 列表项：真实档位是 class="item"，文字形如 "高清 1080P"；
  // 倍速项复用同一个类名，但文字是 "1.5x" 之类，靠打分（score=0）就能排掉。
  //
  // 重要（实测）：画质面板在动画/展开过程中，item 自己的 clientWidth/Height 会是 0，
  // 但祖先容器（.xgplayer-playclarity-setting）已经有尺寸，说明菜单确实弹开了。
  // 旧版用 offsetParent===null / 尺寸过滤，正好把这些"还没布局完"的项全扔掉，
  // 于是最后一个都点不到 —— 这就是"选画质一直不生效"的直接原因。
  var ITEM_SEL = '.item, [role="option"]';

  function shownIn(root, el) {
    // 自己没尺寸时，只要祖先链（到 root 为止）有可见盒子就算可见
    var n = el;
    var guard = 0;
    while (n && guard++ < 12) {
      if (!n.getClientRects || n.getClientRects().length === 0) {
        // 没有盒子的中间层继续往上找
      } else if (n.clientWidth > 0 || n.clientHeight > 0) {
        return true;
      }
      if (n === root) { break; }
      n = n.parentNode;
    }
    return false;
  }

  function scanIn(root, gear) {
    var nodes = root.querySelectorAll(ITEM_SEL);
    var hits = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      // 注意：真实站点的 .gear 自己就包着这些 .item，所以这里不能排除 gear.contains(el)，
      // 否则一个都扫不到。只要文字像画质档位就收下。
      if (el === gear) { continue; }
      if (!shownIn(root, el)) { continue; }
      var t = clean(el.innerText);
      if (!t || t.length > 16) { continue; }
      var s = score(t);
      if (!s) { continue; }
      hits.push({ el: el, text: t, score: s });
    }
    // 相同文字只留最内层
    var out = [];
    for (var a = 0; a < hits.length; a++) {
      var inner = false;
      for (var b = 0; b < hits.length; b++) {
        if (a === b) { continue; }
        if (hits[b].text === hits[a].text && hits[a].el.contains(hits[b].el)) { inner = true; break; }
      }
      if (!inner) { out.push(hits[a]); }
    }
    return out;
  }

  function scan(scope, gear) {
    var panel = focusPanel(scope);
    return panel ? scanIn(panel, gear) : [];
  }

  function bestOf(opts) {
    var best = null;
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].score > CAP) { continue; }
      if (!best || opts[i].score > best.score) { best = opts[i]; }
    }
    return best;
  }

  // 真实站点里 "智能" 这一项自身就带 .selected（表示当前用的是"智能"预设），
  // 所以不能把 selected 的文字直接当画质；只有具体分辨率才算数。
  // 另外页面上有多组面板（每个播放器一份），必须取有尺寸的那组。
  function readSelected(panel) {
    var roots = panel ? [panel] : [];
    if (!roots.length) {
      var all = document.querySelectorAll('.xgplayer-playclarity-setting');
      for (var k = 0; k < all.length; k++) {
        if (all[k].querySelectorAll('.item').length) { roots.push(all[k]); }
      }
    }
    for (var r = 0; r < roots.length; r++) {
      var list = roots[r].querySelectorAll('.item.selected, .item.is-selected, [aria-selected="true"]');
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (!shownIn(roots[r], it)) { continue; }
        var t = clean(it.innerText);
        if (definiteScore(t) > 0) { return t; }
      }
    }
    return '';
  }

  /* ================= 主流程 ================= */
  function newState(key) {
    return {
      key: key, tries: 0, done: false, live: false, bestSeen: 0, lastT: -1,
      nextAt: 0, backoff: 900, label: '', budget: MAX_TRIES, reveals: 0, preset: 0
    };
  }

  var S = newState('');
  var lastOpenAt = 0;
  var alive = true;
  // 注：ASK_HOVER / ASK_CLICK 在文件顶部"真实输入桥"一节声明，这里不再重复声明。

  // 只表示"是哪个视频"，刻意不含 videoWidth —— 切画质会改变分辨率，
  // 若把分辨率算进身份，切一次流就会被当成换了视频，从而反复弹菜单。
  function keyOf(v) {
    var scope = playerScope(v);
    var id = '';
    try {
      var n = v;
      while (n && n !== document.body) {
        var ds = n.dataset || {};
        if (ds.e2eVideoId) { id = ds.e2eVideoId; break; }
        if (ds.videoId) { id = ds.videoId; break; }
        if (ds.awemeId) { id = ds.awemeId; break; }
        n = n.parentNode;
      }
    } catch (e) { }
    if (!id) {
      var src = (v && (v.currentSrc || v.src || '')) || '';
      if (src && src.indexOf('blob:') !== 0) { id = src.slice(-72); }
    }
    var d = (v && isFinite(v.duration) && v.duration > 0) ? Math.round(v.duration) : 0;
    return idOf(scope) + '#' + id + '#' + d;
  }

  function isLive(v) {
    if (!v || v.readyState < 1) { return false; }
    return (v.duration === Infinity || !isFinite(v.duration));
  }

  // 播放器给的 preset 名字（"智能"/"高清"/"超清"…）不能当画质档位用：
  // 一个 preset 底下可能是 540P 也可能是 4K。只有出现具体分辨率或明确档位时才认。
  function definiteScore(text) {
    var t = (text || '').toLowerCase();
    if (!t) { return 0; }
    if (/\d{3,4}\s*p/.test(t)) { return score(t); }
    if (/[248]k|原画|蓝光/.test(t)) { return score(t); }
    return 0;
  }

  function fail(msg) {
    S.tries++;
    if (S.tries >= S.budget) {
      S.done = true;
      log('giveup ' + msg + ' tries=' + S.tries);
      return;
    }
    S.backoff = Math.min(8000, S.backoff * 2);
    S.nextAt = now() + S.backoff;
    log('retry ' + S.tries + '/' + S.budget + ' ' + Math.round(S.backoff) + 'ms ' + msg);
  }

  // 对一个档位元素登记"真实点击"请求。
  // 旧版这里派发 mouseover/mousedown/mouseup/click 全套合成事件，
  // 但 isTrusted 全是 false —— 站点能一眼分辨，这正是账号被标记的依据之一。
  // 现在只换算坐标交给 main.cs 用 CDP 真点。
  function tap(el) {
    if (!el) { return false; }
    var t = now();
    // 节流：别在同一瞬间点好几下
    if (CLICK_PENDING > 0) { return false; }
    if (t - CLICK_LAST < CLICK_MIN_GAP) { return false; }
    var p = pointOf(el);
    if (!p) { return false; }
    CLICK_SEQ++;
    ASK_CLICK = { id: CLICK_SEQ, x: p.x, y: p.y, t: Math.round(t) };
    CLICK_LAST = t;
    CLICK_PENDING++;
    log('click-req ' + p.x + ',' + p.y + ' #' + CLICK_SEQ);
    return true;
  }

  // 关键机制（真实站点实测确认）：
  //   ① .gear 的 :hover 只认"真实鼠标停在上面"，脚本合成的 mouseover 触发不了 CSS :hover，
  //      所以不 hover 时面板里只渲染出"当前档 + 智能"，永远看不到 1080P/720P。
  //   ② 一旦真实鼠标把指针停在齿轮上，4 档都会渲染出来；此时**真的把鼠标点上去**
  //      就能切换（已验证 videoHeight 540 -> 1080）。
  //   ③ 但"真的点"必须走 CDP Input（main.cs 负责），不能派发合成事件 ——
  //      合成事件 isTrusted=false，站点的播放器监听器会忽略，风控还会记账。
  // 分工：main.cs 用 CDP 真实鼠标负责"移过去 + 点下去"，脚本只负责"挑最高档 + 报坐标"。
  function applyPick(scope, gear, label) {
    var myS = S;
    S.tries++;
    S.preset++;
    lastOpenAt = now();

    var waited = 0;
    function poll() {
      // 只在"当前视频状态被换掉"时放弃；S.done 不放弃，
      // 因为下面要自己把它置 done。
      if (S !== myS) { return; }
      flushClickAck();

      var panel = focusPanel(scope);
      var opts = panel ? scanIn(panel, gear) : [];
      var best = bestOf(opts);
      var cur = readSelected(panel);

      // 扫到的最高档 > 当前档 才点；否则先保证指针压在齿轮上把档位撑开。
      var canUpgrade = best && (!cur || definiteScore(cur) < best.score);
      if (canUpgrade) {
        if (best.score > S.bestSeen) { S.bestSeen = best.score; }
        if (tap(best.el)) {
          S.done = true;                               // 已交给主进程真点，绝不重复弹
          log('pick ' + label + ' -> ' + best.text + '(' + best.score +
              (cur ? ' from ' + cur : '') + ')');
          return;
        }
        // tap 被节流挡下（刚点过），继续等下一轮，别把状态提前收掉
      }

      waited += 200 + Math.random() * 90;              // 打散节律，别用固定 220
      if (waited >= PANEL_WAIT) {
        S.done = true;
        log('giveup opts=' + opts.length + (cur ? (' cur=' + cur) : ''));
        return;
      }
      // 持续把真实指针压在齿轮上，档位才不会塌回 0x0
      var gr2 = gear.getBoundingClientRect();
      if (gr2.width > 0) {
        askHover(gear);
      }
      setTimeout(poll, 200 + Math.random() * 90);
    }
    setTimeout(poll, 200 + Math.random() * 80);
  }

  function step() {
    if (document.hidden) { return; }
    var v = activeVideo();
    if (!v) { return; }

    // 身份变了 = 换片了。keyOf 里不含分辨率，所以切画质不会误判成换视频。
    // 这段必须先于 done 判断，否则处理完第一个视频后就永远看不到新视频。
    var key = keyOf(v);
    if (key !== S.key) {
      S = newState(key);
      log('video ' + key);
    } else if (!S.live && v.currentTime < (S.lastT - 1.2) && S.done) {
      // 兜底：同一 blob / 同一时长里换了片（进度回到开头）
      S = newState(key);
      log('replay t=' + v.currentTime.toFixed(1));
    }
    S.lastT = v.currentTime;
    if (S.done) { return; }

    if (now() < S.nextAt) { return; }

    if (!S.live && isLive(v)) {
      S.live = true;
      S.budget = 1;                                    // 直播只试一次，失败就安静
      log('live');
    }
    // 起播稳定后再切，避免刚加载就换流造成卡顿
    if (v.paused || v.seeking || v.readyState < 2 || v.currentTime < 0.8) { return; }

    var scope = playerScope(v);
    if (now() - lastOpenAt < OPEN_GAP) { return; }

    var gear = findGear(scope);
    if (!gear) {
      if (S.reveals++ < 4) { revealControls(v); }      // 控制条隐藏了，晃一下鼠标下次再看
      return;
    }

    // 齿轮文字是 preset 名（智能），不能当画质；只有出现具体档位才算达标
    var label = clean(gear.innerText);
    S.label = label;
    var ls = definiteScore(label);
    if (ls > 0 && (ls >= CAP || (S.bestSeen && ls >= S.bestSeen))) {
      S.done = true;
      log('ok ' + label);
      return;
    }
    if (S.preset >= MAX_TRIES) {
      S.done = true;
      log('giveup presets=' + S.preset);
      return;
    }
    // 当前档位已经是最优：先确认面板确实展开（能看到 >=2 档）再收工
    var panelNow = focusPanel(scope);
    var optsNow = panelNow ? scanIn(panelNow, gear) : [];
    var curTxt = readSelected(panelNow);
    var bestNow = bestOf(optsNow);
    if (curTxt && bestNow && optsNow.length >= 2 && definiteScore(curTxt) >= bestNow.score) {
      S.bestSeen = bestNow.score;
      S.done = true;
      log('already ' + curTxt + '/' + bestNow.score);
      return;
    }
    // 交给 applyPick：它自己会用 ASK_HOVER 反复请求主进程把真实指针压到齿轮上，
    // 每一轮都重新扫描，直到看到比当前更高的档位就点下去。
    // 这里不再做"先等一轮"的分阶段逻辑，否则 step 提前 return 会把流程卡住。
    applyPick(scope, gear, label);
  }

  function tick() {
    if (!alive) { return; }
    try { step(); } catch (e) { log('ERR ' + (e && e.message)); }
    setTimeout(tick, TICK);
  }

  // 换视频信号：播放器重新拿到元数据。只有"不是本视频的已知时长"才算换片，
  // 否则每次切画质都会触发一次，又把状态重置回未处理（这正是反复弹菜单的成因之一）。
  var lastDur = -1;
  document.addEventListener('loadedmetadata', function (e) {
    var v = e.target;
    if (!v || v.tagName !== 'VIDEO') { return; }
    if (v !== activeVideo()) { return; }

    // 处理完这条视频之后就不要再被元数据事件牵着走：
    // 切画质本身会触发 loadedmetadata，时长/尺寸都会抖，容易把状态重置回"未处理"，
    // 一旦重置就会再弹一次菜单 —— 这正是首条视频反复弹的原因。
    if (S.done) { return; }

    var d = (isFinite(v.duration) && v.duration > 0) ? Math.round(v.duration) : 0;
    var durChanged = d > 0 && lastDur > 0 && d !== lastDur;
    lastDur = d;
    // 只认"时长变了"这一种确凿的换片信号
    if (!durChanged) { return; }
    S = newState(keyOf(v));
    log('meta d=' + d);
  }, true);
  document.addEventListener('ended', function () {
    S = newState('ended');
  }, true);

  /* ================= 全屏 ================= */
  var fsTries = 0, fsLock = false, fsLast = 0;
  function wantFullscreen() {
    if (fsLock || document.fullscreenElement) { return; }
    var t = now();
    if (t - fsLast < 1200) { return; }
    fsLast = t;
    if (++fsTries > 3) { fsLock = true; return; }
    try {
      var p = (document.documentElement || document.body).requestFullscreen();
      if (p && p.catch) { p.catch(function () { }); }
    } catch (e) { }
  }

  document.addEventListener('fullscreenchange', function () {
    if (document.fullscreenElement) { fsLock = true; }
  });

  // 只认真人点击（isTrusted），脚本自己合成的点击不再触发全屏
  document.addEventListener('click', function (e) {
    if (e && e.isTrusted) { wantFullscreen(); }
  }, true);
  document.addEventListener('auxclick', function (e) {
    if (e && e.isTrusted && (e.button === 3 || e.button === 4)) {
      e.preventDefault();
      wantFullscreen();
    }
  }, true);
  document.addEventListener('keydown', function (e) {
    if (!e || !e.isTrusted) { return; }
    var k = e.key || '';
    if (k === 'F11' || k === 'F12' || k === 'F16') { wantFullscreen(); }
  }, true);

  // 这段脚本会在两种时机运行：正常页面里（documentElement 一定存在），
  // 以及 addScriptToEvaluateOnNewDocument 的文档创建瞬间（那时 <html> 还没建好）。
  // 后者若直接 setAttribute 会抛异常，把后面的逻辑整段截断，所以必须做兜底。
  function markDom() {
    var el = document.documentElement;
    if (el && el.setAttribute) {
      try { el.setAttribute('data-dye', '1'); return true; } catch (e) { }
    }
    return false;
  }
  if (!markDom()) {
    try {
      document.addEventListener('readystatechange', function () { markDom(); }, true);
    } catch (e) { }
  }
  log('boot');

  /* ================= 诊断接口 ================= */
  window.__DYE_STAT = function () {
    return JSON.stringify({
      ver: window.__DYE_VER, cap: CAP, key: S.key, tries: S.tries,
      done: S.done, live: S.live, bestSeen: S.bestSeen, label: S.label,
      clicks: CLICK_SEQ, pending: CLICK_PENDING,
      log: LOG.slice(-14)
    });
  };

  // 主进程读取：返回 "x,y" 表示需要把真实鼠标移到该坐标；空串表示不需要
  window.__DYE_HOVER_REQ = function () {
    if (!ASK_HOVER) { return ''; }
    var r = ASK_HOVER;
    ASK_HOVER = null;              // 只取一次，避免重复移动
    return r.x + ',' + r.y;
  };

  // 主进程读取：返回 "id,x,y" 表示需要执行一次真实点击；空串表示没有待办。
  // 取走后 ASK_CLICK 清空，主进程点完会调 __DYE_CLICK_DONE(id) 回执。
  window.__DYE_CLICK_REQ = function () {
    if (!ASK_CLICK) { return ''; }
    var c = ASK_CLICK;
    ASK_CLICK = null;
    return c.id + ',' + c.x + ',' + c.y;
  };

  // 主进程点完回执：解除节流，允许下一轮再点。
  window.__DYE_CLICK_DONE = function (id) {
    CLICK_PENDING = 0;
    CLICK_LAST = now();
    log('click-ack #' + id);
  };

  function flushClickAck() {
    // 兜底：如果主进程始终没来取（比如 CDP 断了），别让节流永久卡死
    if (CLICK_PENDING > 0 && now() - CLICK_LAST > 12000) {
      CLICK_PENDING = 0;
      ASK_CLICK = null;
      log('click-timeout');
    }
  }

  setTimeout(tick, 700 + Math.random() * 400);
})();
