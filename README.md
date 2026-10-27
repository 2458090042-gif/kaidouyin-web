# 开抖音 · 网页版增强（CDP 注入）

一个**独立单文件 exe**：拉起你自己的 Chrome / Edge，打开 douyin.com，通过 CDP 把增强脚本注入进去。

- **不打包浏览器**，用你本机已登录的浏览器 profile，不碰账号密码
- **不改网页源码**，注入的是运行时脚本
- **不联网上传任何东西**，所有逻辑跑在本地

## ✨ 功能

| 功能 | 说明 |
|---|---|
| 🎚️ 自动最高画质 | 起播后自动选当前可用的最高档（8K/4K/原画/蓝光…），画质上限可配置 |
| 🖱️ 单击进全屏 | 只对**真人点击**（`isTrusted`）触发，脚本合成的点击一律不理，避免误灰屏 |
| 🪟 窗口位置记忆 | 关掉再开，窗口还原到上次的位置和大小（存 `%LOCALAPPDATA%\KaiDouyin\win.ini`） |
| 🤖 拟人化交互 | 贝塞尔曲线鼠标移动 + 随机点击/悬停，可限定时段 |
| 🔌 端口自适应 | 9222 被占用时自动挑空闲端口，复用已有调试实例 |

## 🧠 它解决的核心问题

抖音播放器的画质菜单**不是 DOM 里现成就有的**：档位 item 平时塌成 `0×0`，只有真实鼠标停在齿轮上才会渲染出尺寸。而且它有两个 `.gear`，展开时其中一个的 `innerText` 会被整段菜单文字污染。

所以纯 JS 做不到——脚本必须**请求主进程移动真实指针**（`Input.dispatchMouseEvent`），这就是为什么方案是「C# 驱动 + JS 注入」两层结构，而不是一个浏览器扩展。

`c.js` 里有一条通道：

```js
window.__DYE_HOVER_REQ   // JS 侧发起：请把指针移到齿轮上
```

`main.cs` 的 `ServiceHover()` 轮询这个标志，用贝塞尔轨迹把真实指针移过去，档位才渲染出来，然后 JS 再点击。

## 📦 两种用法

### 方式一：装驱动 exe（推荐）

```powershell
# 需要 Windows PowerShell 5.1（系统自带）与 .NET Framework
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1

# 生成 c1.js 版（画质封顶 1080P）
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 -JsFile c1.js -ExeSuffix 1
```

`build.ps1` 会把 `main.cs` 里的 `__MANIFEST__` / `__SCRIPT__` 占位符替换成 `manifest.json` 与目标 js 的内容，用 `Add-Type` 编成单个 exe，**输出到 `dist/`**。

> ⚠️ **改 `build.ps1` 时注意文件编码**：必须存成 **UTF-8 带 BOM**。
> PowerShell 5.1 读无 BOM 的文件时会按 GBK 解析中文注释，导致后续整段代码被吞，报 `Empty path name is not legal`。

### 方式二：纯 JS，不编译

`c.js` 是一段普通脚本，可以：

- 在 DevTools 的 Console 里整段粘贴执行（刷新后失效）
- 存成本地书签小工具（bookmarklet）
- 自己包一层 `chrome.scripting.registerContentScripts` 做成 MV3 扩展
- 或手动用 `--remote-debugging-port=9222` 启动浏览器，再通过 `/json/list` + `Page.addScriptToEvaluateOnNewDocument` 下发

**但注意**：脱离 `main.cs` 的话，hover 通道没有实现，画质菜单不会展开，只能验证脚本加载成功（`window.__DYE_OK === 1`），**验证不了画质切换**。

## 🛠️ 代码结构

