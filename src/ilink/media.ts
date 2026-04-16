/**
 * CDN media operations: AES-128-ECB crypto, download/decrypt, upload pipeline.
 * Protocol matches @tencent-weixin/openclaw-weixin.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { logger } from "../logger.js";
import type { CDNMedia } from "./types.js";
import { UploadMediaType } from "./types.js";
import { getUploadUrl } from "./api.js";
import type { WeixinApiOptions } from "./api.js";

// ---------------------------------------------------------------------------
// AES-128-ECB crypto
// ---------------------------------------------------------------------------

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Compute AES-128-ECB ciphertext size (PKCS7 padding to 16-byte boundary). */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// ---------------------------------------------------------------------------
// AES key parsing (two formats in the wild)
// ---------------------------------------------------------------------------

/**
 * Parse CDNMedia.aes_key (base64) into a raw 16-byte AES key.
 *
 * Two encodings exist:
 *   - base64(raw 16 bytes)          → images (from media.aes_key)
 *   - base64(hex string of 32 chars) → file / voice / video
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(
    `parseAesKey: expected 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`,
  );
}

// ---------------------------------------------------------------------------
// CDN URL construction
// ---------------------------------------------------------------------------

export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

export function buildCdnUploadUrl(params: {
  cdnBaseUrl: string;
  uploadParam: string;
  filekey: string;
}): string {
  return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}

// ---------------------------------------------------------------------------
// CDN download
// ---------------------------------------------------------------------------

const DOWNLOAD_TIMEOUT_MS = 30_000;

async function fetchCdnBytes(url: string, label: string): Promise<Buffer> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      throw new Error(`${label}: CDN download ${res.status} ${res.statusText} body=${body}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

/**
 * Download and AES-128-ECB decrypt a CDN media file.
 * Prefers fullUrl when available; falls back to building URL from encryptQueryParam + cdnBaseUrl.
 */
export async function downloadAndDecrypt(params: {
  encryptQueryParam?: string;
  aesKeyBase64: string;
  cdnBaseUrl?: string;
  fullUrl?: string;
  label?: string;
}): Promise<Buffer> {
  const label = params.label ?? "downloadAndDecrypt";
  const key = parseAesKey(params.aesKeyBase64);

  let url: string;
  if (params.fullUrl) {
    url = params.fullUrl;
  } else if (params.encryptQueryParam && params.cdnBaseUrl) {
    url = buildCdnDownloadUrl(params.encryptQueryParam, params.cdnBaseUrl);
  } else {
    throw new Error(`${label}: need fullUrl or (encryptQueryParam + cdnBaseUrl)`);
  }

  logger.debug(`${label}: fetching url=${url.slice(0, 80)}...`);
  const encrypted = await fetchCdnBytes(url, label);
  logger.debug(`${label}: downloaded ${encrypted.length} bytes, decrypting`);
  const decrypted = decryptAesEcb(encrypted, key);
  logger.debug(`${label}: decrypted ${decrypted.length} bytes`);
  return decrypted;
}

/** Download plain (unencrypted) bytes from the CDN. */
export async function downloadPlainBuffer(params: {
  encryptQueryParam?: string;
  cdnBaseUrl?: string;
  fullUrl?: string;
  label?: string;
}): Promise<Buffer> {
  const label = params.label ?? "downloadPlain";
  let url: string;
  if (params.fullUrl) {
    url = params.fullUrl;
  } else if (params.encryptQueryParam && params.cdnBaseUrl) {
    url = buildCdnDownloadUrl(params.encryptQueryParam, params.cdnBaseUrl);
  } else {
    throw new Error(`${label}: need fullUrl or (encryptQueryParam + cdnBaseUrl)`);
  }
  logger.debug(`${label}: fetching url=${url.slice(0, 80)}...`);
  return fetchCdnBytes(url, label);
}

// ---------------------------------------------------------------------------
// CDN upload
// ---------------------------------------------------------------------------

const UPLOAD_MAX_RETRIES = 3;
const UPLOAD_TIMEOUT_MS = 60_000;

export type UploadedFileInfo = {
  filekey: string;
  /** CDN download param; use as CDNMedia.encrypt_query_param in sendMessage */
  downloadEncryptedQueryParam: string;
  /** AES-128 key, hex-encoded; convert to base64 for CDNMedia.aes_key */
  aeskey: string;
  /** Plaintext file size in bytes */
  fileSize: number;
  /** Ciphertext file size in bytes */
  fileSizeCiphertext: number;
};

/**
 * Upload a local file to the Weixin CDN with AES-128-ECB encryption.
 * Flow: read file → hash → gen aeskey → getUploadUrl → encrypt → POST to CDN → return info.
 */
export async function uploadToWeixin(params: {
  filePath: string;
  toUserId: string;
  mediaType: number;
  opts: WeixinApiOptions;
  cdnBaseUrl?: string;
  label?: string;
}): Promise<UploadedFileInfo> {
  const { filePath, toUserId, mediaType, opts, cdnBaseUrl } = params;
  const label = params.label ?? "uploadToWeixin";

  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  logger.debug(
    `${label}: file=${filePath} rawsize=${rawsize} filesize=${filesize} md5=${rawfilemd5}`,
  );

  const uploadUrlResp = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error(`${label}: getUploadUrl returned no upload URL`);
  }

  let cdnUrl: string;
  if (uploadFullUrl) {
    cdnUrl = uploadFullUrl;
  } else if (uploadParam && cdnBaseUrl) {
    cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  } else {
    throw new Error(`${label}: need upload_full_url or (upload_param + cdnBaseUrl)`);
  }

  const ciphertext = encryptAesEcb(plaintext, aeskey);
  logger.debug(`${label}: CDN POST ciphertextSize=${ciphertext.length}`);

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
        signal: controller.signal,
      });
      clearTimeout(t);

      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        throw new Error(`CDN upload server error ${res.status}`);
      }

      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        throw new Error("CDN response missing x-encrypted-param header");
      }
      logger.debug(`${label}: CDN upload success attempt=${attempt}`);
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) throw err;
      if (attempt < UPLOAD_MAX_RETRIES) {
        logger.error(`${label}: attempt ${attempt} failed, retrying... err=${String(err)}`);
      } else {
        logger.error(`${label}: all ${UPLOAD_MAX_RETRIES} attempts failed`);
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error ? lastError : new Error("CDN upload failed");
  }

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}
