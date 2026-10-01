import path from 'node:path';
import { DefaultFilesystem, WindowsDpapiProtector } from './managed-worker-private-state.js';
import { createPrivateKeyWithDependencies, loadPrivateKeyWithDependencies } from
  './native-first-turn-private-key-core.js';

const fail = (): never => { throw new Error('Native first-turn private key unavailable'); };

function productionDirectory(directory: string): string {
  if (typeof directory !== 'string' || !directory || directory.length > 4096 ||
      /[\x00-\x1f\x7f]/u.test(directory) || !path.isAbsolute(directory)) fail();
  if (process.platform !== 'win32') fail();
  const local = process.env.LOCALAPPDATA ?? '';
  if (!local || !path.win32.isAbsolute(local)) fail();
  const relative = path.win32.relative(local, directory);
  if (!relative || relative === '..' || relative.startsWith(`..${path.win32.sep}`) ||
      path.win32.isAbsolute(relative)) fail();
  return directory;
}

/** Production entrypoint: no fake protector/filesystem can be supplied. The
 * directory must be an app-owned private child of LocalAppData. Same-user
 * hostile path swaps are outside this path-based store's current guarantee. */
export async function createNativeFirstTurnPrivateKey(directory: string): Promise<Uint8Array> {
  return createPrivateKeyWithDependencies(productionDirectory(directory),
    new WindowsDpapiProtector(), new DefaultFilesystem());
}

/** Reads the exact existing DPAPI key; never rotates it on uncertainty. */
export async function loadNativeFirstTurnPrivateKey(directory: string): Promise<Uint8Array> {
  return loadPrivateKeyWithDependencies(productionDirectory(directory),
    new WindowsDpapiProtector(), new DefaultFilesystem());
}
