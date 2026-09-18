import { createHash } from "node:crypto";
import { isObject, type IpcObject } from "./ipc-client.js";
import { activeTurnsFromState } from "./projector.js";

export interface CodexQuestion {
  readonly id: string;
  readonly title: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly secret: boolean;
}

export interface CodexQuestions {
  readonly key: string;
  readonly fingerprint: string;
  readonly kind: "blocking" | "async";
  readonly turnId: string;
  readonly requestId?: string | number;
  readonly questions: readonly CodexQuestion[];
}

const OPEN = "<send_user_message_question_reply>";
const CLOSE = "</send_user_message_question_reply>";
export interface AsyncQuestionAnswer { readonly questionItemId: string; readonly question: string; readonly answer: string }

/** Exact wire format used by the installed Codex client, not a prompt wrapper. */
export function asyncQuestionReply(answers: readonly AsyncQuestionAnswer[]): string {
  return `${OPEN}\n${JSON.stringify(answers)}\n${CLOSE}`;
}

export function parseAsyncQuestionReply(input: unknown): AsyncQuestionAnswer[] {
  if (!Array.isArray(input) || input.length !== 1 || !isObject(input[0]) || input[0].type !== "text" || typeof input[0].text !== "string") return [];
  const text = input[0].text.trim();
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(OPEN.length, -CLOSE.length));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.length > 0 && rows.every(row => isObject(row) && typeof row.questionItemId === "string" && typeof row.question === "string" && typeof row.answer === "string")
      ? rows as AsyncQuestionAnswer[] : [];
  } catch { return []; }
}

function group(value: Omit<CodexQuestions, "fingerprint">): CodexQuestions {
  return { ...value, fingerprint: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}

/** Only live questions. Historical tool calls and approvals are never actionable. */
export function pendingCodexQuestions(state: IpcObject): CodexQuestions[] {
  const result: CodexQuestions[] = [];
  for (const request of (Array.isArray(state.requests) ? state.requests : []).filter(isObject)) {
    if (request.method !== "item/tool/requestUserInput" || request.completed === true || !isObject(request.params)) continue;
    const p = request.params;
    if ((typeof request.id !== "string" && typeof request.id !== "number") || typeof p.turnId !== "string" || !Array.isArray(p.questions) || !p.questions.length) continue;
    const questions: CodexQuestion[] = [];
    for (const q of p.questions) {
      if (!isObject(q) || typeof q.id !== "string" || typeof q.question !== "string") continue;
      questions.push({ id: q.id, title: q.question, secret: q.isSecret === true,
        options: (Array.isArray(q.options) ? q.options : []).filter(isObject).filter(o => typeof o.label === "string")
          .map(o => ({ label: String(o.label), ...(typeof o.description === "string" ? { description: o.description } : {}) })) });
    }
    if (questions.length !== p.questions.length || new Set(questions.map(q => q.id)).size !== questions.length) continue;
    result.push(group({ kind: "blocking", key: JSON.stringify(["blocking", p.turnId, request.id]), turnId: p.turnId, requestId: request.id, questions }));
  }
  for (const turn of activeTurnsFromState(state)) {
    const items = (turn.items as unknown[]).filter(isObject);
    const answered = new Set(items.flatMap(item => item.type === "userMessage" ? parseAsyncQuestionReply(item.content)
      : item.type === "steeringUserMessage" && item.status === "accepted" ? parseAsyncQuestionReply(item.input) : []).map(answer => answer.questionItemId));
    for (const item of items) {
      if (item.type !== "agentMessage" || item.delivery !== "async" || typeof item.id !== "string") continue;
      const rows = Array.isArray(item.questions) && item.questions.length ? item.questions : [{ title: item.text }];
      const questions: CodexQuestion[] = [];
      for (const [index, q] of rows.entries()) {
        if (!isObject(q) || typeof q.title !== "string" || !q.title.trim()) continue;
        const id = Array.isArray(item.questions) && item.questions.length ? JSON.stringify(["request_user_input_async", item.id, index]) : item.id;
        if (answered.has(id)) continue;
        questions.push({ id, title: q.title, secret: false,
          options: (Array.isArray(q.options) ? q.options : []).filter((o): o is string => typeof o === "string").map(label => ({ label })) });
      }
      if (questions.length) result.push(group({ kind: "async", key: JSON.stringify(["async", turn.turnId, item.id]), turnId: String(turn.turnId), questions }));
    }
  }
  return result;
}
