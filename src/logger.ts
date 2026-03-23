const LEVEL_PRIORITY: Record<string, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const minLevel = LEVEL_PRIORITY[
  (process.env.WEIXIN_CC_LOG_LEVEL ?? "INFO").toUpperCase()
] ?? LEVEL_PRIORITY.INFO;

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(level: string, msg: string): void {
  if ((LEVEL_PRIORITY[level] ?? 0) < minLevel) return;
  const prefix = `${ts()} [${level}]`;
  if (level === "ERROR") {
    console.error(`${prefix} ${msg}`);
  } else if (level === "WARN") {
    console.warn(`${prefix} ${msg}`);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

export const logger = {
  debug: (msg: string) => log("DEBUG", msg),
  info: (msg: string) => log("INFO", msg),
  warn: (msg: string) => log("WARN", msg),
  error: (msg: string) => log("ERROR", msg),
};
