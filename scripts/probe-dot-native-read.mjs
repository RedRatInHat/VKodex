// Read-only protocol qualification. Uses an actual calling task, never the
// target dot as caller. No model, turn, send, approval, or configuration calls.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [pluginRoot, callerThreadId, callerHostId, targetThreadId, outputPath] = process.argv.slice(2);
if (!pluginRoot || !callerThreadId || !targetThreadId || !outputPath ||
    !['local', 'durable'].includes(callerHostId) || callerThreadId === targetThreadId) {
  throw new Error('Expected pluginRoot, actual caller task ID/host, target ID, output path');
}
if (!process.env.CODEX_APP_TOOLS_PIPE_PATH) throw new Error('Native pipe address is not supplied to this executor');
const serverPath = join(pluginRoot, 'server.mjs');
if (!existsSync(serverPath)) throw new Error('Verified bundled MCP server file is absent');
const result = { callerThreadId, callerHostId, targetThreadId, modelTurnsStarted: 0, serverRequestsRefused: [] };
const child = spawn(process.execPath, [serverPath], {
  cwd: pluginRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CODEX_APP_TOOLS_CALLER_HOST_ID: callerHostId },
});
const pending = new Map();
let nextId = 1;
let stderrBytes = 0;
let closing = false;
function failPending(error) {
  for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
  pending.clear();
}
child.stderr.on('data', b => { stderrBytes += b.length; });
child.on('error', e => failPending(new Error(`Spawn failed: ${e.code ?? 'unknown'}`)));
child.on('exit', code => { if (!closing) failPending(new Error(`MCP process exited: ${code}`)); });
child.stdin.on('error', e => failPending(new Error(`MCP input failed: ${e.code ?? 'unknown'}`)));
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let m;
  try { m = JSON.parse(line); } catch { failPending(new Error('Non-JSON MCP output')); return; }
  if (m.method && m.id !== undefined) {
    result.serverRequestsRefused.push(m.method);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Probe does not approve or service requests' } }) + '\n');
    return;
  }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id); clearTimeout(p.timer);
  if (m.error) p.reject(new Error(`JSON-RPC ${m.error.code}: ${String(m.error.message).slice(0, 300)}`));
  else p.resolve(m.result);
});
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 40_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const watchdog = setTimeout(() => { failPending(new Error('Probe deadline exceeded')); child.kill(); }, 115_000);
try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'vkodex-native-read-probe', version: '0.1.0' },
  });
  result.initialized = true;
  result.protocolVersion = init.protocolVersion;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const catalog = await request('tools/list', {});
  result.readToolAvailable = catalog.tools?.some(t => t.name === 'read_thread') === true;
  if (!result.readToolAvailable) throw new Error('Native read_thread is not exposed');
  // This is the real calling task supplied by the executor. Turn metadata is
  // deliberately omitted: the bundled server's MCP fallback is used.
  const reply = await request('tools/call', {
    name: 'read_thread',
    arguments: { threadId: targetThreadId, hostId: 'durable', turnLimit: 10, includeOutputs: false, maxOutputCharsPerItem: 0 },
    _meta: { 'openai/threadId': callerThreadId },
  });
  if (reply.isError) {
    result.toolError = reply.content?.filter(x => x.type === 'text').map(x => x.text).join('\n').slice(0, 600) ?? 'Native tool error';
    throw new Error('Native tool returned an error');
  }
  const content = reply.structuredContent ?? JSON.parse(reply.content.find(x => x.type === 'text').text);
  if (content.thread?.id !== targetThreadId || content.thread?.hostId !== 'durable') throw new Error('Target binding mismatch');
  result.target = { id: content.thread.id, hostId: content.thread.hostId, kind: content.thread.kind };
  result.turnCount = content.turns?.length ?? 0;
  result.page = content.page;
  result.publicChatMessageCalls = (content.turns ?? []).flatMap(t => t.items ?? []).filter(i =>
    i.type === 'mcpToolCall' && i.server === 'codex_apps' && i.tool === 'user_message.send_message' &&
    i.status === 'completed' && i.arguments?.channel === 'chatgpt' && typeof i.arguments.text === 'string'
  ).map(i => ({ id: i.id, textLength: i.arguments.text.length }));
  result.success = true;
} catch (e) {
  result.success = false; result.error = String(e.message).slice(0, 600);
} finally {
  closing = true; clearTimeout(watchdog); failPending(new Error('Probe finished'));
  child.stdin.end();
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 1500); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
  lines.close(); result.stderrBytes = stderrBytes;
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  process.exitCode = result.success ? 0 : 1;
}
