import { getUpdates, sendTyping, getConfig } from "./ilink/api.js";
import { sendMessageWeixin, markdownToPlainText } from "./ilink/send.js";
import { MessageItemType, TypingStatus } from "./ilink/types.js";
import type { WeixinMessage, MessageItem } from "./ilink/types.js";
import { runClaude, resetSession } from "./claude-runner.js";
import { loadSyncCursor, saveSyncCursor } from "./state.js";
import { logger } from "./logger.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const TEXT_CHUNK_LIMIT = 4000;

// Session-expired error code from iLink
const SESSION_EXPIRED_ERRCODE = -14;

export type BridgeOpts = {
  baseUrl: string;
  token: string;
  accountId: string;
  abortSignal?: AbortSignal;
  model?: string;
  dangerouslySkipPermissions?: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      // Include quoted context
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item?.type === MessageItemType.TEXT && ref.message_item.text_item?.text) {
        parts.push(ref.message_item.text_item.text);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    // Voice-to-text
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

/** Split text into chunks of max `limit` chars, breaking at newlines where possible. */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    // Try to break at a newline within the limit
    let breakAt = remaining.lastIndexOf("\n", limit);
    if (breakAt <= 0) breakAt = limit;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).replace(/^\n/, "");
  }
  return chunks;
}

// Typing ticket cache per user
const typingTicketCache = new Map<string, string>();

async function fetchTypingTicket(
  baseUrl: string,
  token: string,
  userId: string,
  contextToken?: string,
): Promise<string | undefined> {
  const cached = typingTicketCache.get(userId);
  if (cached) return cached;
  try {
    const resp = await getConfig({ baseUrl, token, ilinkUserId: userId, contextToken });
    if (resp.typing_ticket) {
      typingTicketCache.set(userId, resp.typing_ticket);
      return resp.typing_ticket;
    }
  } catch (err) {
    logger.debug(`fetchTypingTicket failed: ${String(err)}`);
  }
  return undefined;
}

async function processOneMessage(
  msg: WeixinMessage,
  opts: BridgeOpts,
): Promise<void> {
  const fromUser = msg.from_user_id ?? "";
  const contextToken = msg.context_token;
  const text = extractText(msg.item_list);

  if (!text.trim()) {
    logger.debug(`Skipping empty/media-only message from ${fromUser}`);
    return;
  }

  if (!contextToken) {
    logger.warn(`No contextToken for message from ${fromUser}, cannot reply`);
    return;
  }

  logger.info(`Inbound: from=${fromUser} text="${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);

  // Handle /clear command — reset Claude session for this user
  if (text.trim() === "/clear") {
    resetSession(fromUser);
    await sendMessageWeixin({
      to: fromUser,
      text: "✅ 会话已重置，下一条消息将开始新对话。",
      opts: { baseUrl: opts.baseUrl, token: opts.token, contextToken },
    });
    return;
  }

  // Send typing indicator
  const typingTicket = await fetchTypingTicket(opts.baseUrl, opts.token, fromUser, contextToken);
  if (typingTicket) {
    await sendTyping({
      baseUrl: opts.baseUrl,
      token: opts.token,
      body: { ilink_user_id: fromUser, typing_ticket: typingTicket, status: TypingStatus.TYPING },
    });
  }

  // Invoke Claude Code
  let response: string;
  try {
    const result = await runClaude(text, fromUser, { model: opts.model, dangerouslySkipPermissions: opts.dangerouslySkipPermissions });
    response = markdownToPlainText(result.result);
    logger.info(`Claude response: ${result.durationMs}ms, cost=$${result.costUsd.toFixed(4)}, len=${response.length}`);
    logger.info(`Claude reply:\n${response}`);
  } catch (err) {
    logger.error(`Claude invocation failed: ${String(err)}`);
    response = "⚠️ 处理消息时出错，请稍后重试。";
  }

  // Cancel typing
  if (typingTicket) {
    await sendTyping({
      baseUrl: opts.baseUrl,
      token: opts.token,
      body: { ilink_user_id: fromUser, typing_ticket: typingTicket, status: TypingStatus.CANCEL },
    });
  }

  // Send reply (chunked if needed)
  const chunks = chunkText(response, TEXT_CHUNK_LIMIT);
  for (const chunk of chunks) {
    try {
      await sendMessageWeixin({
        to: fromUser,
        text: chunk,
        opts: { baseUrl: opts.baseUrl, token: opts.token, contextToken },
      });
    } catch (err) {
      logger.error(`Failed to send reply to ${fromUser}: ${String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main long-poll loop
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

export async function startBridge(opts: BridgeOpts): Promise<void> {
  const { baseUrl, token, accountId, abortSignal } = opts;

  logger.info(`Bridge started: baseUrl=${baseUrl} account=${accountId}`);

  let cursor = loadSyncCursor(accountId) ?? "";
  if (cursor) {
    logger.info(`Resuming from saved sync cursor (${cursor.length} bytes)`);
  } else {
    logger.info("No previous sync cursor, starting fresh");
  }

  let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: cursor,
        timeoutMs: nextTimeoutMs,
      });

      // Update server-suggested timeout
      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      // Check for API errors
      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          logger.error("Session expired! Please re-login: npm run login");
          // Pause for 5 minutes before retrying
          await sleep(5 * 60_000, abortSignal);
          continue;
        }

        consecutiveFailures++;
        logger.error(
          `getUpdates error: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.error(`${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off ${BACKOFF_DELAY_MS / 1000}s`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      // Save cursor
      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveSyncCursor(accountId, resp.get_updates_buf);
        cursor = resp.get_updates_buf;
      }

      // Process messages
      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        try {
          await processOneMessage(msg, opts);
        } catch (err) {
          logger.error(`processOneMessage error: ${String(err)}`);
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        logger.info("Bridge stopped (aborted)");
        return;
      }
      consecutiveFailures++;
      logger.error(`Bridge loop error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }

  logger.info("Bridge ended");
}
