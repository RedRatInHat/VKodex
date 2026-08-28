import type { LocalInputFile, OutboundFile } from "../../domain/models.js";

export interface AgentProgress {
  readonly kind: "thread-started" | "command" | "file-change" | "message";
  readonly summary: string;
}

export interface AgentRunRequest {
  readonly threadId: string | null;
  readonly workspace: string;
  readonly prompt: string;
  readonly inputFiles: readonly LocalInputFile[];
  readonly outboxDir: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: AgentProgress) => Promise<void> | void;
}

export interface AgentRunResult {
  readonly threadId: string;
  readonly finalText: string;
  readonly artifacts: readonly OutboundFile[];
}

export interface CodingAgent {
  readonly kind: string;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
