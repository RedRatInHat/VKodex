import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeDotMcpClient, NativeMcpError, nativeChildEnvironment } from "../src/dot-native/mcp-client.js";

async function fixture(mode = "normal", timeoutMs = 2000) {
  const dir = await mkdtemp(join(tmpdir(), "vkodex-mcp-test-"));
  await writeFile(join(dir, "server.mjs"), `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const mode = ${JSON.stringify(mode)};
const out = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line); appendFileSync('wire.jsonl',line+'\\n');
 if (!m.method || m.id === undefined) return;
 if(m.method==='initialize') return out({id:m.id,result:{protocolVersion:'2024-11-05'}});
 if(m.method==='tools/list') return out({id:m.id,result:{tools:[{name:'read_thread'},{name:'send_message_to_thread'}]}});
 if(m.method==='tools/call') {
   const sending = m.params.name==='send_message_to_thread';
   if(sending && mode==='timeout') return;
   if(sending && mode==='reject') return out({id:m.id,result:{isError:true,content:[{type:'text',text:'secret error body'}]}});
   if(mode==='server-request') out({id:'approval',method:'elicitation/create',params:{}});
   const body = sending ? {threadId:'target',status:'inProgress'} : {
     schemaVersion:1,thread:{id:mode==='wrong-target'?'other':'target',hostId:'durable',kind:'codex'},
     page:{order:'newest_first',nextCursor:null,hasMore:false},turns:[]};
   out({id:m.id,result:{content:[{type:'text',text:JSON.stringify(body)}]}});
 }
});
`);
  const client = new NativeDotMcpClient({pluginRoot:dir,callerThreadId:"actual-caller",callerHostId:"durable",
    targetThreadId:"target",pipePath:"test-only-inherited-pipe",timeoutMs});
  return {client,wire:async() => (await readFile(join(dir,"wire.jsonl"),"utf8")).trim().split("\n").map(s=>JSON.parse(s)),
    close:async() => {client.close(); await new Promise(r=>setTimeout(r,80)); await rm(dir,{recursive:true,force:true});}};
}

test("native handshake and calls bind actual caller without model overrides", async () => {
 const f = await fixture(); try {
  const snapshot = await f.client.read(); assert.equal((snapshot.thread as {id:string}).id,"target");
  await f.client.send("hello");
  const wire = await f.wire();
  assert.equal(wire.filter(m=>m.method==='initialize').length,1);
  assert.equal(wire[1].method,"notifications/initialized");
  const calls = wire.filter(m=>m.method==='tools/call');
  assert.equal(calls.length,2);
  for(const c of calls) {
    assert.deepEqual(c.params._meta,{"openai/threadId":"actual-caller"});
    assert.equal(c.params.arguments.model,undefined); assert.equal(c.params.arguments.thinking,undefined);
  }
  assert.equal(calls[0].params.arguments.includeOutputs,false);
 } finally {await f.close();}
});
test("native target mismatch fails closed", async () => {
 const f = await fixture("wrong-target"); try {
  await assert.rejects(f.client.read(), /target mismatch/);
 } finally {await f.close();}
});
test("native send timeout is uncertain and never automatically replayed", async () => {
 const f = await fixture("timeout",300); try {
  await assert.rejects(f.client.send("once"), (e:unknown)=>e instanceof NativeMcpError && e.outcome==="uncertain");
  await assert.rejects(f.client.send("once"), (e:unknown)=>e instanceof NativeMcpError && e.outcome==="unavailable");
  assert.equal((await f.wire()).filter(m=>m.params?.name==='send_message_to_thread').length,1);
 } finally {await f.close();}
});
test("native tool errors never expose their raw bodies", async () => {
 const f = await fixture("reject"); try {
  await assert.rejects(f.client.send("once"), (e:unknown)=>e instanceof NativeMcpError && e.outcome==="uncertain" && !e.message.includes("secret"));
 } finally {await f.close();}
});
test("MCP approval requests are refused, not auto-approved", async () => {
 const f = await fixture("server-request"); try {
  await f.client.read(); await new Promise(r=>setTimeout(r,30));
  const response = (await f.wire()).find(m=>m.id==='approval');
  assert.equal(response.error.code,-32601);
 } finally {await f.close();}
});
test("caller cannot impersonate the target", () => {
 assert.throws(()=>new NativeDotMcpClient({pluginRoot:tmpdir(),callerThreadId:"same",callerHostId:"durable",targetThreadId:"same",pipePath:"x"}), /binding/);
});

test("native subprocess does not inherit VK or API credentials",()=>{
 const env=nativeChildEnvironment({Path:"runtime",SystemRoot:"system",VK_GROUP_TOKEN:"private",OPENAI_API_KEY:"private",NODE_OPTIONS:"guard"},"actual-pipe","durable");
 assert.equal(env.VK_GROUP_TOKEN,undefined);assert.equal(env.OPENAI_API_KEY,undefined);
 assert.equal(env.Path,"runtime");assert.equal(env.NODE_OPTIONS,"guard");
 assert.equal(env.CODEX_APP_TOOLS_PIPE_PATH,"actual-pipe");
});
