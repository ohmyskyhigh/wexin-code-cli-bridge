# WeChat ↔ Claude Code Bridge — Initial Build

## Objective
Analyze `@tencent-weixin/openclaw-weixin` package and build a standalone bridge that connects WeChat to Claude Code CLI instead of OpenClaw.

## Changes Made

### New files created (10 source files):
- `package.json` / `tsconfig.json` — Project setup (ESM, Node22, deps: qrcode-terminal, tsx, typescript)
- `src/ilink/types.ts` — WeChat iLink protocol types (extracted from openclaw-weixin, no changes)
- `src/ilink/api.ts` — HTTP API layer: getUpdates, sendMessage, sendTyping, getConfig (stripped openclaw deps)
- `src/ilink/send.ts` — Outbound message builder with markdown→plaintext conversion (stripped openclaw deps)
- `src/ilink/login.ts` — QR code login flow (stripped openclaw deps)
- `src/util.ts` — ID generation and randomWechatUin helper
- `src/logger.ts` — Simple console logger replacing OpenClaw's JSON-line file logger
- `src/state.ts` — Account credential and sync cursor storage under ~/.weixin-cc/
- `src/claude-runner.ts` — Spawns `claude -p` CLI with per-user deterministic session IDs
- `src/bridge.ts` — Core long-poll loop: getUpdates → parse → invoke Claude → sendMessage with retry/backoff
- `src/index.ts` — CLI entry point with login/start/help commands

## Result
Build is complete and passes `tsc --noEmit` with zero errors. CLI runs correctly (`help` and `start` without login both work as expected). Ready for end-to-end testing with a real WeChat QR scan via `npm run login` followed by `npm start`.

Goal achieved: standalone WeChat→Claude Code bridge with no OpenClaw dependency.
