import { createHmac } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Derive a read-only observation capability from the worker's DPAPI key.
 * The resulting token must stay in process memory, never in endpoint.json. */
export function deriveManagedTaskStateToken(controlToken: string, epoch: string,
  taskId: string, generation: number): string {
  if (typeof controlToken !== 'string' || !uuid.test(epoch) ||
      typeof taskId !== 'string' || !taskId || taskId.length > 256 ||
      !Number.isSafeInteger(generation) || generation < 1)
    throw new TypeError('Invalid managed task-state token scope');
  const raw = Buffer.from(controlToken, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== controlToken)
    throw new TypeError('Invalid managed task-state key');
  return createHmac('sha256', raw)
    .update('vkodex-managed-task-state-v1\0').update(epoch).update('\0').update(taskId)
    .update('\0').update(String(generation)).digest('base64url');
}
