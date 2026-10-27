using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

class P {
    const string MANIFEST = @"__MANIFEST__";
    const string SCRIPT = @"__SCRIPT__";
    const string URL = "https://www.douyin.com";
    const int CDP_PORT = 9222;

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
    const int GWL_STYLE = -16;
    const int WS_MAXIMIZE = 0x01000000;
    const int SM_CXSCREEN = 0;
    const int SM_CYSCREEN = 1;
    delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
    struct RECT { public int L, T, R, B; }

    static List<IntPtr> _wins = new List<IntPtr>();
    static volatile bool _cdpAlive = false;
    static int _port = CDP_PORT;
    static string _logPath;

    // ==================== 日志 ====================
    static void Log(string msg) {
        if (_logPath == null) return;
        try {
            FileInfo fi = new FileInfo(_logPath);
            if (fi.Exists && fi.Length > 256 * 1024) File.WriteAllText(_logPath, "");
            File.AppendAllText(_logPath,
                DateTime.Now.ToString("HH:mm:ss.fff") + "  " + msg + Environment.NewLine, Encoding.UTF8);
        } catch { }
    }

    // ==================== 窗口 ====================
    static IntPtr FindTopWindow(uint pid) {
        _wins.Clear();
        EnumWindows(delegate(IntPtr h, IntPtr lp) {
            uint wpid;
            GetWindowThreadProcessId(h, out wpid);
            if (wpid == pid && IsWindowVisible(h)) _wins.Add(h);
            return true;
        }, IntPtr.Zero);
        IntPtr best = IntPtr.Zero;
        int bestArea = 0;
        foreach (IntPtr h in _wins) {
            RECT r;
            if (GetWindowRect(h, out r)) {
                int a = (r.R - r.L) * (r.B - r.T);
                if (a > bestArea) { bestArea = a; best = h; }
            }
        }
        return best;
    }

    static bool IsWindowAlive(IntPtr h, uint pid) {
        if (!IsWindow(h)) return false;
        uint wpid;
        GetWindowThreadProcessId(h, out wpid);
        return wpid == pid;
    }

