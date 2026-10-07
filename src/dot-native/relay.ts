import type { BridgeChat, BridgeInput } from "../bridge/contracts.js";
import { extractDotPublicReplies, type DotPublicReply } from "./public-replies.js";
import { DotRelayStore } from "./relay-store.js";
import { NativeMcpError } from "./mcp-client.js";
import { diagnosticEvent, diagnosticError } from "../bridge/diagnostics.js";

type Obj = Record<string,unknown>;
const object = (v:unknown):v is Obj => v!==null && typeof v==='object' && !Array.isArray(v);
export interface DotNativeTransport {
  start():Promise<void>; read(cursor?:string):Promise<Obj>; send(prompt:string):Promise<Obj>; close():void;
}
export type DotRelayHealth = "starting"|"ready"|"unavailable"|"history-gap"|"uncertain-input"|"stopped";
/** One dedicated VK peer, using the existing gateway and authenticated owner ID.
 * Never falls back to another model, browser, thread or recipient.
 */
export class DotNativeRelay {
  private transport: DotNativeTransport | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<void> | null = null;
  private stopped = false;
  private health: DotRelayHealth = "starting";
  constructor(private readonly store: DotRelayStore, private readonly chat: Pick<BridgeChat,"send">,
    private readonly createTransport:()=>DotNativeTransport,
    private readonly onHealth:(state:DotRelayHealth)=>void = ()=>{},
    private readonly recoverInput?: (peerId:number,after:number)=>Promise<{inputs:BridgeInput[];cursor:number}>) {}
  get peerId():number { return this.store.binding.peerId; }
  private status(state:DotRelayHealth):void { if(this.health!==state) { this.health=state; diagnosticEvent("connection.lifecycle", {route:"dot-native",threadId:this.store.binding.threadId,stage:state}); try {this.onHealth(state);} catch { /* Health reporting is observational. */ } } }
  start(intervalMs=10_000):void {
    if(this.timer || this.stopped) return;
    if(intervalMs<1000) throw new RangeError("Dot polling is too frequent");
    this.timer=setInterval(()=>void this.tick(),intervalMs); this.timer.unref(); void this.tick();
  }
  async stop():Promise<void> {
    this.stopped=true; if(this.timer)clearInterval(this.timer); this.timer=null;
    this.transport?.close(); await this.busy; this.transport=null; this.status("stopped");
  }
  async handle(input:BridgeInput):Promise<boolean> {
    if(input.peerId!==this.peerId) return false;
    // Swallow this dedicated peer even for unauthorized users; never route it to Codex.
    if(this.stopped || input.senderId!==this.store.binding.ownerId) return true;
    const key=JSON.stringify([input.peerId,input.eventId]);
    diagnosticEvent("input.received", { route:"dot-native", threadId:this.store.binding.threadId, peerId:this.peerId, eventId:input.eventId, operationId:key });
    if(input.action || input.conversationTitle) return true;
    if(input.editOfMessageId || input.hasAttachments || input.attachments?.length || input.attachmentError) {
      this.store.enqueueText(`unsupported:${key}`,"Пока мост dot принимает только новые текстовые сообщения. Файлы и исправления отправляйте в приложении dot.");
      void this.tick(); return true;
    }
    if(!input.text.trim())return true;
    if(input.text.length>50_000) {
      this.store.enqueueText(`large:${key}`,"Сообщение слишком длинное для моста dot."); void this.tick(); return true;
    }
    // The sender was checked above against VK's actual authenticated sender ID.
    const prompt=`[VKODEX_OWNER_MESSAGE]\n${JSON.stringify({peerId:input.peerId,eventId:input.eventId,ownerId:input.senderId,text:input.text})}`;
    if(this.store.queueInput(key,prompt)) diagnosticEvent("input.queued", { route:"dot-native", threadId:this.store.binding.threadId, peerId:this.peerId, eventId:input.eventId, operationId:key });
    void this.tick(); return true;
  }
  tick():Promise<void> {
    if(this.stopped) return Promise.resolve();
    return this.busy ??= this.run().finally(()=>{this.busy=null;});
  }
  private async run():Promise<void> {
    const attemptedDeliveries=new Set<number>();
    // Already-journaled deliveries must not wait for native reads or sends.
    // The existing outbox identity still owns retries; this is not a resubmit.
    try { await this.flush(attemptedDeliveries); } catch { this.status("unavailable"); }
    let stage = "connect";
    try {
      this.transport ??= this.createTransport();
      await this.transport.start();
      stage = "snapshot";
      await this.poll();
      if(this.stopped)return;
      // Publish newly discovered replies before potentially slow input recovery
      // or a native mutation. A failed VK send must not change input admission.
      try { await this.flush(attemptedDeliveries); } catch { this.status("unavailable"); }
      if(this.stopped)return;
      stage = "observe";
      if(this.recoverInput) {
        const recovered=await this.recoverInput(this.peerId,this.store.inboundCursor);
        for(const input of recovered.inputs) await this.handle(input);
        this.store.advanceInboundCursor(recovered.cursor);
      }
      stage = "dispatch";
      const input=this.store.nextInput();
      if(input) {
        this.store.markInput(input.id,"sending");
        const sendStarted=Date.now();
        diagnosticEvent("input.started", { route:"dot-native", threadId:this.store.binding.threadId, operationId:input.id });
        try {
          await this.transport.send(input.prompt);
          this.store.markInput(input.id,"sent");
          diagnosticEvent("input.result", { route:"dot-native", threadId:this.store.binding.threadId, operationId:input.id, outcome:"accepted", elapsedMs:Date.now()-sendStarted });
        } catch(error) {
          diagnosticEvent("input.result", { route:"dot-native", threadId:this.store.binding.threadId, operationId:input.id, outcome:"unknown", elapsedMs:Date.now()-sendStarted, ...diagnosticError(error) });
          // Conservatively retain uncertainty even if the native tool itself returned an error.
          this.store.markInput(input.id,"uncertain");
          this.store.enqueueText(`uncertain:${input.id}`,"Доставка последнего сообщения в dot не подтверждена. Автоматический повтор остановлен, чтобы не выполнить запрос дважды.");
          this.status("uncertain-input");
        }
      }
    } catch(error) {
      diagnosticEvent("connection.result", {route:"dot-native",threadId:this.store.binding.threadId,stage,outcome:"failure",...diagnosticError(error)});
      this.status(error instanceof Error && error.message==="Dot history gap" ? "history-gap" : "unavailable");
      this.transport?.close(); this.transport=null;
      const waiting=this.store.nextInput();
      if(waiting) this.store.enqueueText(`waiting:${waiting.id}`,"Сообщение сохранено. Связь с dot пока недоступна; запрос остаётся в очереди.");
    }
    // Outbound already-journaled public replies remain deliverable during a native outage.
    try {await this.flush(attemptedDeliveries);} catch { this.status("unavailable"); /* Retry later with the same VK random_id. */ }
  }
  private async poll():Promise<void> {
    const native=this.transport!;
    const head=await this.readSnapshot(native);
    const headReplies=extractDotPublicReplies(head,this.store.binding.threadId);
    const headTurns=head.turns as Obj[];
    if(!headTurns.length) throw new NativeMcpError("unavailable","Dot has no qualified baseline turns");
    const floor=headTurns.at(-1)!.id as string;
    if(!this.store.initialized) {
      this.store.baseline(headReplies,floor); this.status("ready"); return;
    }
    const oldFloor=this.store.floor;
    const pages:DotPublicReply[][]=[];
    const cursors=new Set<string>();
    let snapshot=head;
    for(let count=0;count<200;count++) {
      const replies=extractDotPublicReplies(snapshot,this.store.binding.threadId);
      const turns=snapshot.turns as Obj[];
      const boundary=turns.findIndex(t=>t.id===oldFloor);
      const allowed=new Set((boundary<0?turns:turns.slice(0,boundary+1)).map(t=>t.id));
      pages.push(replies.filter(r=>allowed.has(r.turnId)));
      if(boundary>=0) {
        const nextFloor=headTurns.some(t=>t.id===oldFloor) ? oldFloor! : floor;
        this.store.commitPoll(pages.reverse().flat(),nextFloor); this.status(this.store.uncertain ? "uncertain-input" : "ready"); return;
      }
      const page=snapshot.page;
      if(!object(page) || page.hasMore!==true || typeof page.nextCursor!=="string" || !page.nextCursor || cursors.has(page.nextCursor)) break;
      cursors.add(page.nextCursor); snapshot=await this.readSnapshot(native,page.nextCursor);
      if(this.stopped)return;
    }
    throw new Error("Dot history gap");
  }
  private async readSnapshot(native:DotNativeTransport,cursor?:string):Promise<Obj> {
    const started=Date.now();
    diagnosticEvent("mirror.poll", { route:"dot-native", threadId:this.store.binding.threadId, stage:"start" });
    try {
      const snapshot=await native.read(cursor);
      diagnosticEvent("mirror.poll", { route:"dot-native", threadId:this.store.binding.threadId, stage:"finished", outcome:"success", elapsedMs:Date.now()-started });
      return snapshot;
    } catch(error) {
      diagnosticEvent("mirror.poll", { route:"dot-native", threadId:this.store.binding.threadId, stage:"finished", outcome:"failure", elapsedMs:Date.now()-started, ...diagnosticError(error) });
      throw error;
    }
  }
  private async flush(attemptedDeliveries:Set<number>):Promise<void> {
    for(const item of this.store.pendingOutbox()) {
      if(this.stopped)return;
      // A lost ACK is retried on the next tick, never twice in this tick.
      // Keep later replies behind an unresolved earlier delivery.
      if(attemptedDeliveries.has(item.id))return;
      attemptedDeliveries.add(item.id);
      if(item.id>2_147_483_647)throw new Error("Dot delivery identity exhausted");
      const started=Date.now();
      const fields={route:"dot-native",threadId:this.store.binding.threadId,peerId:this.peerId,operationId:`dot-outbox:${item.id}`};
      diagnosticEvent("delivery.attempt", {...fields,stage:"start"});
      try {
      const handle=await this.chat.send(this.peerId,{text:item.text},-item.id);
      if(handle.peerId!==this.peerId || !Number.isSafeInteger(handle.conversationMessageId) || handle.conversationMessageId<=0)
        throw new Error("Dot delivery recipient mismatch");
      this.store.delivered(item.id);
      diagnosticEvent("delivery.result", {...fields,outcome:"accepted",elapsedMs:Date.now()-started});
      } catch(error) {
        diagnosticEvent("delivery.result", {...fields,outcome:"unknown",elapsedMs:Date.now()-started,...diagnosticError(error)});
        throw error;
      }
    }
  }
}
