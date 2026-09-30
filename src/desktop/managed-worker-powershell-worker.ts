import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";

const MAX_BYTES = 64 * 1024;
const MAX_ENCODED_INPUT_BYTES = 4 * Math.ceil(MAX_BYTES / 3);
const TIMEOUT_MS = 10_000;

interface Request {
  readonly command: string;
  readonly input: Uint8Array;
  readonly inputHash: Uint8Array;
}

let replied = false;
function send(message: { readonly ok: false; readonly phase: string } |
  { readonly ok: true; readonly output: Uint8Array }, after?: () => void): void {
  let released = false;
  const release = (): void => { if (!released) { released = true; after?.(); } };
  const disconnect = (): void => {
    if (process.connected) { try { process.disconnect(); } catch { process.exitCode = 1; } }
  };
  if (!process.send || !process.connected) { release(); process.exitCode = 1; return; }
  try {
    process.send(message, (error: Error | null) => {
      release();
      if (error) process.exitCode = 1;
      else replied = true;
      disconnect();
    });
  } catch { release(); process.exitCode = 1; disconnect(); }
}

process.once("disconnect", () => { if (!replied) process.exitCode = 1; });
process.once("message", (value: unknown) => {
  if (!value || typeof value !== "object" || !("command" in value) ||
      typeof value.command !== "string" || value.command.length > 16_384 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.command) || !("input" in value) ||
      !(value.input instanceof Uint8Array) || value.input.byteLength > MAX_ENCODED_INPUT_BYTES ||
      !("inputHash" in value) || !(value.inputHash instanceof Uint8Array) || value.inputHash.byteLength !== 32) {
    if (value && typeof value === "object" && "input" in value && value.input instanceof Uint8Array)
      value.input.fill(0);
    if (value && typeof value === "object" && "inputHash" in value && value.inputHash instanceof Uint8Array)
      value.inputHash.fill(0);
    send({ ok: false, phase: "invalid-input" }); return;
  }
  const request = value as Request;
  const actualHash = createHash("sha256").update(request.input).digest();
  const inputMatches = timingSafeEqual(actualHash, Buffer.from(request.inputHash));
  actualHash.fill(0); request.inputHash.fill(0);
  if (!inputMatches) { request.input.fill(0); send({ ok: false, phase: "input-mismatch" }); return; }
  const root = process.env.SystemRoot;
  if (!root || !path.win32.isAbsolute(root)) { request.input.fill(0); send({ ok: false, phase: "spawn-throw" }); return; }
  const executable = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const payload = Buffer.from(request.input);
  let result: ReturnType<typeof spawnSync> | null = null;
  try {
    result = spawnSync(executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", request.command], {
        input: payload, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES,
        env: { ...process.env, PSModulePath: path.win32.join(path.dirname(executable), "Modules") },
      });
  } catch { send({ ok: false, phase: "spawn-throw" }); }
  finally { payload.fill(0); request.input.fill(0); }
  if (!result) return;
  const stdout = result.stdout;
  const stderr = result.stderr;
  if (result.error || result.status !== 0 || !Buffer.isBuffer(stdout) || stdout.byteLength > MAX_BYTES) {
    const phase = result.error ? "process-error" : result.status === 42 ? "input-length" : `exit-${result.status}`;
    if (Buffer.isBuffer(stdout)) stdout.fill(0);
    if (Buffer.isBuffer(stderr)) stderr.fill(0);
    send({ ok: false, phase });
    return;
  }
  const output = Uint8Array.from(stdout);
  stdout.fill(0);
  if (Buffer.isBuffer(stderr)) stderr.fill(0);
  send({ ok: true, output }, () => output.fill(0));
});
