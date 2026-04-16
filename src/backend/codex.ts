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

export function buildCodexArgs(
  message: string,
  opts?: BackendRunOpts,
  sessionId?: string,
  addDirs?: string[],
): string[] {
  const finalMessage = prependFileContents(message, opts);
  const args: string[] = [];

  if (opts?.autoApprove) {
    args.push("--full-auto");
  }
  if (opts?.model) {
    args.push("-m", opts.model);
  }
  if (addDirs) {
    for (const dir of addDirs) {
      args.push("--add-dir", dir);
    }
  }

  // Codex uses subcommand style: codex exec [--json] "message"
  // or: codex exec resume <sessionId> [--json] "message"
  if (sessionId) {
    args.push("exec", "resume", sessionId, "--json", finalMessage);
  } else {
    args.push("exec", "--json", finalMessage);
  }

  return args;
}

interface CodexEvent {
  type?: string;
  session_id?: string;
  thread_id?: string;
  // turn.completed events
  message?: {
    content?: string;
    role?: string;
  };
  // item events
  item?: {
    type?: string;
    text?: string;
    content?: Array<{ text?: string; type?: string }>;
  };
  // Generic text fallback
  text?: string;
  output?: string;
  error?: string;
}

export function parseCodexOutput(stdout: string): {
  result: string;
  sessionId: string;
  costUsd: number;
  isError: boolean;
} {
  const lines = stdout.trim().split("\n");
  let result = "";
  let sessionId = "";
  let isError = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: CodexEvent;
    try {
      event = JSON.parse(trimmed) as CodexEvent;
    } catch {
      continue;
    }

    // Extract session/thread ID from any event that has one
    if (event.session_id) {
      sessionId = event.session_id;
    }
    if (event.thread_id) {
      sessionId = event.thread_id;
    }

    // Extract result from item events (item.text is the actual response)
    if (event.type === "item.created" || event.type === "item.completed") {
      if (event.item?.text) {
        result = event.item.text;
      } else if (event.item?.content) {
        for (const part of event.item.content) {
          if (part.type === "text" && part.text) {
            result = part.text;
          }
        }
      }
    }

    // Extract result from turn/message completion events
    if (event.type === "turn.completed" || event.type === "message.completed") {
      if (event.message?.content) {
        result = event.message.content;
      }
    }

    // Detect errors
    if (event.error) {
      isError = true;
    }

    // Generic fallbacks
    if (!result && event.output) {
      result = event.output;
    }
    if (!result && event.text) {
      result = event.text;
    }
  }

  // If no JSONL events parsed, try parsing entire stdout as single JSON
  if (!result && lines.length > 0) {
    try {
      const single = JSON.parse(stdout) as { result?: string; output?: string; error?: string; session_id?: string };
      result = single.result ?? single.output ?? "";
      if (single.session_id) sessionId = single.session_id;
      if (single.error) isError = true;
    } catch {
      // stdout might be plain text
      result = stdout.trim();
    }
  }

  return { result, sessionId, costUsd: 0, isError };
}

export function createCodexRunner(): BackendRunner {
  return {
    name: "codex",

    async run(message, fromUserId, opts) {
      const existingSession = loadUserSession(fromUserId, "codex");
      const addDirs = loadUserAddDirs(fromUserId);
      const args = buildCodexArgs(message, opts, existingSession, addDirs);

      const mode = existingSession ? `resume=${existingSession.slice(0, 8)}...` : "new";
      logger.info(`codex: invoking for user=${fromUserId.slice(0, 12)}... (${mode})`);
      const startMs = Date.now();

      try {
        const { stdout } = await execFileAsync("codex", args, {
          timeout: opts?.timeoutMs ?? 5 * 60_000,
        });

        const elapsed = Date.now() - startMs;
        logger.info(`codex: completed in ${elapsed}ms`);

        const parsed = parseCodexOutput(stdout);

        const sessionId = parsed.sessionId || existingSession || "";
        if (sessionId) {
          saveUserSession(fromUserId, sessionId, "codex");
        }

        if (parsed.isError) {
          logger.error(`codex: returned error: ${parsed.result || "unknown"}`);
        }

        return {
          result: parsed.isError ? (parsed.result || "Sorry, an error occurred.") : parsed.result,
          sessionId,
          durationMs: elapsed,
          costUsd: parsed.costUsd,
        };
      } catch (err) {
        const elapsed = Date.now() - startMs;
        logger.error(`codex: failed after ${elapsed}ms err=${String(err)}`);

        if (existingSession && String(err).includes("Session")) {
          logger.warn(`codex: clearing stale session, will retry as new`);
          clearUserSession(fromUserId, "codex");
        }

        throw err;
      }
    },

    resetSession(fromUserId) {
      clearUserSession(fromUserId, "codex");
      logger.info(`codex: session cleared for user=${fromUserId.slice(0, 12)}...`);
    },
  };
}
