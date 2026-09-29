import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureControlledNativeSourcePreflight, ControlledNativeSourceUnqualifiedError,
  loadControlledNativeSourcePreflightReceipt, persistControlledNativeSourcePreflightReceipt,
  proveControlledNativeSource, type ControlledNativeSourceIdentity } from '../src/desktop/controlled-native-source-proof.js';
import { deriveControlledNativeCliSourceScope, assertControlledNativeCliSourceScope } from
  '../src/desktop/controlled-native-cli-source-scope.js';

const threadA = '00000000-0000-4000-8000-000000000001';
const threadB = '00000000-0000-4000-8000-000000000002';
const identity: ControlledNativeSourceIdentity = { operationId: '00000000-0000-4000-8000-000000000003',
  sourceId: 'isolated-source', sourceGeneration: '00000000-0000-4000-8000-000000000004' };

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vkodex-source-proof-'));
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  await Promise.all([mkdir(path.join(home, 'sessions'), { recursive: true }), mkdir(workspace)]);
  return { root, home, workspace };
}
async function rollout(home: string, id: string, cwd: string, name = id) {
  const file = path.join(home, 'sessions', `${name}.jsonl`);
  await writeFile(file, `${JSON.stringify({ ordinal: 0, type: 'session_meta', payload: { id, session_id: id, cwd } })}\n`);
  return file;
}
const rejected = (promise: Promise<unknown>) => assert.rejects(promise, ControlledNativeSourceUnqualifiedError);

test('header-only rollout qualifies after a recorded empty preflight without state sqlite', async () => {
  const f = await setup();
  const preflight = await captureControlledNativeSourcePreflight(identity, f.home, f.workspace);
  const file = await rollout(f.home, threadA, f.workspace);
  const proof = await proveControlledNativeSource(preflight, file, threadA);
  assert.equal(proof.threadId, threadA);
  assert.equal(proof.rolloutPath, await import('node:fs/promises').then(({ realpath }) => realpath(file)));
});

test('accepts an extended-length rollout path inside its ordinary source root on Windows', { skip: process.platform !== 'win32' }, async () => {
  const f = await setup();
  const preflight = await captureControlledNativeSourcePreflight(identity, f.home, f.workspace);
  const file = await rollout(f.home, threadA, f.workspace);
  const proof = await proveControlledNativeSource(preflight, path.toNamespacedPath(file), threadA);
  assert.equal(proof.threadId, threadA);
});

test('persists a receipt through an extended-length path inside its ordinary parent on Windows', { skip: process.platform !== 'win32' }, async () => {
  const f = await setup();
  const preflight = await captureControlledNativeSourcePreflight(identity, f.home, f.workspace);
  const receipt = path.toNamespacedPath(path.join(f.root, 'source-preflight.json'));
  await persistControlledNativeSourcePreflightReceipt(receipt, preflight);
  assert.equal((await import('node:fs/promises').then(({ stat }) => stat(receipt))).isFile(), true);
});

test('rejects a receipt whose parent directory is a symlink or junction', async () => {
  const f = await setup();
  const preflight = await captureControlledNativeSourcePreflight(identity, f.home, f.workspace);
  const parentLink = path.join(f.root, 'linked-parent');
  await symlink(f.root, parentLink, process.platform === 'win32' ? 'junction' : 'dir');
  await rejected(persistControlledNativeSourcePreflightReceipt(path.join(parentLink, 'source-preflight.json'), preflight));
});

test('existing matching history is not a before-start absence proof', async () => {
  const f = await setup();
  await rollout(f.home, threadA, f.workspace);
  await rejected(captureControlledNativeSourcePreflight(identity, f.home, f.workspace));
});

test('rejects path escape and symbolic rollout', async () => {
  const f = await setup(); const preflight = await captureControlledNativeSourcePreflight(identity, f.home, f.workspace);
  await mkdir(path.join(f.root, 'sessions'));
  const outside = await rollout(f.root, threadA, f.workspace, 'outside');
  await rejected(proveControlledNativeSource(preflight, outside, threadA));
  const link = path.join(f.home, 'sessions', 'link.jsonl');
  await symlink(outside, link);
  await rejected(proveControlledNativeSource(preflight, link, threadA));
});

test('rejects mismatched header ID or workspace', async () => {
  const f = await setup(); const preflight = await captureControlledNativeSourcePreflight(identity, f.home, f.workspace);
  const wrongId = await rollout(f.home, threadB, f.workspace);
  await rejected(proveControlledNativeSource(preflight, wrongId, threadA));
  const f2 = await setup(); const preflight2 = await captureControlledNativeSourcePreflight(identity, f2.home, f2.workspace);
  const wrongCwd = await rollout(f2.home, threadA, f2.root);
  await rejected(proveControlledNativeSource(preflight2, wrongCwd, threadA));
});

