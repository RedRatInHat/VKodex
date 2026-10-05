import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotRuntimeConfig } from "../src/dot-native/runtime.js";
import { DotRelayStore } from "../src/dot-native/relay-store.js";
const config={version:1,enabled:true,peerId:2_000_000_001,threadId:"dot",callerThreadId:"owner-task",callerHostId:"durable",pluginRoot:tmpdir(),pipePath:"actual-inherited-pipe",inboundAfterMessageId:0};
test("runtime config is explicit, bounded and excludes credentials/model settings",()=>{
 assert.equal(parseDotRuntimeConfig(config).threadId,"dot");
 for(const patch of [{peerId:42},{callerThreadId:"dot"},{token:"secret"},{model:"anything"},{inboundAfterMessageId:-1},{pipePath:"x\n"},{enabled:false}])
  assert.throws(()=>parseDotRuntimeConfig({...config,...patch}));
});
test("journal restart preserves uncertain input and cannot silently rebind a peer",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"dot-journal-"));const filename=join(dir,"journal.sqlite");
 const binding={threadId:"dot",peerId:2_000_000_001,ownerId:42};
 let store=new DotRelayStore(filename,binding);
 try {
  store.queueInput("event","prompt");store.markInput("event","sending");
  store.enqueueText("public","answer");const id=store.pendingOutbox()[0]!.id;
  store.initializeInboundCursor(12);store.close();
  store=new DotRelayStore(filename,binding);
  assert.equal(store.uncertain,true);assert.equal(store.nextInput(),undefined);
  assert.equal(store.pendingOutbox()[0]!.id,id);
  store.initializeInboundCursor(999);assert.equal(store.inboundCursor,12);
  assert.throws(()=>new DotRelayStore(filename,{...binding,peerId:2_000_000_002}),/different binding/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
