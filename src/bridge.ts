import fs from "node:fs";
import path from "node:path";
import { getUpdates, sendTyping, getConfig } from "./ilink/api.js";
import { sendMessageWeixin, markdownToPlainText, sendImageWeixin, sendFileWeixin } from "./ilink/send.js";
import { downloadAndDecrypt, uploadToWeixin } from "./ilink/media.js";
import type { UploadedFileInfo } from "./ilink/media.js";
import { MessageItemType, TypingStatus, UploadMediaType } from "./ilink/types.js";
import type { WeixinMessage, MessageItem, CDNMedia } from "./ilink/types.js";
import type { BackendRunner } from "./backend/index.js";
import type { FileAttachment } from "./backend/types.js";
import { loadSyncCursor, saveSyncCursor, addUserDir, removeUserDir, loadUserAddDirs, clearUserDirs, saveContextToken } from "./state.js";
import { saveTempFile, cleanupTempFile, cleanupStaleTempFiles, detectExtension, getMimeFromFilename } from "./media/temp.js";
import { logger } from "./logger.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const TEXT_CHUNK_LIMIT = 4000;
const MAX_BACKEND_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Session-expired error code from iLink
const SESSION_EXPIRED_ERRCODE = -14;

export type BridgeOpts = {
  baseUrl: string;
  token: string;
  accountId: string;
  abortSignal?: AbortSignal;
  model?: string;
  autoApprove?: boolean;
  backend: BackendRunner;
  cdnBaseUrl?: string;
  onSessionExpired?: () => Promise<{ token: string; accountId: string; baseUrl: string } | null>;
};

// ---------------------------------------------------------------------------
// Text extraction (unchanged)
// ---------------------------------------------------------------------------

function extractText(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item?.type === MessageItemType.TEXT && ref.message_item.text_item?.text) {
        parts.push(ref.message_item.text_item.text);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Media extraction
// ---------------------------------------------------------------------------

export type MediaAttachment = {
  type: "image" | "file";
  media?: CDNMedia;
  /** Hex-encoded AES key (preferred for images over media.aes_key) */
  imageAeskey?: string;
  fileName?: string;
};

function extractMedia(itemList?: MessageItem[]): MediaAttachment[] {
  if (!itemList?.length) return [];
  const result: MediaAttachment[] = [];
  for (const item of itemList) {
    if (item.type === MessageItemType.IMAGE && item.image_item?.media) {
      result.push({
        type: "image",
        media: item.image_item.media,
        imageAeskey: item.image_item.aeskey,
      });
    } else if (item.type === MessageItemType.FILE && item.file_item?.media) {
      result.push({
        type: "file",
        media: item.file_item.media,
        fileName: item.file_item.file_name,
      });
    }
    // Also extract media from quoted messages
    if (item.ref_msg?.message_item) {
      const ref = item.ref_msg.message_item;
      if (ref.type === MessageItemType.IMAGE && ref.image_item?.media) {
        result.push({
          type: "image",
          media: ref.image_item.media,
          imageAeskey: ref.image_item.aeskey,
        });
      } else if (ref.type === MessageItemType.FILE && ref.file_item?.media) {
        result.push({
          type: "file",
          media: ref.file_item.media,
          fileName: ref.file_item.file_name,
        });
      }
    }
  }
  return result;
}

/**
 * Build the aesKeyBase64 string for downloadAndDecrypt.
 * For images: prefer image_item.aeskey (hex) → convert to base64.
 * Otherwise: use media.aes_key (already base64).
 */
function resolveAesKeyBase64(attachment: MediaAttachment): string | undefined {
  if (attachment.imageAeskey) {
    return Buffer.from(attachment.imageAeskey, "hex").toString("base64");
  }
  return attachment.media?.aes_key;
}

// ---------------------------------------------------------------------------
// File reference detection in backend responses
// ---------------------------------------------------------------------------

function detectFileReferences(text: string): string[] {
  // Extract candidate paths (absolute paths not in URLs)
  const pathRegex = /(?<!\w:\/\/)(?:\/[\w./-]+)/g;
  const candidates = text.match(pathRegex) ?? [];
  const results: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size <= 20 * 1024 * 1024) {
        results.push(candidate);
      }
    } catch {
      // Not a real file
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf("\n", limit);
    if (breakAt <= 0) breakAt = limit;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).replace(/^\n/, "");
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Typing ticket cache
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Process one message (with media support)
// ---------------------------------------------------------------------------

