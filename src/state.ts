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

/** Get the most recently added account, or null if none registered. */
export function getDefaultAccount(): { accountId: string; data: AccountData } | null {
  const ids = listAccountIds();
  if (ids.length === 0) return null;
  const lastId = ids[ids.length - 1];
  const data = loadAccount(lastId);
  if (!data) return null;
  return { accountId: lastId, data };
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
// CLI session storage (per WeChat user)
// ---------------------------------------------------------------------------

function sessionsDir(): string {
  return path.join(STATE_DIR, "sessions");
}

function sessionPath(userId: string): string {
  const safe = userId.replace(/[@.]/g, "-");
  return path.join(sessionsDir(), `${safe}.json`);
}

type UserSessionData = {
  sessionId?: string;
  sessions?: Record<string, string>;
  addDirs?: string[];
  contextToken?: string;
  originalUserId?: string;
  updatedAt?: string;
};

function loadSessionData(userId: string): UserSessionData {
  try {
    const raw = fs.readFileSync(sessionPath(userId), "utf-8");
    return JSON.parse(raw) as UserSessionData;
  } catch {
    return {};
  }
}

function saveSessionData(userId: string, data: UserSessionData): void {
  ensureDir(sessionsDir());
  fs.writeFileSync(sessionPath(userId), JSON.stringify({ ...data, originalUserId: userId, updatedAt: new Date().toISOString() }), "utf-8");
}

export function loadUserSession(userId: string, backend?: string): string | undefined {
  const data = loadSessionData(userId);
  if (backend) {
    return data.sessions?.[backend];
  }
  return typeof data.sessionId === "string" ? data.sessionId : undefined;
}

export function saveUserSession(userId: string, sessionId: string, backend?: string): void {
  const data = loadSessionData(userId);
  if (backend) {
    const sessions = data.sessions ?? {};
    sessions[backend] = sessionId;
    saveSessionData(userId, { ...data, sessions });
  } else {
    saveSessionData(userId, { ...data, sessionId });
  }
}

export function clearUserSession(userId: string, backend?: string): void {
  const data = loadSessionData(userId);
  if (backend && data.sessions) {
    delete data.sessions[backend];
    saveSessionData(userId, data);
    return;
  }
  // Clear all sessions
  if (data.addDirs?.length) {
    saveSessionData(userId, { addDirs: data.addDirs });
  } else {
    try { fs.unlinkSync(sessionPath(userId)); } catch { /* ok */ }
  }
}

export function loadUserAddDirs(userId: string): string[] {
  return loadSessionData(userId).addDirs ?? [];
}

export function addUserDir(userId: string, dir: string): string[] {
  const data = loadSessionData(userId);
  const dirs = data.addDirs ?? [];
  if (!dirs.includes(dir)) {
    dirs.push(dir);
  }
  saveSessionData(userId, { ...data, addDirs: dirs });
  return dirs;
}

export function removeUserDir(userId: string, dir: string): string[] {
  const data = loadSessionData(userId);
  const dirs = (data.addDirs ?? []).filter((d) => d !== dir);
  saveSessionData(userId, { ...data, addDirs: dirs });
  return dirs;
}

export function clearUserDirs(userId: string): void {
  const data = loadSessionData(userId);
  saveSessionData(userId, { ...data, addDirs: [] });
}

export function saveContextToken(userId: string, contextToken: string): void {
  const data = loadSessionData(userId);
  saveSessionData(userId, { ...data, contextToken });
}

export function loadContextToken(userId: string): string | undefined {
  return loadSessionData(userId).contextToken;
}

/** List all user IDs that have session data. */
export function listUserIds(): string[] {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf-8");
        const data = JSON.parse(raw) as UserSessionData;
        if (!data.contextToken) return null;
        // Prefer the original (unsanitized) user ID stored in data
        return data.originalUserId ?? f.replace(".json", "");
      } catch {
        return null;
      }
    })
    .filter((id): id is string => id !== null);
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