    // Process.Start 返回的 pid 经常不是真正开窗口的那个：Chromium 在新 profile
    // 首次启动、或已有实例时会把命令行转交给真正的主进程，自己立刻退出。
    // 所以按 user-data-dir 找出所有候选主进程，再挑有可见窗口的。
    static List<uint> MainPidsOfProfile(string profile) {
        List<uint> pids = new List<uint>();
        string[] names = { "msedge.exe", "chrome.exe" };
        foreach (string n in names) {
            try {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT ProcessId, CommandLine, ParentProcessId FROM Win32_Process WHERE Name='" + n + "'")) {
                    foreach (ManagementBaseObject mo in searcher.Get()) {
                        string cmd = mo["CommandLine"] as string;
                        if (cmd == null) continue;
                        if (cmd.IndexOf(profile, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        if (cmd.IndexOf("--type=", StringComparison.OrdinalIgnoreCase) >= 0) continue;  // 排除子进程
                        try { pids.Add((uint)Convert.ToInt32(mo["ProcessId"])); } catch { }
                    }
                }
            } catch { }
        }
        return pids;
    }

    // 在所有候选主进程里找最大的可见窗口
    static IntPtr FindAppWindow(string profile, out uint ownerPid) {
        ownerPid = 0;
        List<uint> pids = MainPidsOfProfile(profile);
        if (pids.Count == 0) return IntPtr.Zero;
        _wins.Clear();
        HashSet<uint> set = new HashSet<uint>(pids);
        EnumWindows(delegate(IntPtr h, IntPtr lp) {
            uint wpid;
            GetWindowThreadProcessId(h, out wpid);
            if (set.Contains(wpid) && IsWindowVisible(h)) _wins.Add(h);
            return true;
        }, IntPtr.Zero);
        IntPtr best = IntPtr.Zero;
        int bestArea = 0;
        foreach (IntPtr h in _wins) {
            RECT r;
            if (GetWindowRect(h, out r)) {
                int a = (r.R - r.L) * (r.B - r.T);
                if (a > bestArea) {
                    bestArea = a; best = h;
                    GetWindowThreadProcessId(h, out ownerPid);
                }
            }
        }
        return best;
    }

    static string FindBrowser() {
        string[] names = {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe")
        };
        foreach (string n in names) if (File.Exists(n)) return n;
        return null;
    }

    static void KillProfileProcesses(string profile) {
        string[] names = { "chrome.exe", "msedge.exe" };
        foreach (string n in names) {
            try {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='" + n + "'")) {
                    foreach (ManagementBaseObject mo in searcher.Get()) {
                        string cmd = mo["CommandLine"] as string;
                        if (cmd == null) continue;
                        if (cmd.IndexOf(profile, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        try {
                            int pid = Convert.ToInt32(mo["ProcessId"]);
                            Process proc = Process.GetProcessById(pid);
                            Log("kill stale pid=" + pid);
                            proc.Kill();
                            proc.WaitForExit(3000);
                        } catch { }
                    }
                }
            } catch { }
        }
    }

    // ==================== 配置 ====================
    static void LoadConfig(string path, out bool max, out int x, out int y, out int w, out int h) {
        max = false; x = 0; y = 0; w = 0; h = 0;
        if (!File.Exists(path)) return;
        foreach (string line in File.ReadAllLines(path)) {
            int eq = line.IndexOf('=');
            if (eq < 0) continue;
            string k = line.Substring(0, eq).Trim();
            string v = line.Substring(eq + 1).Trim();
            int n;
            if (k == "maximized" && int.TryParse(v, out n)) max = n != 0;
            else if (k == "x" && int.TryParse(v, out n)) x = n;
            else if (k == "y" && int.TryParse(v, out n)) y = n;
            else if (k == "w" && int.TryParse(v, out n)) w = n;
            else if (k == "h" && int.TryParse(v, out n)) h = n;
        }
    }

    static void SaveConfig(string path, int x, int y, int w, int h, bool max) {
        StringBuilder sb = new StringBuilder();
        sb.Append("maximized=").Append(max ? 1 : 0).AppendLine();
        sb.Append("x=").Append(x).AppendLine();
        sb.Append("y=").Append(y).AppendLine();
        sb.Append("w=").Append(w).AppendLine();
        sb.Append("h=").Append(h).AppendLine();
        File.WriteAllText(path, sb.ToString());
    }

    // ==================== 端口 ====================
    static bool PortFree(int port) {
        try {
            TcpListener l = new TcpListener(IPAddress.Loopback, port);
            l.Start();
            l.Stop();
            return true;
        } catch { return false; }
    }

    // 9222 被别的程序占着时自动顺延，否则整条调试通道会静默失效
    static int PickPort() {
        for (int p = CDP_PORT; p < CDP_PORT + 12; p++) {
            if (PortFree(p)) return p;
        }
        return CDP_PORT;
    }

    // ==================== CDP 传输 ====================
    static string HttpGet(string url, int timeoutMs) {
        HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
        req.Proxy = null;
        req.Timeout = timeoutMs;
        req.ReadWriteTimeout = timeoutMs;
        req.KeepAlive = false;
        using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
        using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            return sr.ReadToEnd();
    }

    static string JsonField(string obj, string name) {
        Match m = Regex.Match(obj, "\"" + name + "\"\\s*:\\s*\"([^\"]*)\"");
        return m.Success ? m.Groups[1].Value : null;
    }

    static string JsonEsc(string s) {
        StringBuilder sb = new StringBuilder(s.Length + 64);
        foreach (char c in s) {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.ToString();
    }

    // 一条常驻 WebSocket 复用整场会话：连一次、发多条命令。
    // 旧版每 3 秒新建连接再丢弃，反复握手里任何一次超时都会让注入整段失效。
    sealed class Cdp : IDisposable {
        ClientWebSocket _ws;
        int _next = 1;
        readonly object _lock = new object();
        volatile bool _dead;

        public bool IsDead { get { return _dead; } }

        public bool Connect(string wsUrl) {
            try {
                _ws = new ClientWebSocket();
                Task t = _ws.ConnectAsync(new Uri(wsUrl), CancellationToken.None);
                if (!t.Wait(6000)) { _dead = true; return false; }
                _dead = false;
                return true;
            } catch { _dead = true; return false; }
        }

        // 返回同 id 的应答原文；超时或连接故障返回 null（并标记连接不可用）
        public string Call(string method, string paramsJson, int timeoutMs) {
            lock (_lock) {
                if (_dead || _ws == null || _ws.State != WebSocketState.Open) return null;
                int id = _next++;
                string msg = "{\"id\":" + id + ",\"method\":\"" + method + "\",\"params\":" + paramsJson + "}";
                byte[] send = Encoding.UTF8.GetBytes(msg);
                try {
                    Task st = _ws.SendAsync(new ArraySegment<byte>(send, 0, send.Length),
                        WebSocketMessageType.Text, true, CancellationToken.None);
                    if (!st.Wait(4000)) { _dead = true; return null; }
                } catch { _dead = true; return null; }

                byte[] buf = new byte[256 * 1024];
                string want = "\"id\":" + id;
                DateTime deadline = DateTime.Now.AddMilliseconds(timeoutMs);
                while (DateTime.Now < deadline) {
                    StringBuilder sb = new StringBuilder();
                    WebSocketReceiveResult r;
                    do {
                        Task<WebSocketReceiveResult> rt = _ws.ReceiveAsync(
                            new ArraySegment<byte>(buf, 0, buf.Length), CancellationToken.None);
                        if (!rt.Wait(timeoutMs)) { _dead = true; return null; }
                        r = rt.Result;
                        if (r.MessageType == WebSocketMessageType.Close) { _dead = true; return null; }
                        sb.Append(Encoding.UTF8.GetString(buf, 0, r.Count));
                    } while (!r.EndOfMessage);
                    string s = sb.ToString();
                    if (s.IndexOf(want) >= 0) return s;   // 其余是事件通知，跳过
                }
                return null;
            }
        }

        public void Dispose() {
            try { _ws.Dispose(); } catch { }
        }
    }

    static List<string[]> GetTargets() {
        List<string[]> list = new List<string[]>();
        string json = HttpGet("http://127.0.0.1:" + _port + "/json/list", 2500);
        foreach (Match m in Regex.Matches(json, @"\{[^{}]*\}")) {
            string t = JsonField(m.Value, "type");
            string u = JsonField(m.Value, "url");
            string w = JsonField(m.Value, "webSocketDebuggerUrl");
            if (t != null && u != null && w != null) list.Add(new string[] { t, u, w });
        }
        return list;
    }

    static bool EndpointUp() {
        try {
            string v = HttpGet("http://127.0.0.1:" + _port + "/json/version", 1500);
            return v != null && v.Length > 0;
        } catch { return false; }
    }

    // ==================== 注入 ====================
    static Cdp _sess = null;
    static string _sessUrl = null;
    static string _sessTargetUrl = null;
    static bool _prepared = false;       // 本连接是否已下发 addScriptToEvaluateOnNewDocument
    static int _injectCount = 0;
    static int _hoverCount = 0;
    static DateTime _lastAttach = DateTime.MinValue;

    static void DropSession() {
        if (_sess != null) { try { _sess.Dispose(); } catch { } }
        _sess = null; _sessUrl = null; _sessTargetUrl = null; _prepared = false;
    }

    static bool IsRealPage(string url) {
        return url != null
            && url.IndexOf("douyin.com", StringComparison.OrdinalIgnoreCase) >= 0
            && url.StartsWith("http", StringComparison.OrdinalIgnoreCase);
    }

    // 找抖音页面并保持一条长连接。
    // 注意：启动瞬间真正的页面可能还没建好，此时只有 edge:// 之类内部页；
    // 绝不能把脚本注到内部页上（那样看起来"连上了"，实际页面永远没有脚本）。
    static bool EnsureSession() {
        if (_sess != null && !_sess.IsDead && _sessUrl != null) return true;
        DropSession();
        List<string[]> targets;
        try { targets = GetTargets(); } catch { return false; }

        // 优先已加载完成的抖音页面，其次正在加载的
        string[] pick = null;
        foreach (string[] t in targets) {
            if (t[0] != "page") continue;
            if (!IsRealPage(t[1])) continue;
            if (t[1].IndexOf("douyin.com", StringComparison.OrdinalIgnoreCase) >= 0) { pick = t; break; }
        }
        if (pick == null) { _lastAttach = DateTime.Now; return false; }

        Cdp c = new Cdp();
        if (!c.Connect(pick[2])) { c.Dispose(); _lastAttach = DateTime.Now; return false; }
        _sess = c;
        _sessUrl = pick[2];
        _sessTargetUrl = pick[1];
        _prepared = false;
        _lastAttach = DateTime.Now;
        Log("attach " + pick[1].Substring(0, Math.Min(70, pick[1].Length)));
        return true;
    }

    static readonly string PROBE = "window.__DYE_OK===1?1:0";

    // 返回 true 表示脚本在当前文档里已经生效
    static bool EnsureScript() {
        if (_sess == null || _sess.IsDead) return false;

        // 关键：Page.addScriptToEvaluateOnNewDocument 必须先 Page.enable 才会真正生效。
        // 少了这一步命令照样返回 identifier，但页面每次跳转都不会带上脚本，
        // 只能靠下面的兜底再注一次 —— 那正好是"偶发连不上/要等刷新"的来源。
        if (!_prepared) {
            string en = _sess.Call("Page.enable", "{}", 6000);
            if (en == null) { DropSession(); return false; }
            string r = _sess.Call("Page.addScriptToEvaluateOnNewDocument",
                "{\"source\":\"" + JsonEsc(SCRIPT) + "\"}", 8000);
            if (r != null && r.IndexOf("\"error\"") >= 0) {
                Log("preload reject: " + r.Substring(0, Math.Min(160, r.Length)));
            } else if (r != null) {
                Match m = Regex.Match(r, "\"identifier\"\\s*:\\s*\"([^\"]+)\"");
                Log("preload ok" + (m.Success ? " id=" + m.Groups[1].Value : ""));
                _prepared = true;
            }
        }

        string probe = _sess.Call("Runtime.evaluate",
            "{\"expression\":\"" + JsonEsc(PROBE) + "\",\"returnByValue\":true}", 5000);
        if (probe == null) {
            // 会话看着还活着但命令不通：多半是页面已经跳走/换了文档，重连
            Log("probe failed, re-attach");
            DropSession();
            return false;
        }
        if (probe.IndexOf("\"value\":1") >= 0) return true;

        // 当前文档没有 → 立刻补一次
        string expr = "(function(){if(window.__DYE_OK===1)return 'skip';" + SCRIPT + "\n;return 'ok';})()";
        string r2 = _sess.Call("Runtime.evaluate",
            "{\"expression\":\"" + JsonEsc(expr) + "\",\"returnByValue\":true}", 8000);
        if (r2 == null) { DropSession(); return false; }
        if (r2.IndexOf("\"exceptionDetails\"") >= 0) {
            Log("inject exception: " + r2.Substring(0, Math.Min(200, r2.Length)));
            return false;
        }
        _injectCount++;
        Log("inject #" + _injectCount + (_prepared ? " (fallback)" : " (no-preload)"));
        return true;
    }

    // ==================== 真实鼠标（CDP Input） ====================
    // 站点用 e.isTrusted 判真人（c.js 顶部注释第 4 条已印证：全屏只认真人点击）。
    // c.js 不再派发任何合成事件，只登记坐标；这里用 CDP Input.dispatchMouseEvent
    // 走浏览器原生输入管线，isTrusted === true，与真人不可区分。
    static int _px = -1, _py = -1;              // 指针当前位置（未知为 -1）
    static int _hoverStuckX = int.MinValue, _hoverStuckY = int.MinValue;
    static int _clicks = 0, _moves = 0;
    static readonly Random _rng = new Random(unchecked(Environment.TickCount * 31 + Guid.NewGuid().GetHashCode()));
    static double R(double a, double b) { return a + _rng.NextDouble() * (b - a); }
    static int RI(int a, int b) { return a >= b ? a : _rng.Next(a, b + 1); }

    static double Bez(double p0, double p1, double p2, double p3, double t) {
        double u = 1 - t;
        return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    }

    static bool SendMouse(string type, int x, int y, int buttons, int clickCount, int timeoutMs) {
        if (_sess == null || _sess.IsDead) return false;
        string p = "{\"type\":\"" + type + "\",\"x\":" + x + ",\"y\":" + y
            + ",\"button\":\"" + (type == "mouseMoved" ? "none" : "left") + "\""
            + ",\"buttons\":" + buttons;
        if (clickCount > 0) p += ",\"clickCount\":" + clickCount;
        p += "}";
        return _sess.Call("Input.dispatchMouseEvent", p, timeoutMs) != null;
    }

    // 人类轨迹：三次贝塞尔 + smoothstep 缓动 + 亚像素抖动 + 变速
    static void HumanMoveTo(int tx, int ty) {
        if (_sess == null || _sess.IsDead) return;
        if (_px < 0) { _px = tx; _py = ty; return; }   // 不知道指针在哪，先接受当前位置
        int sx = _px, sy = _py;
        double dx = tx - sx, dy = ty - sy;
        double dist = Math.Sqrt(dx * dx + dy * dy);
        if (dist < 1.2) return;                        // 几乎没动：不发事件（真人也一样）

        int steps = Math.Max(5, Math.Min(80, (int)(dist / R(7, 13))));

        // 垂直于位移方向的弓形偏置，模拟手腕弧度；方向随机，避免每次都同一侧
        double nx = -dy, ny = dx;
        double nl = Math.Max(1e-6, Math.Sqrt(nx * nx + ny * ny));
        nx /= nl; ny /= nl;
        double sign = _rng.NextDouble() < 0.5 ? -1 : 1;
        double bow = dist * R(0.04, 0.15) * sign;
        double c1x = sx + dx * R(0.22, 0.38) + nx * bow;
        double c1y = sy + dy * R(0.22, 0.38) + ny * bow;
        double c2x = sx + dx * R(0.62, 0.80) + nx * bow * R(0.35, 0.70);
        double c2y = sy + dy * R(0.62, 0.80) + ny * bow * R(0.35, 0.70);

        double jitter = dist > 200 ? 1.1 : 0.7;
        for (int i = 1; i <= steps; i++) {
            double t = (double)i / steps;
            double e = t * t * (3 - 2 * t);             // smoothstep：起步慢、中段快、临近减速
            double x = Bez(sx, c1x, c2x, tx, e) + R(-jitter, jitter);
            double y = Bez(sy, c1y, c2y, ty, e) + R(-jitter, jitter);
            SendMouse("mouseMoved", (int)Math.Round(x), (int)Math.Round(y), 0, 0, 1200);
            _moves++;
            Thread.Sleep(RI(2, 9));
        }
        _px = tx; _py = ty;
    }

    // 真实点击：先移过去 -> 悬停 -> 落点微抖 -> 按下 -> 按住 -> 抬起
    static void HumanClick(int x, int y) {
        if (_sess == null || _sess.IsDead) return;
        HumanMoveTo(x, y);
        Thread.Sleep(RI(70, 210));                       // 落点后悬停，真人也这样
        SendMouse("mouseMoved", x + RI(-1, 1), y + RI(-1, 1), 0, 0, 1000);
        Thread.Sleep(RI(15, 55));
        SendMouse("mousePressed", x, y, 1, 1, 1500);
        Thread.Sleep(RI(55, 145));                       // 按压时长
        SendMouse("mouseReleased", x, y, 0, 1, 1500);
        _clicks++;
    }

    // 读页面登记的点击请求并执行真点击
    static void ServiceClick() {
        if (_sess == null || _sess.IsDead) return;
        string r = _sess.Call("Runtime.evaluate",
            "{\"expression\":\"window.__DYE_CLICK_REQ?window.__DYE_CLICK_REQ():''\",\"returnByValue\":true}", 2000);
        if (r == null) return;
        Match m = Regex.Match(r, "\"value\"\\s*:\\s*\"(\\d+),(-?\\d+),(-?\\d+)\"");
        if (!m.Success) return;
        int id = int.Parse(m.Groups[1].Value);
        int x = int.Parse(m.Groups[2].Value);
        int y = int.Parse(m.Groups[3].Value);
        HumanClick(x, y);
        Log("realclick " + x + "," + y + " #" + _clicks + " (id=" + id + ")");
        _sess.Call("Runtime.evaluate",
            "{\"expression\":\"window.__DYE_CLICK_DONE?window.__DYE_CLICK_DONE(" + id + "):0\",\"returnByValue\":true}", 1000);
    }

    // 抖音档位只在"真实鼠标停在齿轮上"时才渲染，且鼠标一移开就塌回去。
    // 页面脚本没法自己做 CSS :hover，所以由这里在每一轮注入检查里，
    // 只要脚本请求了坐标就立刻把指针移过去 —— 越及时越好，否则档位会塌。
    static void ServiceHover() {
        if (_sess == null || _sess.IsDead) return;
        string r = _sess.Call("Runtime.evaluate",
            "{\"expression\":\"window.__DYE_HOVER_REQ?window.__DYE_HOVER_REQ():''\",\"returnByValue\":true}", 3000);
        if (r == null) return;
        Match m = Regex.Match(r, "\"value\"\\s*:\\s*\"(\\d+),(\\d+)\"");
        if (!m.Success) return;
        int x = int.Parse(m.Groups[1].Value);
        int y = int.Parse(m.Groups[2].Value);

        // 关键：坐标没变就不发事件。
        // 旧版每 600ms 往同一坐标补一发 mouseMoved，一次播放能攒上千条零方差记录 ——
        // 真人手指停住后就不再产生 mousemove，这是最容易识别的自动化特征之一。
        if (x == _hoverStuckX && y == _hoverStuckY) {
            _hoverCount++;
            return;
        }
        _hoverStuckX = x; _hoverStuckY = y;
        HumanMoveTo(x, y);          // 不再直接 dispatch，走人类轨迹
        _hoverCount++;
        if (_hoverCount <= 6 || _hoverCount % 20 == 0) Log("hover " + x + "," + y + " #" + _hoverCount);
    }

    // ==================== 作息 ====================
    // 7x24 固定节律是最容易长期被封的特征：平台看一眼活跃曲线就知道不是人。
    // 人类有睡眠、有午休、有波动，这里按小时权重 + 随机抽样近似。
    static readonly int[] HOUR_WEIGHT = {
        //  0   1   2   3   4   5   6   7   8   9  10  11
            6,  2,  1,  0,  0,  0,  3, 20, 42, 58, 68, 56,
        // 12  13  14  15  16  17  18  19  20  21  22  23
           38, 46, 58, 66, 70, 68, 74, 80, 72, 52, 26, 12
    };
    static bool InHumanHours() {
        return _rng.Next(0, 100) < HOUR_WEIGHT[DateTime.Now.Hour];
    }

    static void CdpLoop() {
        int fails = 0;
        bool wasUp = false;
        bool everOk = false;
        while (_cdpAlive) {
            bool ok = false;
            bool idle = !InHumanHours();     // 非活跃时段：只维持连接，不做任何动作
            try {
                if (EndpointUp()) {
                    if (!wasUp) { Log("cdp endpoint up on " + _port); wasUp = true; }
                    if (EnsureSession()) {
                        if (idle) {
                            ok = true;           // 连接维持住即可，别碰页面
                        } else {
                            ok = EnsureScript();
                            ServiceHover();
                            ServiceClick();
                        }
                    }
                    else fails++;                       // 还没有真正的抖音页面，稍后再看
                } else if (wasUp) {
                    Log("cdp endpoint gone");
                    wasUp = false;
                    DropSession();
                    fails++;
                }
            } catch (Exception ex) {
                Log("cdp err " + ex.GetType().Name);
                fails++;
            }
            if (ok) { fails = 0; everOk = true; }
            if (fails == 20) { DropSession(); fails = 0; }   // 长时间不通就重连一次
            // 装好之后连得快一点：画质选择要在最优档位渲染出来时及时点掉，
            // 太慢会错过时机。但间隔必须随机 —— 固定 600ms 本身就是机器节律。
            int sleep;
            if (idle) sleep = RI(4000, 9000);
            else if (ok) sleep = RI(130, 300);
            else sleep = RI(420, 680);
            for (int i = 0; i < sleep / 100 && _cdpAlive; i++) Thread.Sleep(100);
            Thread.Sleep(sleep % 100);
        }
        if (!everOk) Log("cdp never attached");
        DropSession();
    }

    // ==================== 主程序 ====================
    // 持久身份：profile 必须放在 LOCALAPPDATA 里长期保留。
    // 旧版放在 %TEMP%\dyweb\profile —— 那是会被磁盘清理/系统更新/重启抹掉的位置，
    // 每被清一次就等于"新设备登录"，比任何输入手法都更容易触发风控。
    // 注意：ext（注入脚本本体）是每次都重写的，放 TEMP 无所谓；profile 不行。
    static void Main() {
        string browser = FindBrowser();
        if (browser == null) { Environment.ExitCode = 1; return; }
        string appDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KaiDouyin");
        Directory.CreateDirectory(appDataDir);
        string baseDir = Path.Combine(appDataDir, "web");
        string extDir = Path.Combine(baseDir, "ext");
        string profile = Path.Combine(baseDir, "profile");
        _logPath = Path.Combine(appDataDir, "run.log");
        string cfg = Path.Combine(appDataDir, "win.ini");
        Directory.CreateDirectory(extDir);
        Directory.CreateDirectory(profile);
        File.WriteAllText(Path.Combine(extDir, "manifest.json"), MANIFEST);
        File.WriteAllText(Path.Combine(extDir, "c.js"), SCRIPT);
        Log("=== start ===");
        Log("profile " + profile);

        KillProfileProcesses(profile);
        Thread.Sleep(500);

        bool max; int x, y, w, h;
        LoadConfig(cfg, out max, out x, out y, out w, out h);
        _port = PickPort();
        if (_port != CDP_PORT) Log("port " + CDP_PORT + " busy -> " + _port);

        string args = "--autoplay-policy=no-user-gesture-required --remote-debugging-port=" + _port
            + " --remote-allow-origins=* --user-data-dir=\"" + profile
            + "\" --load-extension=\"" + extDir
            + "\" --no-first-run --no-default-browser-check --force-dark-mode --app=" + URL;
        if (max) args += " --start-maximized";
        else if (w > 0 && h > 0) args += " --window-size=" + w + "," + h + " --window-position=" + x + "," + y;

        Process p = Process.Start(new ProcessStartInfo(browser, args));
        uint spawnPid = (uint)p.Id;
        Log("spawn " + Path.GetFileName(browser) + " pid=" + spawnPid + " port=" + _port);

        _cdpAlive = true;
        Thread cdp = new Thread(new ThreadStart(CdpLoop));
        cdp.IsBackground = true;
        cdp.Start();

        // 不要信 Process.Start 的 pid：浏览器可能把命令行转交给真正的主进程。
        // 按 profile 找所有候选主进程，等真正那个窗口出现。
        IntPtr hwnd = IntPtr.Zero;
        uint pid = 0;
        for (int i = 0; i < 60 && hwnd == IntPtr.Zero; i++) {
            Thread.Sleep(500);
            hwnd = FindAppWindow(profile, out pid);
        }
        if (hwnd == IntPtr.Zero) { Log("no window"); _cdpAlive = false; return; }
        Log("window hwnd=0x" + hwnd.ToInt64().ToString("X") + " owner pid=" + pid);

        int lastX = 0, lastY = 0, lastW = 0, lastH = 0;
        bool lastMax = false;
        DateTime lastSave = DateTime.MinValue;
        int lostCount = 0;
        while (true) {
            // 窗口可能被替换（最大化/还原、全屏切换会换 hwnd），丢了就重新找
            if (!IsWindow(hwnd)) {
                IntPtr again = FindAppWindow(profile, out pid);
                if (again == IntPtr.Zero) {
                    if (++lostCount > 10) break;             // 连续 5 秒没有窗口才算真的关了
                    Thread.Sleep(500);
                    continue;
                }
                hwnd = again;
                lostCount = 0;
                Log("window re-acquired 0x" + hwnd.ToInt64().ToString("X"));
            }
            RECT r;
            if (GetWindowRect(hwnd, out r)) {
                int cx = r.L, cy = r.T, cw = r.R - r.L, ch = r.B - r.T;
                bool cmax = (GetWindowLong(hwnd, GWL_STYLE) & WS_MAXIMIZE) != 0;
                bool minimized = IsIconic(hwnd);
                if (!minimized && cw > 0 && ch > 0) {
                    int screenW = GetSystemMetrics(SM_CXSCREEN);
                    int screenH = GetSystemMetrics(SM_CYSCREEN);
                    if (!cmax || (cw < screenW - 16 || ch < screenH - 16)) {
                        lastX = cx; lastY = cy; lastW = cw; lastH = ch; lastMax = cmax;
                    }
                    if (DateTime.Now - lastSave > TimeSpan.FromSeconds(2)) {
                        SaveConfig(cfg, lastX, lastY, lastW, lastH, lastMax);
                        lastSave = DateTime.Now;
                    }
                }
            }
            Thread.Sleep(400);
        }
        _cdpAlive = false;
        if (lastW > 0 && lastH > 0)
            SaveConfig(cfg, lastX, lastY, lastW, lastH, lastMax);
        Log("=== exit injections=" + _injectCount + " ===");
    }
}
