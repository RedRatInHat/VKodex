import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { createReadStream, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

export interface WindowsNativeLauncherOptions {
  readonly runtimePath: string;
  readonly entryPath: string;
  readonly configPath: string;
  readonly runtimeSha256: string;
  readonly entrySha256: string;
  readonly configSha256: string;
  readonly extensionId: string;
  readonly outputNewDirectory: string;
}
const execFile = promisify(execFileCallback);
const absolute = (value: string): boolean => /^[a-z]:[\\/]/iu.test(value);
function validate(options: WindowsNativeLauncherOptions): void {
  for (const value of [options.runtimePath, options.entryPath, options.configPath, options.outputNewDirectory])
    if (typeof value !== "string" || !absolute(value) || /[\x00-\x1f\x7f]/u.test(value))
      throw new Error("Invalid native launcher path");
  for (const value of [options.runtimeSha256, options.entrySha256, options.configSha256])
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid native launcher pin");
  if (typeof options.extensionId !== "string" || !/^[a-p]{32}$/u.test(options.extensionId))
    throw new Error("Invalid native launcher extension ID");
}
const literal = (value: string): string => `@"${value.replaceAll('"', '""')}"`;

/** Pure source generation, without executing or installing anything. */
export function generateWindowsNativeLauncherSource(options: WindowsNativeLauncherOptions): string {
  validate(options);
  return String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

internal static class NativeLauncher {
  private const string Runtime = ${literal(options.runtimePath)};
  private const string Entry = ${literal(options.entryPath)};
  private const string Config = ${literal(options.configPath)};
  private const string RuntimePin = ${literal(options.runtimeSha256)};
  private const string EntryPin = ${literal(options.entrySha256)};
  private const string ConfigPin = ${literal(options.configSha256)};
  private const string Extension = ${literal(options.extensionId)};
  private const int EofGraceMs = 5000;
  private const int DrainGraceMs = 2000;

  private static bool Pinned(Stream stream, string expected) {
    using (var hash = SHA256.Create()) {
      return String.Equals(BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(),
        expected, StringComparison.Ordinal);
    }
  }
  private static string Quote(string value) {
    var text = new StringBuilder("\"");
    int slashes = 0;
    foreach (char ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') { text.Append('\\', slashes * 2 + 1); text.Append(ch); }
      else { text.Append('\\', slashes); text.Append(ch); }
      slashes = 0;
    }
    text.Append('\\', slashes * 2); text.Append('"');
    return text.ToString();
  }
  private static void StopOwnChild(Process child) {
    try { if (!child.HasExited) { child.Kill(); child.WaitForExit(DrainGraceMs); } }
    catch { /* Never enumerate or stop any other process. */ }
  }
  public static int Main(string[] args) {
    if (args.Length < 1 || args.Length > 2 ||
        !String.Equals(args[0], "chrome-extension://" + Extension + "/", StringComparison.Ordinal) ||
        args.Length == 2 && !Regex.IsMatch(args[1], @"\A--parent-window=[0-9]+\z")) return 64;
    try {
    // Keep verified files locked against writes/replacement through child exit.
    using (var runtimeFile = new FileStream(Runtime, FileMode.Open, FileAccess.Read, FileShare.Read))
    using (var entryFile = new FileStream(Entry, FileMode.Open, FileAccess.Read, FileShare.Read))
    using (var configFile = new FileStream(Config, FileMode.Open, FileAccess.Read, FileShare.Read)) {
    if (!Pinned(runtimeFile, RuntimePin) || !Pinned(entryFile, EntryPin) || !Pinned(configFile, ConfigPin)) return 78;
    using (var child = new Process()) {
      bool started = false;
      try {
        var info = new ProcessStartInfo(Runtime);
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.EnvironmentVariables["NODE_OPTIONS"] = "";
        info.EnvironmentVariables["NODE_PATH"] = "";
        info.Arguments = Quote(Entry) + " --config " + Quote(Config) + " --extension-id " + Quote(Extension) + " " + Quote(args[0]);
        if (args.Length == 2) info.Arguments += " " + Quote(args[1]);
        child.StartInfo = info;
        if (!child.Start()) return 70;
        started = true;
        int outputFailed = 0;
        var input = Task.Run(() => {
          try { Console.OpenStandardInput().CopyTo(child.StandardInput.BaseStream); }
          catch { /* Browser EOF or this child's closed input. */ }
          finally { try { child.StandardInput.Close(); } catch { } }
        });
        var output = Task.Run(() => {
          try {
            var browser = Console.OpenStandardOutput();
            child.StandardOutput.BaseStream.CopyTo(browser); browser.Flush();
          } catch { Interlocked.Exchange(ref outputFailed, 1); }
        });
        var errors = Task.Run(() => {
          try { child.StandardError.BaseStream.CopyTo(Stream.Null); }
          catch { /* Do not emit child diagnostics or configuration. */ }
        });
        while (!child.WaitForExit(100)) {
          if (Volatile.Read(ref outputFailed) != 0) { StopOwnChild(child); break; }
          if (input.IsCompleted) {
            if (!child.WaitForExit(EofGraceMs)) StopOwnChild(child);
            break;
          }
        }
        if (!child.HasExited) return 70;
        int exitCode = child.ExitCode;
        if (!Task.WaitAll(new Task[] { output, errors }, DrainGraceMs) || Volatile.Read(ref outputFailed) != 0) return 70;
        return exitCode;
      } catch { return 70; }
      finally { if (started) StopOwnChild(child); }
    }
    }
    } catch { return 78; }
  }
}
`;
}

async function hashFile(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Explicit prepare only: compile into a new directory, never register a host. */
export async function prepareWindowsNativeLauncher(options: WindowsNativeLauncherOptions): Promise<{
  readonly sourcePath: string; readonly launcherPath: string; readonly launcherSha256: string;
}> {
  const stable = { ...options }, source = generateWindowsNativeLauncherSource(stable);
  if (process.platform !== "win32") throw new Error("Windows compiler required");
  for (const filename of [stable.runtimePath, stable.entryPath, stable.configPath]) {
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Regular native launcher input required");
  }
  if (await hashFile(stable.runtimePath) !== stable.runtimeSha256 || await hashFile(stable.entryPath) !== stable.entrySha256 ||
      await hashFile(stable.configPath) !== stable.configSha256) throw new Error("Native launcher input pin mismatch");
  // mkdir is intentionally exclusive/non-recursive. Failed preparation is retained.
  mkdirSync(stable.outputNewDirectory);
  const sourcePath = path.join(stable.outputNewDirectory, "VKodexNativeLauncher.cs");
  const launcherPath = path.join(stable.outputNewDirectory, "VKodexNativeLauncher.exe");
  writeFileSync(sourcePath, source, { encoding: "utf8", flag: "wx" });
  const compiler = path.join(process.env.SystemRoot ?? "C:/Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  try {
    await execFile(compiler, ["/nologo", "/target:exe", "/optimize+", "/out:" + launcherPath, sourcePath],
      { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 });
  } catch { throw new Error("Native launcher compilation failed; staging retained"); }
  return { sourcePath, launcherPath, launcherSha256: await hashFile(launcherPath) };
}
