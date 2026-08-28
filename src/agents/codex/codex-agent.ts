import path from "node:path";
import { Codex, type ThreadEvent, type UserInput } from "@openai/codex-sdk";
import type { AppConfig } from "../../config.js";
import type { AgentRunRequest, AgentRunResult, CodingAgent } from "../../core/ports/coding-agent.js";
import { collectOutboundFiles } from "../../lib/files.js";
import { buildCodexEnvironment } from "./codex-environment.js";

export class CodexAgent implements CodingAgent {
  readonly kind = "codex";
  private readonly codex: Codex;

  constructor(private readonly config: AppConfig) {
    this.codex = new Codex({
      ...(config.codex.apiKey ? { apiKey: config.codex.apiKey } : {}),
      env: buildCodexEnvironment(process.env, config.codex.environmentAllowlist),
    });
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const threadOptions = {
      workingDirectory: request.workspace,
      sandboxMode: this.config.codex.sandboxMode,
      approvalPolicy: this.config.codex.approvalPolicy,
      skipGitRepoCheck: this.config.codex.skipGitRepoCheck,
      ...(this.config.codex.model === undefined ? {} : { model: this.config.codex.model }),
    };

    const thread = request.threadId
      ? this.codex.resumeThread(request.threadId, threadOptions)
      : this.codex.startThread(threadOptions);

    const input: UserInput[] = [{ type: "text", text: this.buildPrompt(request) }];
    for (const file of request.inputFiles) {
      if (file.kind === "image") input.push({ type: "local_image", path: file.path });
    }

    const result = await thread.runStreamed(input, { signal: request.signal });
    const agentMessages: string[] = [];
    let discoveredThreadId = request.threadId;

    for await (const event of result.events) {
      const typed = event as ThreadEvent;
      if (typed.type === "thread.started") {
        discoveredThreadId = typed.thread_id;
        await request.onProgress?.({ kind: "thread-started", summary: `Codex thread ${typed.thread_id}` });
      }

      if (typed.type === "item.completed") {
        if (typed.item.type === "agent_message") {
          agentMessages.push(typed.item.text);
          await request.onProgress?.({ kind: "message", summary: typed.item.text.slice(0, 160) });
        }
        if (typed.item.type === "command_execution") {
          await request.onProgress?.({ kind: "command", summary: typed.item.command });
        }
        if (typed.item.type === "file_change") {
          const changed = typed.item.changes.map((change) => path.basename(change.path)).join(", ");
          await request.onProgress?.({ kind: "file-change", summary: changed });
        }
      }

      if (typed.type === "turn.failed") throw new Error(typed.error.message);
      if (typed.type === "error") throw new Error(typed.message);
    }

    const threadId = thread.id ?? discoveredThreadId;
    if (!threadId) throw new Error("Codex did not return a thread ID");

    const artifacts = await collectOutboundFiles(request.outboxDir, {
      maxFiles: this.config.files.maxOutboundFiles,
      maxFileBytes: this.config.files.maxOutboundFileBytes,
      maxTotalBytes: this.config.files.maxOutboundTotalBytes,
    }, request.workspace);

    return {
      threadId,
      finalText: agentMessages.at(-1)?.trim() || "Codex завершил ход без текстового ответа.",
      artifacts,
    };
  }

  private buildPrompt(request: AgentRunRequest): string {
    const fileLines = request.inputFiles.length
      ? request.inputFiles.map((file) => `- ${file.originalName}: ${file.path}`).join("\n")
      : "- нет";

    return [
      "<vk_codex_bridge>",
      "Ты работаешь через закрытый VK-бот.",
      `Workspace: ${request.workspace}`,
      `Входные файлы:\n${fileLines}`,
      `Каталог для файлов пользователю: ${request.outboxDir}`,
      "Если результат нужно отправить как файл или изображение, скопируй только готовый пользовательский артефакт в этот каталог.",
      "Не копируй туда внутренние логи, временные файлы, зависимости, секреты или весь репозиторий.",
      "Не распаковывай архивы без явной просьбы пользователя.",
      "</vk_codex_bridge>",
      "",
      "<user_request>",
      request.prompt.trim() || "Изучи приложенные файлы и сообщи результат.",
      "</user_request>",
    ].join("\n");
  }
}
