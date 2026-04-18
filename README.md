# wexin-code-cli-bridge

把你的微信消息桥接到 AI 编程 CLI —— 支持 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、[Codex CLI](https://github.com/openai/codex)，直接在微信里跟 AI 对话。

## 它做了什么

这个项目通过微信的 [iLink](https://ilinkai.weixin.qq.com) Bot 协议，把微信和 AI 编程 CLI 连起来。当有人给你发微信消息时，桥接程序会自动把消息转发给选定的 CLI，然后把回复发回微信。

```
微信用户 → iLink API → 本桥接 → CLI (Claude/Gemini/Codex) → 回复 → iLink API → 微信用户
```

### 功能特性

- **多 CLI 后端** —— 支持 Claude Code、Gemini CLI、Codex CLI，通过 `--cli` 切换
- **图片和文件传输** —— 在微信发送图片或文件，AI 可以直接分析；AI 生成的文件也会自动发回微信
- **扫码登录** —— 微信扫一扫即可连接，首次启动自动触发登录
- **独立会话** —— 每个微信用户 × 每个 CLI 拥有独立对话，支持上下文延续
- **语音转文字** —— 自动识别语音消息的文字内容
- **引用消息** —— 引用回复会自动携带原文上下文
- **输入状态** —— AI 思考时在微信端显示"正在输入..."
- **Markdown 转换** —— 自动将 Markdown 格式转为纯文本
- **长消息分段** —— 超长回复自动拆分为多条微信消息
- **会话重置** —— 在微信发送 `/clear` 即可开启全新对话
- **CLI 发送工具** —— `wcc send` 命令直接从终端发送文本、图片或文件到微信
- **YOLO 模式** —— `--yolo` 参数跳过所有权限确认
- **自动重连** —— iLink 会话过期时自动触发重新登录
- **优雅退出** —— 支持 SIGINT/SIGTERM 信号安全退出

### 图片和文件传输

**接收（微信 → AI）：** 微信发送的图片或文件会从 CDN 下载并 AES 解密，保存为临时文件后传给 CLI 后端。Claude Code 原生支持 `--files`，Gemini 和 Codex 则将文件内容以代码块形式内嵌到提示词中。仅发图片不带文字时，自动补充提示词"请描述这张图片"。

**发送（AI → 微信）：** AI 回复中出现的文件路径（如 `/path/to/output.png`）会被自动检测，AES 加密后上传到 CDN，以图片或文件消息的形式发回微信。

临时文件在使用后立即清理，后台每 5 分钟自动清理过期文件。

## 前置条件

- **Node.js** >= 22
- 至少安装以下 CLI 中的一个（并完成认证）：
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（`claude` 命令）
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli)（`gemini` 命令，`npm i -g @google/gemini-cli`）
  - [Codex CLI](https://github.com/openai/codex)（`codex` 命令，`npm i -g @openai/codex`）
- 一个微信账号

## 安装

```bash
git clone https://github.com/ohmyskyhigh/wexin-code-cli-bridge.git
cd wexin-code-cli-bridge
npm install
```

全局安装（可选）：

```bash
npm run build && npm install -g .
```

## 使用方法

直接启动即可，首次运行会自动弹出微信扫码登录：

```bash
# 使用 Claude Code（默认）
wcc start --yolo

# 使用 Gemini CLI
wcc start --cli gemini --yolo

# 使用 Codex CLI
wcc start --cli codex --yolo

# 指定模型
wcc start --cli gemini -m gemini-2.5-flash --yolo
```

也可以用 npm scripts（无需全局安装）：

```bash
npm run start:yolo                              # Claude（默认）
npx tsx src/cli.ts start --cli gemini --yolo    # Gemini
npx tsx src/cli.ts start --cli codex --yolo     # Codex
```

> **为什么推荐 YOLO 模式？** AI CLI 在执行操作时会频繁请求权限确认（读取文件、运行命令等）。由于桥接程序以非交互模式运行，无法在微信端进行权限确认。`--yolo` 跳过所有权限提示，对应各 CLI 的：Claude `--dangerously-skip-permissions`、Gemini `--yolo`、Codex `--full-auto`。

### CLI 选项

```
Usage: wcc start [options]

Options:
  --cli <name>              Code CLI: claude (默认), gemini, codex
  --yolo                    跳过所有权限确认
  -m, --model <model>       模型覆盖 (如 sonnet, gemini-2.5-flash, gpt-5.2-codex)
  --cdn-base-url <url>      CDN 基础 URL（用于媒体上传/下载）
  -h, --help                显示帮助
```

### 微信端命令

| 命令 | 说明 |
|------|------|
| `/clear` | 重置当前 CLI 会话，开启全新对话 |
| `/add-dir <路径>` | 添加可访问的目录 |
| `/rm-dir <路径>` | 移除已添加的目录 |
| `/dirs` | 查看当前目录列表 |
| `/clear-dirs` | 清除所有额外目录 |
| `/cleanup` | 清理临时文件 |
| `/help` | 显示所有可用命令 |

直接发送图片或文件即可让 AI 分析，无需命令。

### `wcc send` — 从终端发送消息

```bash
# 发送文本
wcc send --text "Hello from CLI"

# 发送图片
wcc send --file ./screenshot.png

# 发送文件并附带文字说明
wcc send --file ./report.pdf --text "这是报告"

# 指定目标用户（默认使用最近通信的用户）
wcc send --to <userId> --text "Hi"
```

```
Usage: wcc send [options]

Options:
  --to <userId>             目标微信用户 ID（默认使用最近用户）
  --text <message>          文本消息
  --file <path>             发送图片或文件
  --context-token <token>   上下文 token（默认从缓存读取）
  --cdn-base-url <url>      CDN 基础 URL
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `WEIXIN_CC_CLI` | CLI 后端（`claude`/`gemini`/`codex`），`--cli` 的备选 | `claude` |
| `WEIXIN_CC_MODEL` | 模型覆盖，`-m` 的备选 | 各 CLI 默认 |
| `WEIXIN_CC_STATE_DIR` | 状态存储目录（账号、会话、同步游标） | `~/.weixin-cc/` |
| `WEIXIN_CDN_BASE_URL` | CDN 基础 URL，`--cdn-base-url` 的备选 | — |
| `WEIXIN_CC_LOG_LEVEL` | 日志级别：`DEBUG`、`INFO`、`WARN`、`ERROR` | `INFO` |

## 项目结构

```
src/
├── cli.ts            # CLI 入口 (commander)，含 start/login/send 命令
├── bridge.ts         # 主长轮询循环，消息处理，媒体收发
├── state.ts          # 账号、会话、同步游标、上下文 token 持久化
├── logger.ts         # 简单分级日志
├── util.ts           # ID 生成工具
├── backend/
│   ├── types.ts      # BackendRunner 接口定义 + FileAttachment
│   ├── exec.ts       # 共享 execFileAsync 工具
│   ├── claude.ts     # Claude Code 后端（原生 --files 支持）
│   ├── gemini.ts     # Gemini CLI 后端（文件内容内嵌消息）
│   ├── codex.ts      # Codex CLI 后端（文件内容内嵌消息）
│   └── index.ts      # 后端工厂 + 导出
├── ilink/
│   ├── api.ts        # iLink Bot API HTTP 客户端 + getUploadUrl
│   ├── login.ts      # 二维码登录流程
│   ├── media.ts      # CDN 媒体操作：AES 加解密、上传下载
│   ├── send.ts       # 消息发送：文本 / 图片 / 文件
│   └── types.ts      # iLink 协议类型定义
└── media/
    └── temp.ts       # 临时文件管理、文件类型检测、MIME 工具
```

## 微信连接原理

本项目使用微信的 **iLink Bot 协议**（`ilinkai.weixin.qq.com`）：

1. **登录**：CLI 从 iLink 的 `/ilink/bot/get_bot_qrcode` 接口获取二维码并在终端展示。用微信扫码确认后，服务端返回 `bot_token` 和 `ilink_bot_id`。

2. **接收消息**：桥接程序通过 `/ilink/bot/getupdates` 长轮询，使用同步游标（cursor）追踪消息位置。

3. **发送回复**：回复通过 `/ilink/bot/sendmessage` 发出。每条回复必须携带入站消息中的 `context_token`。

4. **输入状态**：桥接程序调用 `/ilink/bot/sendtyping` 来控制微信端"正在输入..."的显示和隐藏。

## 相关项目

> **[ThreadWave](https://threadwave.xyz)** —— X.com (Twitter) 桌面自动化助手。ThreadWave 是你的 X 账号的副驾驶和自动驾驶，能用你的语气发推、回复、互动。一个 Agent，四种能力：自动回复、灵感生成、自动点赞、自动关注。让小号快速成长，告别手动运营。

## License

MIT
