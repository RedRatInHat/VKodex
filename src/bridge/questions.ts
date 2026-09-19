import { randomUUID } from "node:crypto";
import { ActionRejectedError, UncertainActionError, taskKey, type CodexTasks } from "../desktop/contracts.js";
import { pendingCodexQuestions, type CodexQuestions } from "../desktop/questions.js";
import type { IpcObject } from "../desktop/ipc-client.js";
import type { Binding, BridgeInput, Button, ManagerAction } from "./contracts.js";
import { BridgeStore } from "./store.js";
import { AccessGate } from "./delivery.js";

interface QuestionCard {
  readonly id: string;
  readonly scope: string;
  readonly question: CodexQuestions;
  readonly answers: Readonly<Record<string, string>>;
  readonly status: "open" | "sending" | "uncertain" | "answered" | "closed";
  readonly operationId?: string;
  readonly buttons?: readonly Button[];
}

/** Durable UI state only. Codex owns question lifetime and execution. */
export class TaskQuestions {
  private readonly inFlight = new Set<string>();
  constructor(private readonly desktop: CodexTasks, private readonly store: BridgeStore, private readonly gate: AccessGate, private readonly ownerId: number) {}

  private scope(binding: Binding): string { return JSON.stringify([taskKey(binding), this.store.streamGeneration(binding.id)]); }
  private cards(binding: Binding): QuestionCard[] { return this.store.getValue<QuestionCard[]>(`questions:${binding.id}`) ?? []; }
  private deliveryKey(binding: Binding, card: QuestionCard, index: number): string { return `question:${binding.id}:${card.id}:${index}`; }
  private index(card: QuestionCard): number { return card.question.questions.findIndex(q => !Object.hasOwn(card.answers, q.id)); }

  private save(binding: Binding, card: QuestionCard): void {
    const cards = this.cards(binding);
    const index = cards.findIndex(c => c.id === card.id);
    if (index < 0) cards.push(card); else cards[index] = card;
    this.store.setValue(`questions:${binding.id}`, cards);
    this.render(binding, card);
  }

  private render(binding: Binding, card: QuestionCard): void {
    if (binding.peerId === null) return;
    const index = this.index(card);
    // Each question keeps its own VK message ID. A late reply to question 1
    // must never be interpreted as the answer to question 2 after a page edit.
    const last = index < 0 ? card.question.questions.length - 1 : index;
    for (let step = 0; step <= last; step++) this.renderStep(binding, card, step, index);
  }

  private renderStep(binding: Binding, card: QuestionCard, step: number, index: number): void {
    const q = card.question.questions[step]!;
    const secret = card.question.questions.some(q => q.secret);
    const open = card.status === "open" && step === index && !secret;
    let tail = card.status === "answered" ? "Ответ передан в Codex." : card.status === "closed" ? "Вопрос закрыт или изменился в Codex."
      : card.status === "sending" ? "Передаю ответ в Codex…" : card.status === "uncertain" ? "Ответ мог быть отправлен. Автоматический повтор отключён; проверь вопрос в Codex."
      : secret ? "Вопрос содержит секретное поле. Ответь в Codex; секреты через VK не отправляй."
      : "Выбери вариант или ответь текстом на это сообщение (функция «Ответить» в VK). Ответить может владелец VKodex.";
    if (card.status === "open" && step < index) tail = "Ответ сохранён. Остальные вопросы — ниже; затем ответы будут переданы вместе.";
    if (open && card.question.kind === "async") tail += "\nАгент может продолжать работу, пока ждёт уточнение.";
    const options = q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n");
    const text = [`Codex · вопрос ${step + 1}/${card.question.questions.length}`, q.title.slice(0, 1400),
      open ? options.slice(0, 1600) : "", tail].filter(Boolean).join("\n\n");
    this.store.enqueue(this.deliveryKey(binding, card, step), binding.peerId!, { text,
      buttons: open ? card.buttons ?? [] : [], silent: !open }, binding.id, "panel", card.question.turnId);
  }

