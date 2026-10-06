import DatabaseConstructor, { type Database } from "better-sqlite3";
import { createHash } from "node:crypto";
import type { DotPublicReply } from "./public-replies.js";
import { diagnosticEvent } from "../bridge/diagnostics.js";

export interface DotBinding { readonly threadId: string; readonly peerId: number; readonly ownerId: number }
export interface DotOutbox { readonly id: number; readonly text: string }
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** Separate opt-in journal. Contains only owner prompts, public reply text and IDs.
 * No native history, reasoning, tool arguments, pipe address or credentials.
 */
export class DotRelayStore {
  private readonly db: Database;
  constructor(filename: string, readonly binding: DotBinding) {
    if (!binding.threadId || !Number.isSafeInteger(binding.ownerId) || binding.ownerId <= 0 ||
      !Number.isSafeInteger(binding.peerId) || binding.peerId < 2_000_000_000) throw new TypeError("Invalid dedicated dot binding");
    this.db = new DatabaseConstructor(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS dot_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dot_seen(id TEXT PRIMARY KEY,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dot_inbox(id TEXT PRIMARY KEY,hash TEXT NOT NULL,prompt TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','sending','sent','uncertain')));
      CREATE TABLE IF NOT EXISTS dot_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT UNIQUE NOT NULL,
        text TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);`);
    const encoded = JSON.stringify([binding.threadId,binding.peerId,binding.ownerId]);
    const old = this.value("binding");
    if (old !== null && old !== encoded) { this.db.close(); throw new Error("Dot journal belongs to a different binding"); }
    this.set("binding", encoded);
    // A previous process may have dispatched a mutation before crashing.
    this.db.prepare("UPDATE dot_inbox SET state='uncertain' WHERE state='sending'").run();
  }
  close(): void { this.db.close(); }
  private value(key: string): string | null {
    return (this.db.prepare("SELECT value FROM dot_meta WHERE key=?").get(key) as {value:string}|undefined)?.value ?? null;
  }
  private set(key: string, value: string): void {
    this.db.prepare("INSERT INTO dot_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,value);
  }
  get inboundCursor(): number { return Number(this.value("inbound-cursor") ?? "0"); }
  initializeInboundCursor(id: number): void {
    if(this.value("inbound-cursor")===null)this.advanceInboundCursor(id);
  }
  advanceInboundCursor(id: number): void {
    if (!Number.isSafeInteger(id) || id < this.inboundCursor) throw new Error("Invalid VK recovery cursor");
    this.set("inbound-cursor",String(id));
  }
  get initialized(): boolean { return this.value("initialized") === "yes"; }
  get floor(): string | null { return this.value("floor"); }
  private remember(reply: DotPublicReply): boolean {
    const hash = digest(JSON.stringify([reply.text,reply.attachmentCount]));
    const row = this.db.prepare("SELECT hash FROM dot_seen WHERE id=?").get(reply.itemId) as {hash:string}|undefined;
    if (row && row.hash !== hash) throw new Error("Public reply identity changed");
    if (row) return false;
    this.db.prepare("INSERT INTO dot_seen VALUES(?,?)").run(reply.itemId,hash); return true;
  }
  baseline(replies: readonly DotPublicReply[], floor: string): void {
    this.db.transaction(()=>{
      if (this.initialized) throw new Error("Cannot replace an existing dot baseline");
      replies.forEach(reply=>this.remember(reply)); this.set("floor",floor); this.set("initialized","yes");
    })();
  }
  commitPoll(replies: readonly DotPublicReply[], floor: string): void {
    this.db.transaction(()=>{
      if (!this.initialized) throw new Error("Dot baseline is absent");
      for (const reply of replies) {
        if (!this.remember(reply)) continue;
        diagnosticEvent("mirror.discovery", { route:"dot-native", threadId:this.binding.threadId, turnId:reply.turnId, eventId:reply.itemId });
        const text = reply.text + (reply.attachmentCount ? "\n\n[Вложения доступны в приложении dot.]" : "");
        this.enqueueText(`reply:${reply.itemId}`,text);
      }
      this.set("floor",floor);
    })();
  }
  enqueueText(key: string, text: string): void {
    // Code-point splitting keeps surrogate pairs intact; parts stay well below VK's limit.
    const parts: string[] = []; let part = "";
    for(const point of text) {
      if(part.length + point.length > 3000) {parts.push(part);part="";}
      part += point;
    }
    if(part) parts.push(part);
    parts.forEach((body,index)=>{
      const result=this.db.prepare("INSERT OR IGNORE INTO dot_outbox(key,text) VALUES(?,?)").run(`${key}:${index}`,body);
      if(result.changes) diagnosticEvent("delivery.queued", { route:"dot-native", threadId:this.binding.threadId, peerId:this.binding.peerId, eventId:key, operationId:`dot-outbox:${result.lastInsertRowid}` });
    });
  }

  queueInput(id: string, prompt: string): boolean {
    const hash = digest(prompt);
    const row = this.db.prepare("SELECT hash FROM dot_inbox WHERE id=?").get(id) as {hash:string}|undefined;
    if(row) { if(row.hash!==hash) throw new Error("Duplicate owner event changed"); return false; }
    this.db.prepare("INSERT INTO dot_inbox VALUES(?,?,?,'queued')").run(id,hash,prompt); return true;
  }
  get uncertain(): boolean { return !!this.db.prepare("SELECT 1 FROM dot_inbox WHERE state='uncertain' LIMIT 1").get(); }
  nextInput(): {id:string;prompt:string}|undefined {
    // Preserve owner order; uncertainty must be resolved before more prompts.
    if(this.db.prepare("SELECT 1 FROM dot_inbox WHERE state IN ('sending','uncertain') LIMIT 1").get()) return undefined;
    return this.db.prepare("SELECT id,prompt FROM dot_inbox WHERE state='queued' ORDER BY rowid LIMIT 1").get() as {id:string;prompt:string}|undefined;
  }
  markInput(id: string, state: "sending"|"sent"|"uncertain"): void {
    const from = state==='sending' ? 'queued' : 'sending';
    if(this.db.prepare("UPDATE dot_inbox SET state=? WHERE id=? AND state=?").run(state,id,from).changes!==1)
      throw new Error("Invalid dot input transition");
  }
  pendingOutbox(): DotOutbox[] { return this.db.prepare("SELECT id,text FROM dot_outbox WHERE delivered=0 ORDER BY id LIMIT 5").all() as DotOutbox[]; }
  delivered(id: number): void { this.db.prepare("UPDATE dot_outbox SET delivered=1 WHERE id=?").run(id); }
}
