import fs from "node:fs";
import { execFileAsync } from "./exec.js";
import { logger } from "../logger.js";
import { loadUserSession, saveUserSession, clearUserSession, loadUserAddDirs } from "../state.js";
import type { BackendRunner, BackendResponse, BackendRunOpts } from "./types.js";

/** Prepend text file contents to the message for backends without --files support. */
function prependFileContents(message: string, opts?: BackendRunOpts): string {
  if (!opts?.files?.length) return message;
  const parts: string[] = [];
  for (const file of opts.files) {
    if (file.mimeType.startsWith("image/")) {
      parts.push(`[Attached image: ${file.originalName ?? file.path} — image processing not supported by this backend]`);
      continue;
    }
    try {
      const content = fs.readFileSync(file.path, "utf-8");
      const name = file.originalName ?? file.path.split("/").pop() ?? "file";
      parts.push(`File: ${name}\n\`\`\`\n${content}\n\`\`\``);
    } catch {
      parts.push(`[Attached file: ${file.originalName ?? file.path} — could not read]`);
    }
  }
  if (!parts.length) return message;
  return parts.join("\n\n") + "\n\n" + message;
}

export function buildGeminiArgs(
  message: string,
  opts?: BackendRunOpts,
  sessionId?: string,
  addDirs?: string[],
): string[] {
  const finalMessage = prependFileContents(message, opts);
  const args = ["-p", finalMessage, "--output-format", "json"];

  if (opts?.autoApprove) {
    args.push("--yolo");
  }
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  if (opts?.model) {
    args.push("-m", opts.model);
  }
  if (addDirs?.length) {
    args.push("--include-directories", addDirs.join(","));
  }

  return args;
}

export function parseGeminiOutput(stdout: string): {
  result: string;
  sessionId: string;
  costUsd: number;
  isError: boolean;
} {
  const parsed = JSON.parse(stdout) as {
    result?: string;
    response?: string;
    session_id?: string;
    total_cost_usd?: number;
    is_error?: boolean;
    error?: string;
  };

  return {
    result: parsed.result ?? parsed.response ?? "",
    sessionId: parsed.session_id ?? "",
    costUsd: parsed.total_cost_usd ?? 0,
    isError: parsed.is_error ?? !!parsed.error,
  };
}

export function createGeminiRunner(): BackendRunner {
  return {
    name: "gemini",

    async run(message, fromUserId, opts) {
      const existingSession = loadUserSession(fromUserId, "gemini");
      const addDirs = loadUserAddDirs(fromUserId);
      const args = buildGeminiArgs(message, opts, existingSession, addDirs);

      const mode = existingSession ? `resume=${existingSession.slice(0, 8)}...` : "new";
      logger.info(`gemini: invoking for user=${fromUserId.slice(0, 12)}... (${mode})`);
      const startMs = Date.now();

      try {
        const { stdout } = await execFileAsync("gemini", args, {
          timeout: opts?.timeoutMs ?? 5 * 60_000,
        });

        const elapsed = Date.now() - startMs;
        logger.info(`gemini: completed in ${elapsed}ms`);

        const parsed = parseGeminiOutput(stdout);

        const sessionId = parsed.sessionId || existingSession || "";
        if (sessionId) {
          saveUserSession(fromUserId, sessionId, "gemini");
        }

        if (parsed.isError) {
          logger.error(`gemini: returned error: ${parsed.result || "unknown"}`);
        }

        return {
          result: parsed.isError ? (parsed.result || "Sorry, an error occurred.") : parsed.result,
          sessionId,
          durationMs: elapsed,
          costUsd: parsed.costUsd,
        };
      } catch (err) {
        const elapsed = Date.now() - startMs;
        logger.error(`gemini: failed after ${elapsed}ms err=${String(err)}`);

        if (existingSession && String(err).includes("Session")) {
          logger.warn(`gemini: clearing stale session, will retry as new`);
          clearUserSession(fromUserId, "gemini");
        }

        throw err;
      }
    },

    resetSession(fromUserId) {
      clearUserSession(fromUserId, "gemini");
      logger.info(`gemini: session cleared for user=${fromUserId.slice(0, 12)}...`);
    },
  };
}