test('accepts workspace cwd through a symlinked ancestor alias on Windows', { skip: process.platform !== 'win32' }, async () => {
  const f = await setup();
  const preflight = await captureControlledNativeSourcePreflight(identity, f.home, f.workspace);
  const workspaceAliasParent = path.join(f.root, 'workspace-alias-parent');
  await symlink(f.root, workspaceAliasParent, 'junction');
  const workspaceAlias = path.join(workspaceAliasParent, path.basename(f.workspace));
  const file = await rollout(f.home, threadA, workspaceAlias);
  const proof = await proveControlledNativeSource(preflight, file, threadA);
  assert.equal(proof.threadId, threadA);
});

test('rejects duplicate thread rollouts and unknown metadata', async () => {
  const f = await setup(); const preflight = await captureControlledNativeSourcePreflight(identity, f.home, f.workspace);
  const first = await rollout(f.home, threadA, f.workspace, 'first');
  await rollout(f.home, threadA, f.workspace, 'second');
  await rejected(proveControlledNativeSource(preflight, first, threadA));
  const f2 = await setup(); const preflight2 = await captureControlledNativeSourcePreflight(identity, f2.home, f2.workspace);
  const valid = await rollout(f2.home, threadA, f2.workspace);
  await writeFile(path.join(f2.home, 'sessions', 'unknown.jsonl'), '{}\n');
  await rejected(proveControlledNativeSource(preflight2, valid, threadA));
});

test('durable receipt recovers the pre-start absence proof after process restart', async () => {
  const f = await setup(); const receipt = path.join(f.root, 'source-preflight.json');
  const preflight = await captureControlledNativeSourcePreflight(identity, f.home, f.workspace);
  await persistControlledNativeSourcePreflightReceipt(receipt, preflight);
  const file = await rollout(f.home, threadA, f.workspace);
  const reloaded = await loadControlledNativeSourcePreflightReceipt(receipt, identity, f.home, f.workspace);
  assert.equal((await proveControlledNativeSource(reloaded, file, threadA)).threadId, threadA);
});

test('CLI source scope rejects an unqualified or forged source before canary admission', async () => {
  const f = await setup(); const receipt = path.join(f.root, 'source-preflight.json');
  const preflight = await captureControlledNativeSourcePreflight(identity, f.home, f.workspace);
  await persistControlledNativeSourcePreflightReceipt(receipt, preflight);
  const file = await rollout(f.home, threadA, f.workspace);
  const journal = { get: () => ({ state: 'qualified', intent: { ...identity, sourceProofRequired: true },
    qualified: { ...identity, sourceProofRequired: true, threadId: threadA, rolloutPath: file,
      effectivePolicy: { threadId: threadA, cwd: f.workspace } } }) };
  await assert.rejects(deriveControlledNativeCliSourceScope({ journal: journal as never,
    operationId: identity.operationId, preflightReceiptPath: receipt,
    sourceHome: f.home, workspace: f.workspace }), /scope/i);
  assert.throws(() => assertControlledNativeCliSourceScope({} as never), /scope/i);
});

test('tampered durable receipt is rejected against the durable intent identity', async () => {
  const f = await setup(); const receipt = path.join(f.root, 'source-preflight.json');
  const preflight = await captureControlledNativeSourcePreflight(identity, f.home, f.workspace);
  await persistControlledNativeSourcePreflightReceipt(receipt, preflight);
  await writeFile(receipt, JSON.stringify({ schemaVersion: 1, operationId: identity.operationId,
    sourceId: identity.sourceId, sourceGeneration: '00000000-0000-4000-8000-000000000005',
    sourceHome: f.home, workspace: f.workspace, capturedAtMs: 1 }));
  await rejected(loadControlledNativeSourcePreflightReceipt(receipt, identity, f.home, f.workspace));
});

test('receipt cannot redirect source paths while retaining the same durable identity', async () => {
  const f = await setup(); const other = await setup(); const receipt = path.join(f.root, 'source-preflight.json');
  const preflight = await captureControlledNativeSourcePreflight(identity, f.home, f.workspace);
  await persistControlledNativeSourcePreflightReceipt(receipt, preflight);
  await writeFile(receipt, JSON.stringify({ schemaVersion: 1, ...identity,
    sourceHome: other.home, workspace: other.workspace, capturedAtMs: 1 }));
  await rejected(loadControlledNativeSourcePreflightReceipt(receipt, identity, f.home, f.workspace));
});

test('source inventory rejects excessive rollout count and nesting depth', async () => {
  const f = await setup();
  for (let index = 0; index < 129; index++) await writeFile(path.join(f.home, 'sessions', `${index}.jsonl`), '{}\n');
  await rejected(captureControlledNativeSourcePreflight(identity, f.home, f.workspace));
  const nested = await setup(); let directory = path.join(nested.home, 'sessions');
  for (let index = 0; index < 17; index++) { directory = path.join(directory, `level-${index}`); await mkdir(directory); }
  await writeFile(path.join(directory, 'deep.jsonl'), '{}\n');
  await rejected(captureControlledNativeSourcePreflight(identity, nested.home, nested.workspace));
});
