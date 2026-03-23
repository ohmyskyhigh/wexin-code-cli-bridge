import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "../logger.js";
import { randomWechatUin } from "../util.js";
import type {
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  SendTypingReq,
  GetConfigResp,
  BaseInfo,
} from "./types.js";

export type WeixinApiOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// BaseInfo
// ---------------------------------------------------------------------------

function readChannelVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(dir, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const CHANNEL_VERSION = readChannelVersion();

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildHeaders(opts: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders({ token: params.token, body: params.body });

  logger.debug(`POST ${url.toString()} [${params.label}]`);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(t);
    const rawText = await res.text();
    logger.debug(`${params.label} status=${res.status}`);
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getUpdates(
  params: GetUpdatesReq & {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
  },
): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
    });
    return JSON.parse(rawText) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.debug(`getUpdates: client-side timeout after ${timeout}ms`);
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

export async function sendMessage(
  params: WeixinApiOptions & { body: SendMessageReq },
): Promise<void> {
  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
  });
}

export async function getConfig(
  params: WeixinApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  const rawText = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "getConfig",
  });
  return JSON.parse(rawText) as GetConfigResp;
}

export async function sendTyping(
  params: WeixinApiOptions & { body: SendTypingReq },
): Promise<void> {
  try {
    await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/sendtyping",
      body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
      token: params.token,
      timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
      label: "sendTyping",
    });
  } catch (err) {
    // Typing is best-effort; never let it break the flow
    logger.debug(`sendTyping failed (non-fatal): ${String(err)}`);
  }
}
