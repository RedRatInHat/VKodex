import { spawnSync } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";

interface Request {
  readonly executable: string;
  readonly modulePath: string;
  readonly command: string;
  readonly input: Uint8Array;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

const request = workerData as Request;
const payload = Buffer.from(request.input);
let result: ReturnType<typeof spawnSync> | null = null;
try {
  result = spawnSync(request.executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", request.command], {
      input: payload, windowsHide: true, timeout: request.timeoutMs, maxBuffer: request.maxBytes,
      env: { ...process.env, PSModulePath: request.modulePath },
    });
} catch {
  parentPort?.postMessage({ ok: false, phase: "spawn-throw" });
} finally {
  payload.fill(0); request.input.fill(0);
}

if (result) {
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout) ||
      result.stdout.byteLength > request.maxBytes) {
    const phase = result.error ? "process-error" : result.status === 42 ? "input-length" : `exit-${result.status}`;
    parentPort?.postMessage({ ok: false, phase });
  } else {
    const output = Uint8Array.from(result.stdout);
    parentPort?.postMessage({ ok: true, output });
    output.fill(0);
  }
  if (Buffer.isBuffer(result.stdout)) result.stdout.fill(0);
  if (Buffer.isBuffer(result.stderr)) result.stderr.fill(0);
}
