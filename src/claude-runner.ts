import { execFile } from "node:child_process";
import { logger } from "./logger.js";
import { loadUserSession, saveUserSession, clearUserSession } from "./state.js";

function execFileAsync(
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: opts?.timeout ?? 5 * 60_000,
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      if (err) {
        if (stdout) {
          resolve({ stdout: stdout.toString(), stderr: stderr?.toString() ?? "" });
        } else {
          reject(err);
        }
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr?.toString() ?? "" });
      }
    });
  });
}

export interface ClaudeResponse {
  result: string;
  sessionId: string;
  durationMs: number;
  costUsd: number;
}

/**
 * Invoke Claude Code CLI with a message, using a per-user session.
 * - First message: no session flag → Claude creates a new session → we save the returned session_id
 * - Subsequent messages: --resume <saved_session_id> → continues the conversation
 */
export async function runClaude(
  message: string,
  fromUserId: string,
  opts?: { timeoutMs?: number; model?: string; dangerouslySkipPermissions?: boolean },
): Promise<ClaudeResponse> {
  const existingSession = loadUserSession(fromUserId);

  const args = ["-p", message, "--output-format", "json"];

  if (opts?.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  if (existingSession) {
    args.push("--resume", existingSession);
  }

  if (opts?.model) {
    args.push("--model", opts.model);
  }

  const mode = existingSession ? `resume=${existingSession.slice(0, 8)}...` : "new";
  logger.info(`claude-runner: invoking for user=${fromUserId.slice(0, 12)}... (${mode})`);
  const startMs = Date.now();

  try {
    const { stdout } = await execFileAsync("claude", args, {
      timeout: opts?.timeoutMs ?? 5 * 60_000,
    });

    const elapsed = Date.now() - startMs;
    logger.info(`claude-runner: completed in ${elapsed}ms`);

    const parsed = JSON.parse(stdout) as {
      result?: string;
      session_id?: string;
      duration_ms?: number;
      total_cost_usd?: number;
      is_error?: boolean;
    };

    // Save session ID for next message from this user
    const sessionId = parsed.session_id ?? existingSession ?? "";
    if (sessionId) {
      saveUserSession(fromUserId, sessionId);
    }

    if (parsed.is_error) {
      logger.error(`claude-runner: Claude returned error: ${parsed.result ?? "unknown"}`);
      return {
        result: parsed.result ?? "Sorry, an error occurred.",
        sessionId,
        durationMs: elapsed,
        costUsd: parsed.total_cost_usd ?? 0,
      };
    }

    return {
      result: parsed.result ?? "",
      sessionId,
      durationMs: elapsed,
      costUsd: parsed.total_cost_usd ?? 0,
    };
  } catch (err) {
    const elapsed = Date.now() - startMs;
    logger.error(`claude-runner: failed after ${elapsed}ms err=${String(err)}`);

    // If resume failed (session corrupted/gone), clear it and retry as new
    if (existingSession && String(err).includes("Session")) {
      logger.warn(`claude-runner: clearing stale session, will retry as new`);
      clearUserSession(fromUserId);
    }

    throw err;
  }
}

/**
 * Reset a user's Claude session. Next message will start fresh.
 */
export function resetSession(fromUserId: string): void {
  clearUserSession(fromUserId);
  logger.info(`claude-runner: session cleared for user=${fromUserId.slice(0, 12)}...`);
}
