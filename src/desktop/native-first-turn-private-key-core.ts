import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { ManagedWorkerPrivateStateFilesystem,
  ManagedWorkerPrivateStateProtector } from './managed-worker-private-state.js';

const FILE = 'fingerprint-key.v1.dpapi';
const MAX_CIPHERTEXT_BYTES = 64 * 1024;
const fail = (): never => { throw new Error('Native first-turn private key unavailable'); };
const validDirectory = (directory: string): void => {
  if (typeof directory !== 'string' || !directory || directory.length > 4096 ||
      /[\x00-\x1f\x7f]/u.test(directory) || !path.isAbsolute(directory)) fail();
};

/** Dependency seams for isolated unit tests. Production callers must use the
 * facade, which always binds Windows DPAPI and the real private ACL store. */
export async function createPrivateKeyWithDependencies(directory: string,
  protector: ManagedWorkerPrivateStateProtector,
  filesystem: ManagedWorkerPrivateStateFilesystem): Promise<Uint8Array> {
  validDirectory(directory);
  await filesystem.ensureProtectedDirectory(directory);
  const key = randomBytes(32);
  let ciphertext: Uint8Array | null = null;
  try {
    ciphertext = await protector.protect(key);
    if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength < 1 ||
        ciphertext.byteLength > MAX_CIPHERTEXT_BYTES ||
        Buffer.from(ciphertext).equals(key)) fail();
    await filesystem.writeExclusive(path.join(directory, FILE), ciphertext);
    return Uint8Array.from(key);
  } finally {
    key.fill(0);
    ciphertext?.fill(0);
  }
}

/** Loading fails closed when the key is missing/corrupt; no auto-create. */
export async function loadPrivateKeyWithDependencies(directory: string,
  protector: ManagedWorkerPrivateStateProtector,
  filesystem: ManagedWorkerPrivateStateFilesystem): Promise<Uint8Array> {
  validDirectory(directory);
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
    await filesystem.ensureProtectedDirectory(directory);
    const ciphertext = await filesystem.readProtectedFile(path.join(directory, FILE));
    if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength < 1 ||
        ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) fail();
    try {
      const raw = await protector.unprotect(ciphertext);
      if (!(raw instanceof Uint8Array) || raw.byteLength !== 32) fail();
      try { return Uint8Array.from(raw); } finally { raw.fill(0); }
    } finally { ciphertext.fill(0); }
  } catch { return fail(); }
}
