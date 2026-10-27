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

## 📦 两种用法

### 方式一：装驱动 exe（推荐）

```powershell
# 需要 Windows PowerShell 5.1（系统自带）与 .NET Framework
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1

# 生成 c1.js 版（画质封顶 1080P）
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 -JsFile c1.js -ExeSuffix 1
```

`build.ps1` 会把 `main.cs` 里的 `__MANIFEST__` / `__SCRIPT__` 占位符替换成 `manifest.json` 与目标 js 的内容，用 `Add-Type` 编成单个 exe 放到上层目录。

### 方式二：纯 JS，不编译

`c.js` 就是一段普通脚本，可以：

- 在 DevTools 的 Console 里整段粘贴执行（刷新后失效）
- 存成本地书签小工具（bookmarklet）
- 自己包一层 `chrome.scripting.registerContentScripts` 做成 MV3 扩展
- 或者手动用 `--remote-debugging-port=9222` 启动浏览器，再通过 `/json/list` + `Page.addScriptToEvaluateOnNewDocument` 下发

## 🛠️ 代码结构

```
kaidouyin-src/
├── main.cs            # 驱动本体（C# 单文件，约 900 行）
├── c.js               # 注入脚本：画质不限（CAP = 1000）
├── c1.js              # 由 c.js 派生，只把 CAP 改成 60（1080P 封顶）
├── manifest.json      # MV3 content script 声明，编译时嵌入 exe
├── build.ps1          # 占位符替换 + Add-Type 编译 + 输出 exe
├── fixture.html       # 本地假页面，不用开真站也能调 UI 逻辑
├── harness.py         # 测试驱动
├── regress.py         # 回归套件
└── probe*.py / test_*.py / verify_*.js   # 各类探针与验证脚本
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

这几条是实际踩出来的，注释里也有：

1. **`Page.addScriptToEvaluateOnNewDocument` 必须先 `Page.enable`**，否则静默不生效。
2. **MSE 会让 `currentSrc` 复用 `blob:` 地址**，拿它当视频身份会让第一个视频之后的全部失效。脚本改用「播放器节点 + 时长 + 分辨率」做身份。
3. **别拿齿轮文字变化当切换成功条件**：智能画质模式下文字恒定，会死循环。
4. **全屏只认 `isTrusted`**，且最多 3 次即锁定，否则会反复灰屏。

## 🔧 可调参数

`c.js` 顶部：

```js
var CAP = 1000;        // 画质上限分；60 = 1080P
var TICK = 1000;       // 巡检间隔 ms
var PANEL_WAIT = 1700; // 点齿轮后等菜单出现的最长时间
var OPEN_GAP = 5000;   // 两次开面板的硬间隔
var MAX_TRIES = 3;
```

改完重新跑 `build.ps1` 即可；只想换画质上限就用 `-JsFile c1.js`。

## 📄 免责

本项目仅用于**学习 CDP 协议、浏览器自动化与前端脚本注入**。请在你自己的账号与设备上使用；作者不对使用后果负责，也不提供绕过平台限制的支持。

## License

MIT
