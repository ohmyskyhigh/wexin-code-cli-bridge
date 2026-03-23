import { loginWithQR } from "./ilink/login.js";
import { saveAccount, getDefaultAccount } from "./state.js";
import { startBridge } from "./bridge.js";
import { logger } from "./logger.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdLogin(): Promise<void> {
  console.log("🔗 WeChat ↔ Claude Code Bridge — Login\n");

  const result = await loginWithQR({ apiBaseUrl: DEFAULT_BASE_URL });
  console.log(`\n${result.message}`);

  if (result.connected && result.botToken && result.accountId) {
    const id = saveAccount(result.accountId, {
      token: result.botToken,
      baseUrl: result.baseUrl,
      userId: result.userId,
    });
    console.log(`\nAccount saved: ${id}`);
    console.log("Run `npm start` to start the bridge.\n");
  } else {
    process.exit(1);
  }
}

async function cmdStart(): Promise<void> {
  const account = getDefaultAccount();
  if (!account) {
    console.error("No account found. Run `npm run login` first.");
    process.exit(1);
  }

  if (!account.data.token) {
    console.error("Account has no token. Run `npm run login` to re-authenticate.");
    process.exit(1);
  }

  const dangerouslySkipPermissions = hasFlag("--yolo");

  console.log("🔗 WeChat ↔ Claude Code Bridge — Starting\n");
  console.log(`  Account:     ${account.accountId}`);
  console.log(`  BaseURL:     ${account.data.baseUrl ?? DEFAULT_BASE_URL}`);
  if (dangerouslySkipPermissions) {
    console.log(`  Permissions: SKIPPED (dangerously-skip-permissions)`);
  }
  console.log("");

  const controller = new AbortController();

  const shutdown = () => {
    console.log("\nShutting down...");
    controller.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await startBridge({
      baseUrl: account.data.baseUrl ?? DEFAULT_BASE_URL,
      token: account.data.token,
      accountId: account.accountId,
      abortSignal: controller.signal,
      model: process.env.WEIXIN_CC_MODEL,
      dangerouslySkipPermissions,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      logger.info("Bridge shut down gracefully");
    } else {
      logger.error(`Bridge crashed: ${String(err)}`);
      process.exit(1);
    }
  }
}

function cmdHelp(): void {
  console.log(`
  WeChat ↔ Claude Code Bridge

  Usage:
    npx tsx src/index.ts <command> [options]

  Commands:
    login     Scan QR code to connect WeChat
    start     Start the message bridge
    help      Show this help

  Options (start):
    --yolo   Skip all Claude permission prompts

  WeChat commands (send from WeChat):
    /clear    Reset conversation (start fresh session)

  Environment variables:
    WEIXIN_CC_MODEL          Claude model override (e.g. "sonnet", "haiku")
    WEIXIN_CC_STATE_DIR      State directory (default: ~/.weixin-cc/)
    WEIXIN_CC_LOG_LEVEL      Log level: DEBUG, INFO, WARN, ERROR (default: INFO)

  npm scripts:
    npm run login    → login
    npm start        → start
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2];

switch (command) {
  case "login":
    cmdLogin();
    break;
  case "start":
    cmdStart();
    break;
  case "help":
  case "--help":
  case "-h":
    cmdHelp();
    break;
  default:
    if (command) {
      console.error(`Unknown command: ${command}\n`);
    }
    cmdHelp();
    process.exit(command ? 1 : 0);
}
