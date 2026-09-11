<div align="center">

# ChatGPT Route Inspector

![Stars](https://img.shields.io/github/stars/Liu-Bot24/chatgpt-route-inspector?style=flat&label=Stars&cache=20260811) ![Forks](https://img.shields.io/github/forks/Liu-Bot24/chatgpt-route-inspector?style=flat&label=Forks&cache=20260811) ![Views 14d](https://github-stats.liu-qi.cn/api/badge/Liu-Bot24/chatgpt-route-inspector/views14d.svg?v=4) ![Clones 14d](https://github-stats.liu-qi.cn/api/badge/Liu-Bot24/chatgpt-route-inspector/clones14d.svg?v=4) ![Downloads](https://img.shields.io/github/downloads/Liu-Bot24/chatgpt-route-inspector/total?style=flat&label=Downloads&cache=20260811) ![Release](https://img.shields.io/github/v/release/Liu-Bot24/chatgpt-route-inspector?style=flat&label=Release&cache=20260811)

![ChatGPT 模型路由检测器预览](assets/promotional/chatgpt-route-inspector-1200x510-zh.png)

Languages: [简体中文](README.md) · [English](README-en.md)

</div>

## 产品介绍

ChatGPT Route Inspector 是一款适用于 Chromium 浏览器的 ChatGPT 模型路由检测扩展。它能够同时显示网页端发送的请求模型与服务器响应报告的路由模型，帮助用户核验 Pro 请求是否仍由 Pro 响应，或是否被路由到其他模型。

扩展直接读取请求与响应中可用的模型信息，不根据回答速度、写作风格、主观质量或模型自述推测结果。

本项目是独立的非官方工具，与 OpenAI 不存在隶属、授权或背书关系。

## 界面预览

以下示例展示请求模型为 `GPT 5.6 Pro`、响应路由为 `GPT 5.5 mini` 时的界面。

### Popup

<p align="center">
  <img src="docs/images/popup-zh.png" width="640" alt="ChatGPT Route Inspector 中文 Popup">
</p>

### 页面浮窗

<p align="center">
  <img src="docs/images/overlay-zh.png" width="420" alt="ChatGPT Route Inspector 中文页面浮窗">
</p>

### 路由诊断台

<p align="center">
  <img src="docs/images/dashboard-zh.png" width="100%" alt="ChatGPT Route Inspector 中文路由诊断台">
</p>

## 功能

- **实时请求检测**：发送新消息后，显示本轮请求模型与响应路由。
- **自动推理标记**：响应路由为 `gpt-5-6-auto-thinking` 或 `gpt-5-5-auto-thinking` 时，单独显示“自动推理”，并保留原始模型字段。
- **会话重载检测**：刷新已有会话，读取已完成回答中可用的响应路由信息。
- **页面浮窗**：在 ChatGPT 页面直接查看结果，支持完整、极简、迷你、边缘收纳和隐藏状态。
- **路由诊断台**：查看本机记录、证据信息，并导出 Markdown 或 JSON 报告。
- **额度快照**：在诊断台查看捕获时收到的深度研究、图片生成剩余额度及重置时间（北京时间）。只读取页面已有响应，不主动查询；未捕获的数据不补算，旧记录不会被新额度覆盖。
- **PoW 难度显示**：显示原始十六进制难度值及其十进制换算结果。
- **中英文界面**：Popup、浮窗、诊断台、设置和报告均支持中文与英文。
- **本地优先**：检测记录保存在当前浏览器，不上传到第三方服务器。

## 安装

### 从 Chrome 应用商店安装

[在 Chrome 应用商店安装 ChatGPT 模型路由检测器](https://chromewebstore.google.com/detail/fbbnebcnkekjjmenncangmdhojamjcli)

### 手动安装发布包

1. 从[最新 Release](https://github.com/Liu-Bot24/chatgpt-route-inspector/releases/latest) 下载并解压 `chatgpt-route-inspector-版本号.zip`。
2. 打开 `chrome://extensions/`。
3. 开启右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择解压后的扩展目录。
6. 刷新已经打开的 ChatGPT 页面。

### 从源码构建

需要 Node.js 20 或更高版本。

```powershell
npm ci
npm run build
```

构建后的扩展位于 `dist/extension`。在 `chrome://extensions/` 中选择“加载已解压的扩展程序”，然后选择该目录。

## 使用方法

### 检测新回答

1. 打开 ChatGPT 并进入目标会话。
2. 点击扩展图标，选择“实时请求”。
3. 在 ChatGPT 中选择模型并发送一条消息。
4. 在 Popup 或页面浮窗中查看“请求模型 → 响应路由”。

### 复查已有回答

1. 在 Popup 中选择“会话重载”。
2. 刷新当前 ChatGPT 会话。
3. 查看该会话中已读取到的响应路由。

### 管理页面浮窗

- 点击右上角的“极简模式”按钮，可显示请求模型、响应路由和 PoW 难度。
- 点击“迷你模式”按钮，可将浮窗贴靠到右侧边缘，仅显示响应路由值和 PoW 十进制值。
- 点击极简浮窗可恢复完整状态。
- 在迷你浮窗中，点击左侧窄边区域可将其收纳到窗口右侧；点击其余内容区域可恢复完整状态。
- 点击收纳后保留在窗口右侧的窄边条，可恢复迷你浮窗。
- 点击“隐藏浮窗”后，浮窗会从页面完全消失。
- 如需重新显示，请在扩展 Popup 中点击“显示浮窗”。

## 结果说明

| 显示内容 | 含义 |
|---|---|
| 请求模型 | ChatGPT 网页端为本轮消息发送的模型 |
| 响应路由 | 服务器响应中报告的本轮路由模型 |
| 模型标签 | 回答记录附带的模型标签，仅作为补充信息 |
| PoW 难度 | 原始十六进制值及其十进制换算结果 |

如果某项显示为 `—`，表示本轮没有读取到对应信息。扩展不会对缺失结果进行猜测。

如需使用 Chrome DevTools 进行交叉核验，请参阅 [Chrome 手工核验指南](docs/chrome-manual-verification.md)。

## 隐私与权限

完整的数据处理说明请参阅 [隐私政策](PRIVACY.md)。

扩展仅保存路由检测所需的数据，包括模型信息、PoW 难度、时间、耗时、记录来源和扩展设置。

扩展不会保存或上传：

- 提示词和回答正文；
- Cookie、登录凭据或其他身份验证信息；
- 附件内容与文件名；
- 未经筛选的网络请求、响应或 HAR 文件。

### 浏览器权限

| 权限 | 用途 |
|---|---|
| `storage` | 在本机保存设置与检测记录 |
| `chatgpt.com` / `chat.openai.com` | 在支持的 ChatGPT 页面读取模型路由信息 |

扩展不申请 `debugger` 权限，也不监控其他网站或一般浏览器流量。

## 兼容性与限制

- 支持 Chrome 111 及更高版本，以及其他兼容 Manifest V3 的 Chromium 浏览器。
- 扩展只观察并显示信息，不会修改 ChatGPT 请求、响应、模型选择、账号权限或用量限制。
- 可显示的内容取决于 ChatGPT 网页响应中实际提供的信息；网站结构更新后，部分信息可能暂时无法读取。
- PoW 难度仅作为原始数值展示，不代表 OpenAI 官方的账号状态或风险结论。

## 开发

```powershell
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run package
```

发布包与 SHA-256 校验文件输出到 `release/`。

## 友情链接

- [LINUX DO](https://linux.do/) — 新的理想型社区

## 免责声明

本项目不隶属于 OpenAI，也未获得 OpenAI 官方认可。ChatGPT、OpenAI 及相关标识是其各自权利人的商标。扩展仅展示 ChatGPT 网页请求与响应中可读取的信息，不构成对 OpenAI 内部基础设施、计费系统或账号状态的官方证明。