async function processOneMessage(
  msg: WeixinMessage,
  opts: BridgeOpts,
): Promise<void> {
  const fromUser = msg.from_user_id ?? "";
  const contextToken = msg.context_token;
  const text = extractText(msg.item_list);
  const mediaAttachments = extractMedia(msg.item_list);

  // Skip if no text AND no media
  if (!text.trim() && mediaAttachments.length === 0) {
    logger.debug(`Skipping empty message from ${fromUser}`);
    return;
  }

  if (!contextToken) {
    logger.warn(`No contextToken for message from ${fromUser}, cannot reply`);
    return;
  }

  // Cache context token for use by the `send` CLI command
  saveContextToken(fromUser, contextToken);

  if (mediaAttachments.length > 0) {
    logger.info(`Inbound: from=${fromUser} text="${text.slice(0, 40)}..." media=${mediaAttachments.length} items`);
  } else {
    logger.info(`Inbound: from=${fromUser} text="${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);
  }

  const sendOpts = { baseUrl: opts.baseUrl, token: opts.token, contextToken };

  // Handle slash commands (only for text-only messages)
  const trimmed = text.trim();
  if (trimmed.startsWith("/") && mediaAttachments.length === 0) {
    const sendReply = (msg: string) =>
      sendMessageWeixin({ to: fromUser, text: msg, opts: sendOpts });

    if (trimmed === "/clear") {
      opts.backend.resetSession(fromUser);
      await sendReply("✅ 会话已重置，下一条消息将开始新对话。");
      return;
    }

    if (trimmed.startsWith("/add-dir ")) {
      const dir = trimmed.slice("/add-dir ".length).trim();
      if (!dir) {
        await sendReply("用法: /add-dir <路径>\n例: /add-dir /Users/me/project");
        return;
      }
      const dirs = addUserDir(fromUser, dir);
      await sendReply(`✅ 已添加目录: ${dir}\n当前目录列表:\n${dirs.map((d) => `  • ${d}`).join("\n")}`);
      return;
    }

    if (trimmed.startsWith("/rm-dir ")) {
      const dir = trimmed.slice("/rm-dir ".length).trim();
      if (!dir) {
        await sendReply("用法: /rm-dir <路径>");
        return;
      }
      const dirs = removeUserDir(fromUser, dir);
      await sendReply(dirs.length
        ? `✅ 已移除目录: ${dir}\n当前目录列表:\n${dirs.map((d) => `  • ${d}`).join("\n")}`
        : `✅ 已移除目录: ${dir}\n当前无额外目录。`);
      return;
    }

    if (trimmed === "/dirs") {
      const dirs = loadUserAddDirs(fromUser);
      await sendReply(dirs.length
        ? `当前目录列表:\n${dirs.map((d) => `  • ${d}`).join("\n")}`
        : "当前无额外目录。用 /add-dir <路径> 添加。");
      return;
    }

    if (trimmed === "/clear-dirs") {
      clearUserDirs(fromUser);
      await sendReply("✅ 已清除所有额外目录。");
      return;
    }

    if (trimmed === "/cleanup") {
      const count = cleanupStaleTempFiles(0);
      await sendReply(`✅ 已清理 ${count} 个临时文件。`);
      return;
    }

    if (trimmed === "/help") {
      await sendReply(
        "可用命令:\n" +
        "  /clear       — 重置会话\n" +
        "  /add-dir <路径> — 添加可访问的目录\n" +
        "  /rm-dir <路径>  — 移除目录\n" +
        "  /dirs        — 查看当前目录列表\n" +
        "  /clear-dirs  — 清除所有额外目录\n" +
        "  /cleanup     — 清理临时文件\n" +
        "  /help        — 显示本帮助\n\n" +
        "支持发送图片和文件进行分析。"
      );
      return;
    }
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

  // Download media attachments to temp files
  const tempFiles: string[] = [];
  const fileAttachments: FileAttachment[] = [];

  if (mediaAttachments.length > 0) {
    for (const attachment of mediaAttachments) {
      try {
        const aesKeyBase64 = resolveAesKeyBase64(attachment);
        if (!aesKeyBase64 && !attachment.media?.full_url) {
          logger.warn(`Skipping media: no AES key and no full_url`);
          continue;
        }

        let buffer: Buffer;
        if (aesKeyBase64) {
          buffer = await downloadAndDecrypt({
            encryptQueryParam: attachment.media?.encrypt_query_param,
            aesKeyBase64,
            cdnBaseUrl: opts.cdnBaseUrl,
            fullUrl: attachment.media?.full_url,
            label: `inbound-${attachment.type}`,
          });
        } else {
          // No AES key but has full_url — try plain download
          const res = await fetch(attachment.media!.full_url!);
          if (!res.ok) throw new Error(`Plain download failed: ${res.status}`);
          buffer = Buffer.from(await res.arrayBuffer());
        }

        // File size check
        if (buffer.length > MAX_BACKEND_FILE_SIZE) {
          logger.warn(`Skipping ${attachment.type}: ${buffer.length} bytes exceeds ${MAX_BACKEND_FILE_SIZE} limit`);
          continue;
        }

        // Determine extension and MIME
        let ext: string;
        let mimeType: string;
        if (attachment.fileName) {
          ext = path.extname(attachment.fileName) || detectExtension(buffer);
          mimeType = getMimeFromFilename(attachment.fileName);
        } else {
          ext = detectExtension(buffer);
          mimeType = attachment.type === "image" ? "image/jpeg" : "application/octet-stream";
          if (ext === ".png") mimeType = "image/png";
          else if (ext === ".gif") mimeType = "image/gif";
          else if (ext === ".webp") mimeType = "image/webp";
          else if (ext === ".pdf") mimeType = "application/pdf";
        }

        const tempPath = saveTempFile(buffer, ext);
        tempFiles.push(tempPath);
        fileAttachments.push({
          path: tempPath,
          mimeType,
          originalName: attachment.fileName,
        });
        logger.info(`Media saved: ${attachment.type} ${ext} ${buffer.length} bytes → ${tempPath}`);
      } catch (err) {
        logger.error(`Failed to download ${attachment.type} media: ${String(err)}`);
      }
    }
  }

  // Build prompt (default prompt if media but no text)
  let prompt = text.trim();
  if (!prompt && fileAttachments.length > 0) {
    const types = fileAttachments.map((f) => f.mimeType.startsWith("image/") ? "image" : f.originalName ?? "file");
    prompt = types.some((t) => t === "image")
      ? "请描述这张图片"
      : `请分析这个文件: ${types.join(", ")}`;
  }

  // Invoke CLI backend
  let response: string;
  try {
    const result = await opts.backend.run(prompt, fromUser, {
      model: opts.model,
      autoApprove: opts.autoApprove,
      files: fileAttachments.length > 0 ? fileAttachments : undefined,
    });
    response = markdownToPlainText(result.result);
    logger.info(`${opts.backend.name} response: ${result.durationMs}ms, cost=$${result.costUsd.toFixed(4)}, len=${response.length}`);
  } catch (err) {
    logger.error(`${opts.backend.name} invocation failed: ${String(err)}`);
    response = "⚠️ 处理消息时出错，请稍后重试。";
  } finally {
    // Always cleanup temp files
    for (const tempPath of tempFiles) {
      cleanupTempFile(tempPath);
    }
  }

  // Cancel typing
  if (typingTicket) {
    await sendTyping({
      baseUrl: opts.baseUrl,
      token: opts.token,
      body: { ilink_user_id: fromUser, typing_ticket: typingTicket, status: TypingStatus.CANCEL },
    });
  }

  // Detect file references in backend response and upload them
  const fileRefs = detectFileReferences(response);
  for (const filePath of fileRefs) {
    try {
      const mime = getMimeFromFilename(filePath);
      const isImage = mime.startsWith("image/");
      const mediaType = isImage ? UploadMediaType.IMAGE : UploadMediaType.FILE;
      const uploaded = await uploadToWeixin({
        filePath,
        toUserId: fromUser,
        mediaType,
        opts: { baseUrl: opts.baseUrl, token: opts.token },
        cdnBaseUrl: opts.cdnBaseUrl,
        label: `outbound-${isImage ? "image" : "file"}`,
      });
      if (isImage) {
        await sendImageWeixin({ to: fromUser, text: "", uploaded, opts: sendOpts });
      } else {
        await sendFileWeixin({ to: fromUser, text: "", fileName: path.basename(filePath), uploaded, opts: sendOpts });
      }
      logger.info(`Sent outbound ${isImage ? "image" : "file"}: ${filePath}`);
    } catch (err) {
      logger.error(`Failed to upload/send file ${filePath}: ${String(err)}`);
    }
  }

  // Send text reply (chunked if needed)
  const chunks = chunkText(response, TEXT_CHUNK_LIMIT);
  for (const chunk of chunks) {
    try {
      await sendMessageWeixin({ to: fromUser, text: chunk, opts: sendOpts });
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
  let { baseUrl, token, accountId } = opts;
  const { abortSignal } = opts;

  logger.info(`Bridge started: baseUrl=${baseUrl} account=${accountId}`);

  // Cleanup stale temp files from previous sessions
  const cleaned = cleanupStaleTempFiles();
  if (cleaned > 0) {
    logger.info(`Cleaned up ${cleaned} stale temp file(s) from previous session`);
  }

  // Periodic cleanup
  const cleanupTimer = setInterval(() => {
    cleanupStaleTempFiles();
  }, CLEANUP_INTERVAL_MS);
  abortSignal?.addEventListener("abort", () => clearInterval(cleanupTimer), { once: true });

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

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          if (opts.onSessionExpired) {
            logger.info("Session expired, re-logging in...");
            const newCreds = await opts.onSessionExpired();
            if (newCreds) {
              token = newCreds.token;
              accountId = newCreds.accountId;
              baseUrl = newCreds.baseUrl;
              cursor = "";
              logger.info(`Re-login successful, new account=${accountId}`);
              continue;
            }
          }
          logger.error("Session expired! Please re-login: wcc login");
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

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveSyncCursor(accountId, resp.get_updates_buf);
        cursor = resp.get_updates_buf;
      }

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
        clearInterval(cleanupTimer);
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

  clearInterval(cleanupTimer);
  logger.info("Bridge ended");
}