```
kaidouyin-src/
├── main.cs               # 驱动本体（C# 单文件，约 900 行）
├── c.js                  # 注入脚本：画质不限（CAP = 1000）
├── c1.js                 # 由 c.js 派生，只把 CAP 改成 60（1080P 封顶）
├── manifest.json         # MV3 content script 声明，编译时嵌入 exe
├── build.ps1             # 占位符替换 + Add-Type 编译 → dist/
├── win.ini.example       # 窗口配置示例
└── tests/
    ├── fixture.html      # 复刻抖音播放器结构的假页面，不用开真站
    ├── harness.py        # 对 fixture 注入新旧脚本做对比
    ├── regress.py        # 多场景回归：直播优先 / 连续刷视频 / 全屏次数
    ├── e2e_check.py      # 端到端：跑真实 exe，验注入常驻与导航后重装
    ├── test_cdp_inject.py# CDP 注入实验
    └── verify_trusted.*  # 验证 Input.dispatchMouseEvent 产生的 isTrusted
```

`tests/fixture.html` 的关键设计是**忠实复刻真实站点的坑**：

| 复刻的行为 | 为什么重要 |
|---|---|
| 档位 item 未展开时 `width:0;height:0` | 用 `offsetWidth` 判断可见性会误判 |
| 两个 `.gear`，展开时其中一个被菜单文字填满 | 直接读齿轮文字会拿到整段菜单 |
| `currentSrc` / `src` 恒返回同一个 `blob:` 地址 | 用 `currentSrc` 当视频身份会永远失效 |
| `duration` 在 live 模式下返回 `Infinity` | 拿不存在的时长做标识会崩 |

跑测试前请显式指定端口，别误连到你正在用的浏览器：

```powershell
py -3 tests\harness.py new --port 9333
```

`main.cs` 内部按注释分段：

| 段落 | 行号区间 | 职责 |
|---|---|---|
| 日志 | 41 | 写 `%LOCALAPPDATA%\KaiDouyin\run.log` |
| 窗口 | 52 | 按 `user-data-dir` 反查窗口、EnumWindows 找主窗口 |
| 配置 | 167 | 读写 `win.ini` |
| 端口 | 195 | 挑空闲端口、探测 `/json/version` |
| CDP 传输 | 213 | 自写的 WebSocket 客户端 + JSON 字段提取 |
| 注入 | 322 | `Page.enable` → `Page.addScriptToEvaluateOnNewDocument` → probe 校验 |
| 真实鼠标 | 418 | 贝塞尔轨迹 + `Input.dispatchMouseEvent` |
| 作息 | 535 | 限定交互时段 |
| 主程序 | 593 | 找浏览器、拼启动参数、主循环 |

## ⚠️ 已知坑（改代码前先看）

这几条是实际踩出来的，`c.js` 顶部的注释里也有：

1. **`Page.addScriptToEvaluateOnNewDocument` 必须先 `Page.enable`**，否则静默不生效。
2. **MSE 会让 `currentSrc` 复用 `blob:` 地址**，拿它当视频身份会让第一个视频之后的全部失效。脚本改用「播放器节点 + 时长 + 分辨率」做身份。
3. **别拿齿轮文字变化当切换成功条件**：智能画质模式下文字恒定，会死循环。
4. **全屏只认 `isTrusted`**，且最多 3 次即锁定，否则会反复灰屏。
5. **`build.ps1` 必须 UTF-8 带 BOM**，见上文。

## 🔧 可调参数

`c.js` 顶部：

```js
var CAP = 1000;        // 画质上限分；60 = 1080P
var TICK = 1000;       // 巡检间隔 ms
var PANEL_WAIT = 1700; // 点齿轮后等菜单出现的最长时间
var OPEN_GAP = 5000;   // 两次开面板的硬间隔
var MAX_TRIES = 3;
```

改完重新跑 `build.ps1`；只想换画质上限就用 `-JsFile c1.js`。

## 📄 免责

本项目仅用于**学习 CDP 协议、浏览器自动化与前端脚本注入**。请在你自己的账号与设备上使用；作者不对使用后果负责，也不提供绕过平台限制的支持。

## License

MIT
