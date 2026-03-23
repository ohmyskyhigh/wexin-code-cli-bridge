# weixin-cc-connection

Bridge your WeChat messages to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI — chat with Claude directly from WeChat.

## What It Does

This project connects WeChat to the Claude Code CLI through the [iLink](https://ilinkai.weixin.qq.com) bot protocol. When someone sends you a WeChat message, the bridge forwards it to Claude Code, and sends Claude's response back to WeChat automatically.

```
WeChat User → iLink API → This Bridge → Claude Code CLI → response → iLink API → WeChat User
```

### Features

- **QR code login** — scan with WeChat to connect, no manual token setup
- **Per-user sessions** — each WeChat user gets their own Claude conversation with `--resume` support
- **Voice message support** — automatically uses voice-to-text transcription
- **Quoted message context** — includes referenced messages for better context
- **Typing indicators** — shows "typing..." in WeChat while Claude is thinking
- **Markdown → plain text** — strips markdown formatting for clean WeChat display
- **Long message chunking** — splits long responses into multiple WeChat messages
- **Session reset** — send `/clear` in WeChat to start a fresh conversation
- **YOLO mode** — `--yolo` flag to skip Claude permission prompts
- **Graceful shutdown** — handles SIGINT/SIGTERM for clean exit

## Prerequisites

- **Node.js** >= 22
- **Claude Code CLI** installed and authenticated (`claude` command available in PATH)
- A WeChat account

## Setup

```bash
# Clone the repo
git clone https://github.com/<your-username>/wexin-cc-connection.git
cd wexin-cc-connection

# Install dependencies
npm install
```

## Usage

### Step 1: Login with WeChat

```bash
npm run login
```

A QR code will appear in your terminal. Scan it with WeChat to authorize the connection. Your credentials are saved locally to `~/.weixin-cc/`.

### Step 2: Start the Bridge

```bash
npm start

# Or with YOLO mode (skip all Claude permission prompts):
npm run start:yolo
```

The bridge starts a long-polling loop listening for incoming WeChat messages. When a message arrives, it:

1. Extracts the text content (supports text, voice-to-text, and quoted messages)
2. Sends a typing indicator to WeChat
3. Invokes `claude -p "<message>" --output-format json` (with `--resume` for ongoing sessions)
4. Converts Claude's markdown response to plain text
5. Sends the reply back through WeChat

### WeChat Commands

| Command | Description |
|---------|-------------|
| `/clear` | Reset your Claude session, next message starts a new conversation |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WEIXIN_CC_MODEL` | Claude model override (e.g. `sonnet`, `haiku`) | Claude Code default |
| `WEIXIN_CC_STATE_DIR` | Directory for storing state (accounts, sessions, sync cursors) | `~/.weixin-cc/` |
| `WEIXIN_CC_LOG_LEVEL` | Log level: `DEBUG`, `INFO`, `WARN`, `ERROR` | `INFO` |

## Project Structure

```
src/
├── index.ts          # CLI entry point (login / start commands)
├── bridge.ts         # Main long-poll loop, message processing
├── claude-runner.ts  # Spawns Claude Code CLI, manages per-user sessions
├── state.ts          # Account, session, and sync cursor persistence
├── logger.ts         # Simple leveled logger
├── util.ts           # ID generation helpers
└── ilink/
    ├── api.ts        # HTTP client for iLink bot API
    ├── login.ts      # QR code login flow
    ├── send.ts       # Message sending + markdown-to-plaintext
    └── types.ts      # iLink protocol type definitions
```

## How WeChat Connection Works

This project uses WeChat's **iLink bot protocol** (`ilinkai.weixin.qq.com`):

1. **Login**: The CLI fetches a QR code from iLink's `/ilink/bot/get_bot_qrcode` endpoint and displays it in the terminal. You scan it with WeChat and confirm on your phone. The server returns a `bot_token` and `ilink_bot_id`.

2. **Receiving messages**: The bridge long-polls `/ilink/bot/getupdates` with a sync cursor. When new messages arrive, the cursor advances to track position.

3. **Sending replies**: Responses go through `/ilink/bot/sendmessage`. Each reply must include the `context_token` from the original inbound message.

4. **Typing indicators**: The bridge calls `/ilink/bot/sendtyping` to show/hide the typing status in WeChat.

## License

MIT
