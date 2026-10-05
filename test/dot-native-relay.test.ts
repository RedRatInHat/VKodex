import test from "node:test";
import assert from "node:assert/strict";
import { DotRelayStore } from "../src/dot-native/relay-store.js";
import { DotNativeRelay, type DotNativeTransport } from "../src/dot-native/relay.js";
import type { BridgeInput, View } from "../src/bridge/contracts.js";
const peerId=2_000_000_123;
const binding={threadId:"dot",peerId,ownerId:42};
const item=(id:string,text:string)=>({id,type:"mcpToolCall",server:"codex_apps",tool:"user_message.send_message",status:"completed",arguments:{channel:"chatgpt",text}});
const turn=(id:string,items:unknown[]=[])=>({id,items,status:"completed"});
const snapshot=(turns:unknown[],cursor:string|null=null)=>({schemaVersion:1,thread:{id:"dot",hostId:"durable",kind:"codex"},page:{order:"newest_first",hasMore:cursor!==null,nextCursor:cursor},turns});
function fixture() {
 const store=new DotRelayStore(":memory:",binding);
 let head=snapshot([turn("t0",[item("old","do not mirror old history")])]);
 const pages=new Map<string,ReturnType<typeof snapshot>>();
 const sent:string[]=[]; const vk:Array<{peer:number;text:string;id:number}>=[];
 let sendError=false; let vkError=false;
 const native:DotNativeTransport={start:async()=>{},read:async cursor=>cursor?pages.get(cursor)!:head,
  send:async p=>{sent.push(p); if(sendError)throw Error("timeout"); return {threadId:"dot"};},close:()=>{}};
 const relay=new DotNativeRelay(store,{send:async(peer,view:View,id)=>{
   vk.push({peer,text:view.text,id}); if(vkError)throw Error("lost ack");
   return {peerId:peer,conversationMessageId:123};
 }},()=>native);
 const input=(eventId="event1",text="hello",senderId=42):BridgeInput=>({eventId,text,senderId,peerId});
 return {store,relay,sent,vk,pages,input,setHead:(s:ReturnType<typeof snapshot>)=>head=s,
  failSend:()=>sendError=true,failVk:(v:boolean)=>vkError=v,
  close:async()=>{await relay.stop();store.close();}};
}
test("baseline skips history; public new text is mirrored only once",async()=>{
 const f=fixture();try {
  await f.relay.tick();assert.equal(f.vk.length,0);
  f.setHead(snapshot([turn("t1",[item("new","public")]),turn("t0",[item("old","do not mirror old history")])]));
  await f.relay.tick();await f.relay.tick();
  assert.deepEqual(f.vk,[{peer:peerId,text:"public",id:-1}]);
 }finally{await f.close();}
});
test("only bound owner in dedicated peer can dispatch; duplicate events stay once",async()=>{
 const f=fixture();try {
  await f.relay.tick();
  assert.equal(await f.relay.handle({...f.input(),peerId:peerId+1}),false);
  assert.equal(await f.relay.handle(f.input("bad","evil",99)),true);
  await f.relay.handle(f.input());await f.relay.tick();await f.relay.handle(f.input());await f.relay.tick();
  assert.equal(f.sent.length,1);assert.match(f.sent[0]!,/"ownerId":42/);
 }finally{await f.close();}
});
test("uncertain native sends block following prompts without automatic replay",async()=>{
 const f=fixture();try {
  await f.relay.tick();f.failSend();
  await f.relay.handle(f.input());await f.relay.tick();
  await f.relay.handle(f.input("event2","second"));await f.relay.tick();await f.relay.tick();
  assert.equal(f.sent.length,1);assert.equal(f.store.uncertain,true);assert.match(f.vk[0]!.text,/повтор остановлен/);
 }finally{await f.close();}
});
test("pagination reaches overlap before publishing; missing anchor fails closed",async()=>{
 const f=fixture();try {
  await f.relay.tick();
  f.setHead(snapshot([turn("t2",[item("r2","two")])],"page2"));
  f.pages.set("page2",snapshot([turn("t1",[item("r1","one")])]));
  await f.relay.tick();assert.equal(f.vk.length,0);assert.equal(f.store.floor,"t0");
  f.pages.set("page2",snapshot([turn("t1",[item("r1","one")]),turn("t0")]));
  await f.relay.tick();assert.deepEqual(f.vk.map(m=>m.text),["one","two"]);
 }finally{await f.close();}
});
test("a larger later page never moves the floor backward or leaks older history",async()=>{
 const f=fixture();try {
  await f.relay.tick();
  f.setHead(snapshot([turn("t0",[item("old","do not mirror old history")]),turn("older",[item("secret-old","old reply")])]));
  await f.relay.tick();await f.relay.tick();assert.equal(f.store.floor,"t0");assert.equal(f.vk.length,0);
 }finally{await f.close();}
});
test("attachments and edits are explicitly rejected instead of silently stripped",async()=>{
 const f=fixture();try {
  await f.relay.tick();await f.relay.handle({...f.input(),hasAttachments:true});await f.relay.tick();
  assert.equal(f.sent.length,0);assert.match(f.vk[0]!.text,/только новые текстовые/);
 }finally{await f.close();}
});
test("outbound retries retain their exact VK idempotency identity",async()=>{
 const f=fixture();try {
  await f.relay.tick();f.failVk(true);
  f.setHead(snapshot([turn("t0",[item("old","do not mirror old history"),item("new","reply")])]));
  await f.relay.tick();assert.equal(f.vk.length,1);
  f.failVk(false);await f.relay.tick();assert.equal(f.vk.length,2);assert.equal(f.vk[0]!.id,f.vk[1]!.id);
 }finally{await f.close();}
});
test("outbox splitting preserves emoji codepoints",()=>{
 const store=new DotRelayStore(":memory:",binding);try {
  store.enqueueText("emoji","😀".repeat(4000));
  assert.equal(store.pendingOutbox().map(x=>x.text).join(""),"😀".repeat(4000));
  assert.ok(store.pendingOutbox().every(x=>x.text.length<=3000));
 }finally{store.close();}
});

test("offline owner prompts stay queued and receive a single status notice",async()=>{
 const store=new DotRelayStore(":memory:",binding);const messages:string[]=[];
 const relay=new DotNativeRelay(store,{send:async(peer,view)=>{messages.push(view.text);return {peerId:peer,conversationMessageId:1};}},()=>({
  start:async()=>{throw Error("offline");},read:async()=>({}),send:async()=>({}),close:()=>{},
 }));
 try {
  await relay.handle({peerId,senderId:42,eventId:"offline",text:"hello"});await relay.tick();await relay.tick();
  assert.equal(messages.length,1);assert.match(messages[0]!,/остаётся в очереди/);assert.ok(store.nextInput());
 }finally{await relay.stop();store.close();}
});
