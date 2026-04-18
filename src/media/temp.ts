/**
 * Temporary file management for media processing.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from "../logger.js";

const STATE_DIR = process.env.WEIXIN_CC_STATE_DIR?.trim() || path.join(os.homedir(), ".weixin-cc");
const TEMP_SUBDIR = "tmp";
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function getTempDir(): string {
  const dir = path.join(STATE_DIR, TEMP_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Save buffer to temp file, returns absolute path. */
export function saveTempFile(buffer: Buffer, ext: string): string {
  const dir = getTempDir();
  const name = `${crypto.randomUUID()}${ext.startsWith(".") ? ext : `.${ext}`}`;
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, buffer);
  logger.debug(`saveTempFile: ${filePath} (${buffer.length} bytes)`);
  return filePath;
}

/** Delete a specific temp file. */
export function cleanupTempFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
    logger.debug(`cleanupTempFile: removed ${filePath}`);
  } catch {
    // File may already be gone
  }
}

/** Delete temp files older than maxAgeMs. Returns count of files removed. */
export function cleanupStaleTempFiles(maxAgeMs: number = DEFAULT_TTL_MS): number {
  const dir = path.join(STATE_DIR, TEMP_SUBDIR);
  if (!fs.existsSync(dir)) return 0;

  const now = Date.now();
  let count = 0;
  for (const entry of fs.readdirSync(dir)) {
    const filePath = path.join(dir, entry);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        count++;
      }
    } catch {
      // Skip on error
    }
  }
  if (count > 0) {
    logger.info(`cleanupStaleTempFiles: removed ${count} stale file(s)`);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Magic-byte file type detection
// ---------------------------------------------------------------------------

const MAGIC_SIGNATURES: Array<{ magic: number[]; ext: string }> = [
  { magic: [0x89, 0x50, 0x4e, 0x47], ext: ".png" },
  { magic: [0xff, 0xd8, 0xff], ext: ".jpg" },
  { magic: [0x47, 0x49, 0x46, 0x38], ext: ".gif" },
  { magic: [0x52, 0x49, 0x46, 0x46], ext: ".webp" }, // RIFF header (WebP)
  { magic: [0x42, 0x4d], ext: ".bmp" },
  { magic: [0x25, 0x50, 0x44, 0x46], ext: ".pdf" },
  { magic: [0x50, 0x4b, 0x03, 0x04], ext: ".zip" },
];

/** Detect file extension from magic bytes. Returns ".bin" if unknown. */
export function detectExtension(buffer: Buffer): string {
  for (const sig of MAGIC_SIGNATURES) {
    if (buffer.length >= sig.magic.length) {
      let match = true;
      for (let i = 0; i < sig.magic.length; i++) {
        if (buffer[i] !== sig.magic[i]) {
          match = false;
          break;
        }
      }
      if (match) return sig.ext;
    }
  }
  return ".bin";
}

// ---------------------------------------------------------------------------
// MIME utilities
// ---------------------------------------------------------------------------

const EXTENSION_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".py": "text/x-python",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".sh": "text/x-shellscript",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "application/pdf": ".pdf",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "text/plain": ".txt",
  "application/json": ".json",
  "application/zip": ".zip",
};

/** Get MIME type from filename extension. Returns "application/octet-stream" for unknown. */
export function getMimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
}

/** Get file extension from MIME type. Returns ".bin" for unknown. */
export function getExtensionFromMime(mimeType: string): string {
  const ct = mimeType.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXTENSION[ct] ?? ".bin";
}
