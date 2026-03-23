# weixin-cc-connection

把你的微信消息桥接到 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI —— 直接在微信里跟 Claude 对话。

## 它做了什么

这个项目通过微信的 [iLink](https://ilinkai.weixin.qq.com) Bot 协议，把微信和 Claude Code CLI 连起来。当有人给你发微信消息时，桥接程序会自动把消息转发给 Claude Code，然后把 Claude 的回复发回微信。

```
微信用户 → iLink API → 本桥接 → Claude Code CLI → 回复 → iLink API → 微信用户
```

### 功能特性

- **扫码登录** —— 微信扫一扫即可连接，无需手动配置 token
- **独立会话** —— 每个微信用户拥有独立的 Claude 对话，支持上下文延续
- **语音转文字** —— 自动识别语音消息的文字内容
- **引用消息** —— 引用回复会自动携带原文上下文
- **输入状态** —— Claude 思考时在微信端显示"正在输入..."
- **Markdown 转换** —— 自动将 Claude 的 Markdown 格式转为纯文本
- **长消息分段** —— 超长回复自动拆分为多条微信消息
- **会话重置** —— 在微信发送 `/clear` 即可开启全新对话
- **YOLO 模式** —— `--yolo` 参数跳过 Claude 的所有权限确认
- **优雅退出** —— 支持 SIGINT/SIGTERM 信号安全退出

## 前置条件

- **Node.js** >= 22
- **Claude Code CLI** 已安装并完成认证（确保 `claude` 命令在 PATH 中可用）
- 一个微信账号

## 安装

```bash
git clone https://github.com/ohmyskyhigh/wexin-cc-connection.git
cd wexin-cc-connection
npm install
```

## 使用方法

### 第一步：微信扫码登录

```bash
npm run login
```

终端会显示一个二维码，用微信扫描并确认授权。登录凭证保存在 `~/.weixin-cc/` 目录下。

### 第二步：启动桥接

```bash
npm start

# 或者使用 YOLO 模式（跳过所有 Claude 权限确认）：
npm run start:yolo
```

桥接程序启动后会通过长轮询持续监听微信消息。收到消息后：

1. 提取文字内容（支持文字、语音转文字、引用消息）
2. 在微信端显示"正在输入..."
3. 调用 `claude -p "<消息>" --output-format json`（已有会话则使用 `--resume` 延续）
4. 将 Claude 的 Markdown 回复转为纯文本
5. 将回复发回微信

### 微信端命令

| 命令 | 说明 |
|------|------|
| `/clear` | 重置 Claude 会话，下一条消息开启全新对话 |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `WEIXIN_CC_MODEL` | Claude 模型覆盖（如 `sonnet`、`haiku`） | Claude Code 默认 |
| `WEIXIN_CC_STATE_DIR` | 状态存储目录（账号、会话、同步游标） | `~/.weixin-cc/` |
| `WEIXIN_CC_LOG_LEVEL` | 日志级别：`DEBUG`、`INFO`、`WARN`、`ERROR` | `INFO` |

## 项目结构

```
src/
├── index.ts          # CLI 入口（login / start 命令）
├── bridge.ts         # 主长轮询循环，消息处理
├── claude-runner.ts  # 调用 Claude Code CLI，管理每用户会话
├── state.ts          # 账号、会话、同步游标持久化
├── logger.ts         # 简单分级日志
├── util.ts           # ID 生成工具
└── ilink/
    ├── api.ts        # iLink Bot API HTTP 客户端
    ├── login.ts      # 二维码登录流程
    ├── send.ts       # 消息发送 + Markdown 转纯文本
    └── types.ts      # iLink 协议类型定义
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
