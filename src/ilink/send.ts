import { sendMessage as sendMessageApi } from "./api.js";
import type { WeixinApiOptions } from "./api.js";
import type { MessageItem, SendMessageReq } from "./types.js";
import { MessageItemType, MessageState, MessageType } from "./types.js";
import { logger } from "../logger.js";
import { generateId } from "../util.js";

function generateClientId(): string {
  return generateId("weixin-cc");
}

/**
 * Strip basic markdown for plain-text WeChat delivery.
 */
export function markdownToPlainText(text: string): string {
  let result = text;
  // Code blocks: strip fences, keep code
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // Images: remove
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // Links: keep display text
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Tables: remove separator rows, strip pipes
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split("|").map((cell) => cell.trim()).join("  "),
  );
  // Bold/italic
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/\*(.+?)\*/g, "$1");
  result = result.replace(/__(.+?)__/g, "$1");
  result = result.replace(/_(.+?)_/g, "$1");
  // Inline code
  result = result.replace(/`([^`]+)`/g, "$1");
  // Headers
  result = result.replace(/^#{1,6}\s+/gm, "");
  return result.trim();
}

function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string;
  clientId: string;
}): SendMessageReq {
  const { to, text, contextToken, clientId } = params;
  const item_list: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: item_list.length ? item_list : undefined,
      context_token: contextToken ?? undefined,
    },
  };
}

/**
 * Send a plain text message to a WeChat user.
 * contextToken MUST be echoed from the inbound message.
 */
export async function sendMessageWeixin(params: {
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  if (!opts.contextToken) {
    logger.error(`sendMessageWeixin: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendMessageWeixin: contextToken is required");
  }
  const clientId = generateClientId();
  const req = buildTextMessageReq({
    to,
    text,
    contextToken: opts.contextToken,
    clientId,
  });
  try {
    await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      body: req,
    });
  } catch (err) {
    logger.error(`sendMessageWeixin: failed to=${to} err=${String(err)}`);
    throw err;
  }
  return { messageId: clientId };
}
