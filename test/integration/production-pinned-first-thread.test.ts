import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { AppServerUnavailableError } from '../../src/codex/app-server-connection.js';
import { compileControlledNativeStartParams } from '../../src/desktop/controlled-native-task-creator.js';
import { captureAuthenticatedProfileSourcePreflight } from
  '../../src/desktop/controlled-native-source-proof.js';
import { createPinnedDetachedProfileConnection, detachedProfileKey } from
  '../../src/codex/detached-profile-capability.js';
import { ensureProtectedLocalDirectory } from '../../src/desktop/managed-worker-private-state.js';
import { createNativeFirstTurnPrivateKey } from '../../src/desktop/native-first-turn-private-key.js';
import { NativeFirstTurnBootstrapJournal } from
  '../../src/desktop/native-first-turn-bootstrap-journal.js';
import { prepareNativeFirstThreadStart } from '../../src/desktop/native-first-turn-thread-start.js';
import { dispatchPreparedNativeFirstThreadStartCanary } from
  '../../src/desktop/native-first-thread-start-canary.js';
import { readWindowsProcessIdentity } from '../../src/desktop/windows-process-identity.js';
import { privateDirectoryAclVerificationScript, WINDOWS_PRIVATE_DIRECTORY_DIRECT_TIMEOUT_MS } from
  '../../src/desktop/windows-private-directory.js';

type AclPhase = 'ok' | 'acl-exit' | 'output-invalid' | 'timeout' | 'helper-error';
function aclPhase(directory: string): AclPhase {
  const root = process.env.SystemRoot ?? '';
  if (!path.win32.isAbsolute(root)) return 'helper-error';
  const executable = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const modulePath = path.win32.join(path.dirname(executable), 'Modules');
  const command = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$p=[Console]::In.ReadToEnd().Trim();" +
    privateDirectoryAclVerificationScript;
  const environment: NodeJS.ProcessEnv = { ...process.env };
  environment.PSModulePath = modulePath;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const result = spawnSync(executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    input: directory, encoding: 'utf8', windowsHide: true,
    timeout: WINDOWS_PRIVATE_DIRECTORY_DIRECT_TIMEOUT_MS, maxBuffer: 4096, env: environment,
  });
  if (result.error) return (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
    ? 'timeout' : 'helper-error';
  if (result.status === 0 && result.stdout === 'OK' && !result.stderr.trim()) return 'ok';
  return result.status === null ? 'helper-error' : result.status === 0 ? 'output-invalid' : 'acl-exit';
}

type AclPhases = readonly [AclPhase, AclPhase, AclPhase, AclPhase];

function aclFailureSummary(phases: AclPhases): string {
  const [serverRoot, profileRoot, profileDirectory, epochDirectory] = phases;
  return `Pinned connection failed; protected ACL phases: server-root=${serverRoot}, ` +
    `profile-root=${profileRoot}, profile-directory=${profileDirectory}, ` +
    `epoch-directory=${epochDirectory}`;
}

