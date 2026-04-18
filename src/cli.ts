#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { loginWithQR } from "./ilink/login.js";
import { saveAccount, getDefaultAccount, loadContextToken, listUserIds } from "./state.js";
import { startBridge } from "./bridge.js";
import { createBackend, type BackendType } from "./backend/index.js";
import { sendMessageWeixin, sendImageWeixin, sendFileWeixin } from "./ilink/send.js";
import { uploadToWeixin } from "./ilink/media.js";
import { UploadMediaType } from "./ilink/types.js";
import { getMimeFromFilename } from "./media/temp.js";
import { logger } from "./logger.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

async function doLogin(): Promise<{ accountId: string; token: string; baseUrl: string }> {
  console.log("🔗 WeChat ↔ Code CLI Bridge — Login\n");

  const result = await loginWithQR({ apiBaseUrl: DEFAULT_BASE_URL });
  console.log(`\n${result.message}`);

  if (!result.connected || !result.botToken || !result.accountId) {
    console.error("Login failed.");
    process.exit(1);
  }

  const id = saveAccount(result.accountId, {
    token: result.botToken,
    baseUrl: result.baseUrl,
    userId: result.userId,
  });
  console.log(`Account saved: ${id}\n`);

  return {
    accountId: id,
    token: result.botToken,
    baseUrl: result.baseUrl ?? DEFAULT_BASE_URL,
  };
}

const program = new Command();

program
  .name("wcc")
  .description("Bridge WeChat messages to code CLIs (Claude Code, Gemini, Codex) via iLink protocol")
  .version("0.1.0");

program
  .command("login")
  .description("Scan QR code to connect WeChat (without starting bridge)")
  .action(async () => {
    await doLogin();
  });

program
  .command("start", { isDefault: true })
  .description("Start the message bridge (auto-login if needed)")
  .option("--cli <name>", "Code CLI to use: claude, gemini, codex", "claude")
  .option("--yolo", "Skip all permission prompts", false)
  .option("-m, --model <model>", "Model override (e.g. sonnet, gemini-2.5-flash, gpt-5.2-codex)")
  .option("--cdn-base-url <url>", "CDN base URL for media upload/download")
  .action(async (options: { cli: string; yolo: boolean; model?: string; cdnBaseUrl?: string }) => {
    const cliName = (process.env.WEIXIN_CC_CLI ?? options.cli) as string;
    const validBackends = ["claude", "gemini", "codex"];
    if (!validBackends.includes(cliName)) {
      console.error(`Unknown CLI backend: "${cliName}". Supported: ${validBackends.join(", ")}`);
      process.exit(1);
    }

    const backendType = cliName as BackendType;
    const backend = createBackend(backendType);

    // Auto-login if no account or token
    let account = getDefaultAccount();
    if (!account || !account.data.token) {
      console.log("No account found. Starting login...\n");
      const loginResult = await doLogin();
      account = {
        accountId: loginResult.accountId,
        data: { token: loginResult.token, baseUrl: loginResult.baseUrl },
      };
    }

    const model = options.model ?? process.env.WEIXIN_CC_MODEL;
    const cdnBaseUrl = options.cdnBaseUrl ?? process.env.WEIXIN_CDN_BASE_URL;

    console.log("🔗 WeChat ↔ Code CLI Bridge — Starting\n");
    console.log(`  Account:     ${account.accountId}`);
    console.log(`  CLI:         ${backendType}`);
    console.log(`  BaseURL:     ${account.data.baseUrl ?? DEFAULT_BASE_URL}`);
    if (model) {
      console.log(`  Model:       ${model}`);
    }
    if (options.yolo) {
      console.log(`  Permissions: SKIPPED (auto-approve)`);
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
        token: account.data.token!,
        accountId: account.accountId,
        abortSignal: controller.signal,
        model,
        autoApprove: options.yolo,
        backend,
        cdnBaseUrl,
        onSessionExpired: async () => {
          const creds = await doLogin();
          return creds;
        },
      });
    } catch (err) {
      if (controller.signal.aborted) {
        logger.info("Bridge shut down gracefully");
      } else {
        logger.error(`Bridge crashed: ${String(err)}`);
        process.exit(1);
      }
    }
  });

