import { execFileAsync } from "./exec.js";
import { logger } from "../logger.js";
import { loadUserSession, saveUserSession, clearUserSession, loadUserAddDirs } from "../state.js";
import type { BackendRunner, BackendResponse, BackendRunOpts } from "./types.js";

export function buildClaudeArgs(
  message: string,
  opts?: BackendRunOpts,
  sessionId?: string,
  addDirs?: string[],
): string[] {
  const args = ["-p", message, "--output-format", "json"];

  if (opts?.autoApprove) {
    args.push("--dangerously-skip-permissions");
  }
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  if (opts?.model) {
    args.push("--model", opts.model);
  }
  if (addDirs) {
    for (const dir of addDirs) {
      args.push("--add-dir", dir);
    }
  }
  if (opts?.files) {
    for (const file of opts.files) {
      args.push("--files", file.path);
    }
  }

  return args;
}

export function parseClaudeOutput(stdout: string): {
  result: string;
  sessionId: string;
  costUsd: number;
  isError: boolean;
} {
  const parsed = JSON.parse(stdout) as {
    result?: string;
    session_id?: string;
    duration_ms?: number;
    total_cost_usd?: number;
    is_error?: boolean;
  };

  return {
    result: parsed.result ?? "",
    sessionId: parsed.session_id ?? "",
    costUsd: parsed.total_cost_usd ?? 0,
    isError: parsed.is_error ?? false,
  };
}

export function createClaudeRunner(): BackendRunner {
  return {
    name: "claude",

    async run(message, fromUserId, opts) {
      const existingSession = loadUserSession(fromUserId, "claude");
      const addDirs = loadUserAddDirs(fromUserId);
      const args = buildClaudeArgs(message, opts, existingSession, addDirs);

      const mode = existingSession ? `resume=${existingSession.slice(0, 8)}...` : "new";
      logger.info(`claude: invoking for user=${fromUserId.slice(0, 12)}... (${mode})`);
      const startMs = Date.now();

      try {
        const { stdout } = await execFileAsync("claude", args, {
          timeout: opts?.timeoutMs ?? 5 * 60_000,
        });

        const elapsed = Date.now() - startMs;
        logger.info(`claude: completed in ${elapsed}ms`);

        const parsed = parseClaudeOutput(stdout);

        const sessionId = parsed.sessionId || existingSession || "";
        if (sessionId) {
          saveUserSession(fromUserId, sessionId, "claude");
        }

        if (parsed.isError) {
          logger.error(`claude: returned error: ${parsed.result || "unknown"}`);
        }

        return {
          result: parsed.isError ? (parsed.result || "Sorry, an error occurred.") : parsed.result,
          sessionId,
          durationMs: elapsed,
          costUsd: parsed.costUsd,
        };
      } catch (err) {
        const elapsed = Date.now() - startMs;
        logger.error(`claude: failed after ${elapsed}ms err=${String(err)}`);

        if (existingSession && String(err).includes("Session")) {
          logger.warn(`claude: clearing stale session, will retry as new`);
          clearUserSession(fromUserId, "claude");
        }

        throw err;
      }
    },

    resetSession(fromUserId) {
      clearUserSession(fromUserId, "claude");
      logger.info(`claude: session cleared for user=${fromUserId.slice(0, 12)}...`);
    },
  };
}