test('Windows production-pinned authenticated source permits one fenced first thread/start', {
  skip: process.platform !== 'win32', timeout: 90_000,
}, async () => {
  const localAppData = process.env.LOCALAPPDATA;
  assert.ok(localAppData && path.win32.isAbsolute(localAppData));
  const root = path.join(localAppData, `VKodex-first-start-integration-${randomUUID()}`);
  const serverToken = `integration-${randomUUID().replaceAll('-', '')}`;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 1024 * 1024,
    verifyClient: (info: { req: import('node:http').IncomingMessage }) =>
      info.req.headers.authorization === `Bearer ${serverToken}` });
  const serverListening = new Promise<void>(resolve => server.once('listening', resolve));
  let serverError: unknown;
  let startRequests = 0;
  const methods: string[] = [];
  const sockets = new Set<WebSocket>();
  let journal: NativeFirstTurnBootstrapJournal | undefined;
  let client: ReturnType<typeof createPinnedDetachedProfileConnection> | undefined;
  let listening = false;
  try {
    // Let the ACL helper create protected leaves; precreating them with mkdir
    // would leave an inherited ACL that its existing-directory check refuses.
    await ensureProtectedLocalDirectory(root);
    const serverRoot = path.join(root, 'server');
    const profileRoot = path.join(serverRoot, 'profiles');
    const home = path.join(root, 'source-home');
    const workspace = path.join(root, 'workspace');
    await ensureProtectedLocalDirectory(serverRoot);
    await ensureProtectedLocalDirectory(profileRoot);
    await Promise.all([mkdir(home), mkdir(workspace)]);
    await mkdir(path.join(home, 'sessions'), { recursive: true });
    const canonicalHome = await realpath(home);
    const privateDirectory = path.join(profileRoot, detachedProfileKey(canonicalHome));
    await ensureProtectedLocalDirectory(privateDirectory);

    const epoch = randomUUID();
    const epochDirectory = path.join(privateDirectory, epoch);
    await ensureProtectedLocalDirectory(epochDirectory);
    await writeFile(path.join(epochDirectory, 'token'), serverToken, { flag: 'wx' });
    await serverListening;
    listening = true;
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const processIdentity = readWindowsProcessIdentity(process.pid, 2_000);
    assert.ok(processIdentity && processIdentity.pid === process.pid);
    const descriptor = { schemaVersion: 1 as const, epoch,
      profileKey: detachedProfileKey(canonicalHome), home: canonicalHome,
      url: `ws://127.0.0.1:${address.port}`,
      backend: { pid: processIdentity.pid, birthTicks: processIdentity.birthTicks } };
    await writeFile(path.join(privateDirectory, 'ready.json'), JSON.stringify(descriptor), { flag: 'wx' });

    const key = await createNativeFirstTurnPrivateKey(privateDirectory);
    key.fill(0);
    const journalPath = path.join(privateDirectory, 'first-turn.sqlite');
    journal = new NativeFirstTurnBootstrapJournal(journalPath);
    const threadId = randomUUID();
    const scope = { operationId: randomUUID(), sourceId: 'windows-production-pinned-integration',
      sourceGeneration: randomUUID(), ownerEpoch: randomUUID() };
    const policy = { model: 'gpt-5.6-sol', modelProvider: 'openai', effort: 'medium', cwd: workspace,
      runtimeWorkspaceRoots: [workspace], allowedEnvironments: [[]], approvalPolicy: 'never',
      approvalsReviewer: 'user', activePermissionProfile: { id: ':read-only', extends: null },
      sandbox: { type: 'readOnly', networkAccess: false }, allowedServiceTiers: [null, 'default'] } as const;
    const preflight = await captureAuthenticatedProfileSourcePreflight({
      operationId: scope.operationId, sourceId: scope.sourceId,
      sourceGeneration: scope.sourceGeneration,
    }, canonicalHome, workspace);
    const protectedDirectories = [serverRoot, profileRoot, privateDirectory, epochDirectory] as const;
    const aclPhasesBeforeConnection = protectedDirectories.map(directory => aclPhase(directory)) as unknown as AclPhases;
    client = createPinnedDetachedProfileConnection(privateDirectory, canonicalHome, descriptor);
    const response = { thread: { id: threadId, status: { type: 'idle' }, turns: [], model: policy.model,
      modelProvider: policy.modelProvider, reasoningEffort: policy.effort, cwd: workspace, environments: [] },
      model: policy.model, modelProvider: policy.modelProvider, reasoningEffort: policy.effort,
      cwd: workspace, runtimeWorkspaceRoots: [workspace], approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer, activePermissionProfile: policy.activePermissionProfile,
      sandbox: policy.sandbox, serviceTier: 'default' };

    server.on('connection', (socket, request) => {
      try {
        assert.equal(request.headers.authorization, `Bearer ${serverToken}`);
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('message', frame => {
          void (async () => {
            const message = JSON.parse(frame.toString()) as Record<string, unknown>;
            if (typeof message.method === 'string') methods.push(message.method);
            if (message.id === undefined) return;
            if (message.method === 'initialize') {
              socket.send(JSON.stringify({ id: message.id, result: { serverInfo: { name: 'loopback-test' } } }));
              return;
            }
            if (message.method !== 'thread/start') throw new Error('Unexpected native request method');
            startRequests++;
            assert.deepEqual(message.params, compileControlledNativeStartParams(policy));
            const reopened = new NativeFirstTurnBootstrapJournal(journalPath);
            try {
              assert.equal(reopened.getThreadStartFenceStatus(scope.operationId), 'passed');
              assert.equal(reopened.get(scope.operationId)?.state, 'thread-reserved');
            } finally { reopened.close(); }
            socket.send(JSON.stringify({ id: message.id, result: response }));
          })().catch(error => { serverError = error; socket.close(1011); });
        });
      } catch (error) { serverError = error; socket.close(1011); }
    });

    let outcome: Awaited<ReturnType<typeof dispatchPreparedNativeFirstThreadStartCanary>> | undefined;
    try {
      const prepared = await prepareNativeFirstThreadStart(journal, scope, policy, client, preflight);
      outcome = await dispatchPreparedNativeFirstThreadStartCanary(journal, prepared);
    } catch (error) {
      if (error instanceof AppServerUnavailableError)
        assert.fail(`Pinned connection unavailable (class=AppServerUnavailableError); ` +
          aclFailureSummary(aclPhasesBeforeConnection));
      throw error;
    }
    if (serverError !== undefined)
      assert.fail('Loopback fake server validation failed (class=loopback-protocol-error)');
    if (!outcome) assert.fail('Canary returned no outcome (class=missing-outcome)');
    if (outcome.kind !== 'accepted')
      assert.fail(`Canary did not accept the start (class=${outcome.diagnostic}; fence=${outcome.writeFence})`);
    assert.equal(outcome.diagnostic, 'accepted');
    assert.equal(outcome.writeFence, 'passed');
    assert.equal(outcome.record.state, 'thread-accepted');
    assert.equal(outcome.record.threadId, threadId);
    assert.equal(startRequests, 1);
    assert.equal(methods.filter(method => method === 'thread/start').length, 1);
    assert.deepEqual(methods.filter(method => method !== 'initialized'), ['initialize', 'thread/start']);
  } finally {
    await client?.close();
    journal?.close();
    for (const socket of sockets) socket.terminate();
    if (listening) await new Promise<void>(resolve => server.close(() => resolve()));
    else server.close();
    let fixtureExists = true;
    try { await lstat(root); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') fixtureExists = false;
      else throw error;
    }
    if (fixtureExists) {
      try {
        const entry = await lstat(root);
        const resolvedRoot = await realpath(root);
        const [resolvedParent, localParent] = await Promise.all([
          stat(path.dirname(resolvedRoot), { bigint: true }),
          stat(localAppData, { bigint: true }),
        ]);
        const comparable = (value: string) => path.win32.normalize(value).toLowerCase();
        assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
        assert.equal(comparable(path.dirname(root)), comparable(localAppData));
        assert.equal(resolvedParent.dev, localParent.dev);
        assert.equal(resolvedParent.ino, localParent.ino);
        assert.equal(resolvedParent.birthtimeMs, localParent.birthtimeMs);
        assert.match(path.basename(resolvedRoot),
          /^VKodex-first-start-integration-[0-9a-f]{8}-[0-9a-f-]{27}$/u);
        const command = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:VKODEX_TEST_RECYCLE_TARGET, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)";
        await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 60_000,
          env: { ...process.env, VKODEX_TEST_RECYCLE_TARGET: resolvedRoot }, maxBuffer: 64 * 1024 });
        await assert.rejects(lstat(root), { code: 'ENOENT' });
      } catch (error) {
        throw new Error(`Windows integration fixture could not be moved to Recycle Bin; preserved at ${root}`, { cause: error });
      }
    }
  }
});
