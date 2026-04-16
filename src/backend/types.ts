export type BackendType = "claude" | "gemini" | "codex";

export interface BackendResponse {
  result: string;
  sessionId: string;
  durationMs: number;
  costUsd: number;
}

export interface FileAttachment {
  path: string;
  mimeType: string;
  originalName?: string;
}

export interface BackendRunOpts {
  timeoutMs?: number;
  model?: string;
  autoApprove?: boolean;
  files?: FileAttachment[];
}

export interface BackendRunner {
  readonly name: BackendType;
  run(message: string, fromUserId: string, opts?: BackendRunOpts): Promise<BackendResponse>;
  resetSession(fromUserId: string): void;
}
