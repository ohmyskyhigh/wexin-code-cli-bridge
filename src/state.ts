import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIR = process.env.WEIXIN_CC_STATE_DIR?.trim() || path.join(os.homedir(), ".weixin-cc");

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Account storage
// ---------------------------------------------------------------------------

export type AccountData = {
  token?: string;
  baseUrl?: string;
  userId?: string;
  savedAt?: string;
};

function accountsDir(): string {
  return path.join(STATE_DIR, "accounts");
}

function accountPath(accountId: string): string {
  return path.join(accountsDir(), `${accountId}.json`);
}

function accountIndexPath(): string {
  return path.join(STATE_DIR, "accounts.json");
}

/** Sanitize account ID for filesystem use. */
function sanitizeId(raw: string): string {
  return raw.replace(/[@.]/g, "-");
}

export function saveAccount(
  rawAccountId: string,
  data: { token?: string; baseUrl?: string; userId?: string },
): string {
  const id = sanitizeId(rawAccountId);
  ensureDir(accountsDir());

  const existing = loadAccount(id);
  const merged: AccountData = {
    token: data.token?.trim() || existing?.token,
    baseUrl: data.baseUrl?.trim() || existing?.baseUrl,
    userId: data.userId?.trim() || existing?.userId,
    savedAt: new Date().toISOString(),
  };

  const filePath = accountPath(id);
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf-8");
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }

  // Update index
  const ids = listAccountIds();
  if (!ids.includes(id)) {
    fs.writeFileSync(accountIndexPath(), JSON.stringify([...ids, id], null, 2), "utf-8");
  }

  return id;
}

export function loadAccount(accountId: string): AccountData | null {
  try {
    const raw = fs.readFileSync(accountPath(accountId), "utf-8");
    return JSON.parse(raw) as AccountData;
  } catch {
    return null;
  }
}

export function listAccountIds(): string[] {
  try {
    const raw = fs.readFileSync(accountIndexPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

/** Get the first (default) account, or null if none registered. */
export function getDefaultAccount(): { accountId: string; data: AccountData } | null {
  const ids = listAccountIds();
  if (ids.length === 0) return null;
  const data = loadAccount(ids[0]);
  if (!data) return null;
  return { accountId: ids[0], data };
}

// ---------------------------------------------------------------------------
// Sync cursor storage
// ---------------------------------------------------------------------------

function syncDir(): string {
  return path.join(STATE_DIR, "sync");
}

function syncPath(accountId: string): string {
  return path.join(syncDir(), `${accountId}.sync.json`);
}

export function loadSyncCursor(accountId: string): string | undefined {
  try {
    const raw = fs.readFileSync(syncPath(accountId), "utf-8");
    const data = JSON.parse(raw) as { get_updates_buf?: string };
    return typeof data.get_updates_buf === "string" ? data.get_updates_buf : undefined;
  } catch {
    return undefined;
  }
}

export function saveSyncCursor(accountId: string, cursor: string): void {
  ensureDir(syncDir());
  fs.writeFileSync(syncPath(accountId), JSON.stringify({ get_updates_buf: cursor }), "utf-8");
}

// ---------------------------------------------------------------------------
// Claude session storage (per WeChat user)
// ---------------------------------------------------------------------------

function sessionsDir(): string {
  return path.join(STATE_DIR, "sessions");
}

function sessionPath(userId: string): string {
  const safe = userId.replace(/[@.]/g, "-");
  return path.join(sessionsDir(), `${safe}.json`);
}

export function loadUserSession(userId: string): string | undefined {
  try {
    const raw = fs.readFileSync(sessionPath(userId), "utf-8");
    const data = JSON.parse(raw) as { sessionId?: string };
    return typeof data.sessionId === "string" ? data.sessionId : undefined;
  } catch {
    return undefined;
  }
}

export function saveUserSession(userId: string, sessionId: string): void {
  ensureDir(sessionsDir());
  fs.writeFileSync(sessionPath(userId), JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }), "utf-8");
}

export function clearUserSession(userId: string): void {
  try { fs.unlinkSync(sessionPath(userId)); } catch { /* ok */ }
}

export function clearAllSessions(): void {
  try {
    const dir = sessionsDir();
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  } catch { /* ok */ }
}
