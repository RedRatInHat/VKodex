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
  readonly commandHash: Uint8Array;
}

let replied = false;
function parserCoordinate(stderr: Buffer): string {
  const marker = Buffer.from("At line:", "ascii");
  const offset = stderr.indexOf(marker);
  if (offset < 0) return "";
  let index = offset + marker.length;
  const digits = (maximum: number): number | null => {
    let value = 0, count = 0;
    while (index < stderr.byteLength && stderr[index]! >= 48 && stderr[index]! <= 57 && count < 5) {
      value = value * 10 + stderr[index]! - 48; index++; count++;
    }
    return count > 0 && value > 0 && value <= maximum ? value : null;
  };
  const line = digits(1_000);
  while (index < stderr.byteLength && stderr[index] === 32) index++;
  const charMarker = Buffer.from("char:", "ascii");
  if (line === null || !stderr.subarray(index, index + charMarker.length).equals(charMarker)) return "";
  index += charMarker.length;
  const column = digits(16_384);
  return column === null ? "" : `-l${line}c${column}`;
}
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
      !("inputHash" in value) || !(value.inputHash instanceof Uint8Array) || value.inputHash.byteLength !== 32 ||
      !("commandHash" in value) || !(value.commandHash instanceof Uint8Array) || value.commandHash.byteLength !== 32) {
    if (value && typeof value === "object" && "input" in value && value.input instanceof Uint8Array)
      value.input.fill(0);
    if (value && typeof value === "object" && "inputHash" in value && value.inputHash instanceof Uint8Array)
      value.inputHash.fill(0);
    if (value && typeof value === "object" && "commandHash" in value && value.commandHash instanceof Uint8Array)
      value.commandHash.fill(0);
    send({ ok: false, phase: "invalid-input" }); return;
  }
  const request = value as Request;
  const actualHash = createHash("sha256").update(request.input).digest();
  const inputMatches = timingSafeEqual(actualHash, Buffer.from(request.inputHash));
  actualHash.fill(0); request.inputHash.fill(0);
  if (!inputMatches) { request.input.fill(0); request.commandHash.fill(0); send({ ok: false, phase: "input-mismatch" }); return; }
  const actualCommandHash = createHash("sha256").update(request.command, "utf8").digest();
  const commandMatches = timingSafeEqual(actualCommandHash, Buffer.from(request.commandHash));
  actualCommandHash.fill(0); request.commandHash.fill(0);
  if (!commandMatches) { request.input.fill(0); send({ ok: false, phase: "command-mismatch" }); return; }
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
    // Classify only a fixed failure category. Never forward PowerShell text:
    // it may contain the protected input or the unprotected output.
    let stderrKind = "empty";
    if (Buffer.isBuffer(stderr) && stderr.byteLength > 0) {
      stderrKind = stderr.includes("ScriptContainedMaliciousContent") || stderr.includes("malicious content") ||
        stderr.includes("blocked by your antivirus") ? "security" :
        stderr.includes("ParserError")
          ? stderr.includes("UnexpectedToken") ? "parser-token" :
            stderr.includes("MissingEndParenthesis") ? "parser-parenthesis" : "parser" :
        stderr.includes("Exception") || stderr.includes("InvalidOperation") || stderr.includes("ErrorRecord")
          ? "runtime" : "other";
    }
    const errorCode = result.error && "code" in result.error ? result.error.code : undefined;
    const phase = errorCode === "ETIMEDOUT" ? "timeout" :
      errorCode === "ENOBUFS" ? "output-limit" :
      result.error ? "process-error" : result.status === 42 ? "input-length" :
      `exit-${result.status}-${stderrKind}${stderrKind.startsWith("parser") && Buffer.isBuffer(stderr) ? parserCoordinate(stderr) : ""}`;
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