program
  .command("send")
  .description("Send a text message, image, or file to a WeChat user")
  .option("--to <userId>", "Target WeChat user ID (omit to use last known user)")
  .option("--text <message>", "Text message to send")
  .option("--file <path>", "File or image path to send")
  .option("--context-token <token>", "Context token (auto-loaded from cache if omitted)")
  .option("--cdn-base-url <url>", "CDN base URL for media upload")
  .action(async (options: { to?: string; text?: string; file?: string; contextToken?: string; cdnBaseUrl?: string }) => {
    const account = getDefaultAccount();
    if (!account?.data.token) {
      console.error("No account found. Run 'wcc login' first.");
      process.exit(1);
    }

    const baseUrl = account.data.baseUrl ?? DEFAULT_BASE_URL;
    const token = account.data.token;
    const cdnBaseUrl = options.cdnBaseUrl ?? process.env.WEIXIN_CDN_BASE_URL;

    // Resolve target user ID
    let toUserId = options.to;
    if (!toUserId) {
      const knownUsers = listUserIds();
      if (knownUsers.length === 0) {
        console.error("No known users. Start the bridge and send a message from WeChat first.");
        process.exit(1);
      }
      toUserId = knownUsers[knownUsers.length - 1];
      console.log(`Using last known user: ${toUserId}`);
    }

    // Resolve context token
    let contextToken = options.contextToken;
    if (!contextToken) {
      contextToken = loadContextToken(toUserId);
      if (contextToken) {
        console.log("Using cached context token.");
      } else {
        console.error("No context token found. Start the bridge and send a message from WeChat first.");
        process.exit(1);
      }
    }

    if (!options.text && !options.file) {
      console.error("Provide --text and/or --file");
      process.exit(1);
    }

    const sendOpts = { baseUrl, token, contextToken };

    // Send file/image if provided
    if (options.file) {
      const filePath = path.resolve(options.file);
      if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
      }

      const mime = getMimeFromFilename(filePath);
      const isImage = mime.startsWith("image/");
      const mediaType = isImage ? UploadMediaType.IMAGE : UploadMediaType.FILE;

      console.log(`Uploading ${isImage ? "image" : "file"}: ${filePath} (${mime})`);

      try {
        const uploaded = await uploadToWeixin({
          filePath,
          toUserId: toUserId,
          mediaType,
          opts: { baseUrl, token },
          cdnBaseUrl,
          label: "cli-send",
        });
        console.log(`Upload complete: filekey=${uploaded.filekey} size=${uploaded.fileSize}`);

        if (isImage) {
          const { messageId } = await sendImageWeixin({
            to: toUserId,
            text: options.text ?? "",
            uploaded,
            opts: sendOpts,
          });
          console.log(`Image sent: messageId=${messageId}`);
        } else {
          const { messageId } = await sendFileWeixin({
            to: toUserId,
            text: options.text ?? "",
            fileName: path.basename(filePath),
            uploaded,
            opts: sendOpts,
          });
          console.log(`File sent: messageId=${messageId}`);
        }
      } catch (err) {
        console.error(`Failed to upload/send: ${String(err)}`);
        process.exit(1);
      }
    } else if (options.text) {
      // Text-only
      try {
        const { messageId } = await sendMessageWeixin({
          to: toUserId,
          text: options.text,
          opts: sendOpts,
        });
        console.log(`Text sent: messageId=${messageId}`);
      } catch (err) {
        console.error(`Failed to send text: ${String(err)}`);
        process.exit(1);
      }
    }
  });

program.parse();