  private withButtons(binding: Binding, card: QuestionCard): QuestionCard {
    const index = this.index(card);
    const q = card.question.questions[index];
    if (!q || card.question.questions.some(q => q.secret)) return { ...card, buttons: [] };
    const button = (label: string, option: number): Button => ({ label,
      action: this.store.action({ type: "question", bindingId: binding.id, key: card.id, fingerprint: card.question.fingerprint, index, option }, Date.now(), binding.peerId) });
    return { ...card, buttons: [...q.options.slice(0, 8).map((o, i) => button(`${i + 1}. ${o.label}`.slice(0, 40), i)), button("Свой ответ", -1)] };
  }

  observe(binding: Binding, state: IpcObject): void { this.reconcile(binding, pendingCodexQuestions(state)); }

  private reconcile(binding: Binding, pending: readonly CodexQuestions[], refresh = false): void {
    if (!this.desktop.answerQuestions || !binding.attached || binding.peerId === null) return;
    const scope = this.scope(binding);
    for (const card of this.cards(binding)) {
      const live = card.scope === scope && pending.some(q => q.key === card.question.key && q.fingerprint === card.question.fingerprint);
      if (!live && !["answered", "closed"].includes(card.status)) this.save(binding, { ...card, status: "closed", buttons: [] });
      else if (live && card.status === "sending" && (!card.operationId || !this.inFlight.has(card.operationId))) this.save(binding, { ...card, status: "uncertain", buttons: [] });
      else if (refresh && live && card.status === "open") this.save(binding, this.withButtons(binding, card));
    }
    for (const question of pending) {
      if (!this.cards(binding).some(card => card.scope === scope && card.question.fingerprint === question.fingerprint)) {
        this.save(binding, this.withButtons(binding, { id: randomUUID(), scope, question, answers: {}, status: "open" }));
      }
    }
  }

  async text(input: BridgeInput): Promise<boolean> {
    const binding = this.store.byPeer(input.peerId);
    if (!binding) return false;
    if (input.text.trim() === "/questions") {
      this.assertOwner(input);
      this.store.setValue(`question-answer:${binding.id}`, null);
      if (!this.desktop.pendingQuestions) throw new ActionRejectedError("Вопросы не поддерживаются текущим адаптером.");
      const pending = await this.desktop.pendingQuestions(binding);
      this.reconcile(binding, pending, true);
      if (!pending.length) this.store.enqueue(`questions-empty:${input.peerId}:${input.eventId}`, input.peerId, { text: "Открытых вопросов Codex нет." }, binding.id);
      return true;
    }
    let card: QuestionCard | undefined;
    if (input.replyToMessageId !== undefined) {
      for (const candidate of this.cards(binding)) {
        const step = candidate.question.questions.findIndex((_, i) => this.store.deliveryHandle(this.deliveryKey(binding, candidate, i))?.conversationMessageId === input.replyToMessageId);
        if (step < 0) continue;
        if (step !== this.index(candidate)) throw new ActionRejectedError("На этот вопрос ответ уже сохранён. Ответь на следующую карточку или обнови /questions.");
        card = candidate; break;
      }
    } else if (!input.text.trimStart().startsWith("/") && input.editOfMessageId === undefined) {
      const selected = this.store.getValue<{ id: string; index: number; senderId: number }>(`question-answer:${binding.id}`);
      if (selected?.senderId === input.senderId) {
        card = this.cards(binding).find(c => c.id === selected.id);
        if (!card || this.index(card) !== selected.index) {
          this.store.setValue(`question-answer:${binding.id}`, null);
          throw new ActionRejectedError("Выбранный вопрос изменился. Ответ не отправлен; открой /questions.");
        }
      }
    }
    if (!card) return false;
    this.assertOwner(input);
    if (input.editOfMessageId !== undefined) throw new ActionRejectedError("Редактирование уже отправленного ответа не поддерживается. Ответь на актуальный вопрос заново.");
    if (input.attachments?.length || input.hasAttachments) throw new ActionRejectedError("Ответ на вопрос должен быть текстом без вложений.");
    await this.answer(binding, card, input.text.trim());
    this.store.setValue(`question-answer:${binding.id}`, null);
    return true;
  }

  async action(input: BridgeInput, action: Extract<ManagerAction, { type: "question" }>): Promise<void> {
    this.assertOwner(input);
    const binding = this.store.byPeer(input.peerId);
    if (!binding || binding.id !== action.bindingId) throw new ActionRejectedError("Вопрос относится к другой беседе.");
    const card = this.cards(binding).find(c => c.id === action.key);
    if (!card || card.question.fingerprint !== action.fingerprint || this.index(card) !== action.index) throw new ActionRejectedError("Кнопка вопроса устарела. Обнови /questions.");
    await this.check(binding, card);
    if (action.option === -1) {
      this.store.setValue(`question-answer:${binding.id}`, { id: card.id, index: action.index, senderId: input.senderId });
      this.store.enqueue(`question-text:${input.peerId}:${input.eventId}`, input.peerId, { text: "Напиши свой ответ следующим сообщением или ответь прямо на карточку вопроса. /questions — вернуться к вопросам." }, binding.id);
      return;
    }
    const option = card.question.questions[action.index]?.options[action.option];
    if (!option) throw new ActionRejectedError("Вариант ответа не найден.");
    await this.answer(binding, card, option.label);
    this.store.setValue(`question-answer:${binding.id}`, null);
  }

  private assertOwner(input: BridgeInput): void {
    if (input.senderId !== this.ownerId) throw new ActionRejectedError("На вопросы Codex через VK отвечает владелец VKodex.");
  }

  private async check(binding: Binding, card: QuestionCard): Promise<void> {
    const latest = this.store.getBinding(binding.id);
    if (!latest?.attached || latest.peerId !== binding.peerId || this.scope(latest) !== card.scope || this.store.transferBlocksInput(binding.id)) throw new ActionRejectedError("Беседа отключена или задача переносится. Ответ не отправлен.");
    if (card.status !== "open") throw new ActionRejectedError(card.status === "sending" || card.status === "uncertain" ? "Ответ мог быть отправлен. Повтор заблокирован; проверь состояние в Codex." : "Вопрос уже закрыт. Обнови /questions.");
    if (card.question.questions.some(q => q.secret)) throw new ActionRejectedError("На секретный вопрос ответь в Codex, не в VK.");
    if (!this.desktop.pendingQuestions || !this.desktop.answerQuestions) throw new ActionRejectedError("Ответы на вопросы не поддерживаются адаптером.");
    const pending = await this.desktop.pendingQuestions(binding);
    this.reconcile(binding, pending);
    if (!pending.some(q => q.fingerprint === card.question.fingerprint)) throw new ActionRejectedError("Вопрос уже закрыт или изменился. Ответ не отправлен; обнови /questions.");
  }

  private async answer(binding: Binding, card: QuestionCard, answer: string): Promise<void> {
    if (!answer || answer.length > 16_000) throw new ActionRejectedError("Напиши ответ длиной от 1 до 16000 символов.");
    await this.check(binding, card);
    const index = this.index(card);
    const q = card.question.questions[index];
    if (!q) throw new ActionRejectedError("Все ответы уже переданы.");
    const next = { ...card, answers: { ...card.answers, [q.id]: answer } };
    if (this.index(next) >= 0) { this.save(binding, this.withButtons(binding, next)); return; }
    const operationId = randomUUID();
    this.inFlight.add(operationId);
    this.save(binding, { ...next, status: "sending", operationId });
    this.store.recordOperation(operationId, binding);
    let attempted = false;
    try {
      await this.desktop.answerQuestions!(binding, card.question, next.answers, operationId, async () => {
        const current = this.store.getBinding(binding.id);
        if (!current?.attached || current.peerId !== binding.peerId || this.scope(current) !== card.scope || this.store.transferBlocksInput(binding.id) || !await this.gate.check(binding.peerId!, true)) throw new ActionRejectedError("Беседа отключена или задача переносится. Ответ не отправлен.");
        attempted = true;
      });
      this.store.finishOperation(operationId, "accepted");
      this.save(binding, { ...next, status: "answered", operationId });
    } catch (error) {
      // Never replay an ambiguous answer after restart or another button click.
      const safe = error instanceof ActionRejectedError || !attempted && !(error instanceof UncertainActionError);
      this.store.finishOperation(operationId, safe ? "rejected" : "uncertain");
      this.save(binding, safe ? this.withButtons(binding, { ...card, status: "open" }) : { ...next, status: "uncertain", operationId });
      throw error;
    } finally { this.inFlight.delete(operationId); }
  }
}
