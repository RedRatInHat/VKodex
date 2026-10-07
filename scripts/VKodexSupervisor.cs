using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;
using System.Reflection;

[assembly: AssemblyTitle("VKodex Bridge")]
[assembly: AssemblyProduct("VKodex")]
[assembly: AssemblyDescription("VKodex bridge supervisor")]
[assembly: AssemblyCompany("VKodex")]

internal static class Program
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    private static int Main(string[] args)
    {
        if (args.Length != 1 || args[0].StartsWith("--", StringComparison.Ordinal)) return VersionedMain(args);
        if (args.Length != 1 || string.IsNullOrWhiteSpace(args[0]))
        {
            Console.Error.WriteLine("VKodexSupervisor requires the project directory.");
            return 2;
        }

        string projectRoot;
        try { projectRoot = Path.GetFullPath(args[0]); }
        catch
        {
            Console.Error.WriteLine("VKodexSupervisor received an invalid project directory.");
            return 2;
        }

        var supervisorScript = Path.Combine(projectRoot, "scripts", "run-windows-supervisor.ps1");
        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!File.Exists(supervisorScript) || !File.Exists(powershell) || supervisorScript.Contains("\""))
        {
            Console.Error.WriteLine("VKodexSupervisor could not find its required local files.");
            return 2;
        }

        SetCurrentProcessExplicitAppUserModelID("RedRatInHat.VKodex.Bridge");
        Console.Title = "VKodex Bridge - DO NOT CLOSE";
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine("VKodex Bridge - DO NOT CLOSE THIS WINDOW");
        Console.ResetColor();

        var startInfo = new ProcessStartInfo
        {
            FileName = powershell,
            Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + supervisorScript + "\"",
            WorkingDirectory = projectRoot,
            UseShellExecute = false,
            CreateNoWindow = false,
        };
        // Do not put native clients launched by the bridge in a kill-on-close job.
        try
        {
            using (var child = Process.Start(startInfo))
            {
                if (child == null) throw new InvalidOperationException();
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch
        {
            Console.Error.WriteLine("VKodexSupervisor could not start the PowerShell supervisor.");
            return 1;
        }
    }

    // The trusted parent verifies this EXE BEFORE CLR startup. These checks do
    // not authenticate a substituted parent or implement a same-user sandbox.
    // Never add a kill-on-close job or a native/backend process-tree kill here.
    private const int ValidationRefused = 86;
    private static readonly string[] BundleFiles = {
        "launcher/VKodexSupervisor.exe", "package.json", "dist/src/desktop/deployment-plan-private.js",
        "dist/src/desktop/deployment-binding.js", "dist/src/desktop/deployment-artifact.js", "dist/src/desktop/runtime.js",
        "scripts/run-windows-supervisor.ps1", "scripts/watch-windows-bridge.ps1"
    };

    private static int VersionedMain(string[] args)
    {
        try
        {
            Require(args.Length == 6 && args[0] == "--launch-binding" && args[2] == "--launch-binding-sha256" && args[4] == "--operation");
            string bindingPath = Absolute(args[1]), bindingPin = Pin(args[3]), operation = args[5];
            Require(operation == "plan-only" || operation == "run-once" || operation == "supervise" || operation == "supervise-once");
            using (var trust = new Trust(bindingPath, bindingPin))
            {
                var plan = trust.ValidatePlan();
                if (operation == "plan-only") { Console.OutputEncoding = new UTF8Encoding(false); Console.WriteLine(plan.Json); return 0; }
                if (operation == "supervise" || operation == "supervise-once")
                {
                    SetCurrentProcessExplicitAppUserModelID("RedRatInHat.VKodex.Bridge");
                    Console.Title = "VKodex Bridge - DO NOT CLOSE";
                }
                // Keep immutable bootstrap code/runtime open without write/delete
                // sharing for the full child lifetime. Release mutable metadata:
                // a later helper must refuse changes against the ORIGINAL pin.
                trust.ReleaseMetadata();
                if (operation == "run-once")
                {
                    var info = ChildInfo(trust.Runtime, trust.Configuration);
                    info.Arguments = Arguments(new string[] { "--env-file=" + trust.EnvironmentFile, trust.EntryPoint });
                    info.EnvironmentVariables["BOT_DATA_DIR"] = trust.DataDirectory;
                    info.EnvironmentVariables["VKODEX_RUN_ID"] = DateTime.Now.ToString("yyyyMMdd-HHmmssfff", CultureInfo.InvariantCulture)
                        + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
                    using (var child = Process.Start(info)) { Require(child != null); child.WaitForExit(); return child.ExitCode; }
                }
                string powershell = SystemPowerShell();
                var supervisor = ChildInfo(powershell, trust.Configuration);
                var command = new List<string> { "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                    trust.Supervisor, "-LaunchBinding", bindingPath, "-LaunchBindingSha256", bindingPin, "-LauncherPath", trust.Launcher, "-LauncherSha256", trust.LauncherSha256 };
                if (operation == "supervise-once") command.Add("-Once");
                supervisor.Arguments = Arguments(command.ToArray());
                using (var child = Process.Start(supervisor))
                {
                    Require(child != null); Process watchdog = null;
                    try
                    {
                        if (operation == "supervise")
                        {
                            // Optional diagnostics, never an ownership authority
                            // or a reason to kill a backend. All argv use the same
                            // native encoder; pinned script handles remain held.
                            var watcher = ChildInfo(powershell, trust.Configuration);
                            watcher.Arguments = Arguments(new string[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", trust.Watchdog,
                                "-SupervisorPid", child.Id.ToString(CultureInfo.InvariantCulture), "-HealthFile", Join(trust.DataDirectory, "health.json"),
                                "-EntryPoint", trust.EntryPoint, "-LogFile", Join(trust.DataDirectory, "logs/watchdog.log"),
                                "-VersionedLauncherPath", trust.Launcher, "-BridgeExecutable", trust.Runtime });
                            try { watchdog = Process.Start(watcher); } catch { Console.Error.WriteLine("VKodex diagnostic watchdog could not start."); }
                        }
                        child.WaitForExit();
                        if (watchdog != null && !watchdog.WaitForExit(30000))
                            Console.Error.WriteLine("VKodex diagnostic watchdog did not finish promptly.");
                        return child.ExitCode;
                    }
                    finally { if (watchdog != null) watchdog.Dispose(); }
                }
            }
        }
        catch { Console.Error.WriteLine("VKodex versioned launch validation refused."); return ValidationRefused; }
    }

    private static void Require(bool condition) { if (!condition) throw new InvalidOperationException(); }
    private static string Pin(object value) { string text = value as string; Require(text != null && Regex.IsMatch(text, "^[a-f0-9]{64}$")); return text; }
    private static string Text(object value) { string text = value as string; Require(text != null); return text; }
    private static long Integer(object value) { Require(value is long); return (long)value; }
    private static Dictionary<string, object> Object(object value, params string[] keys)
    {
        var result = value as Dictionary<string, object>; Require(result != null && result.Count == keys.Length);
        foreach (string key in keys) Require(result.ContainsKey(key));
        return result;
    }
    private static bool EqualPath(string first, string second) { return string.Equals(first, second, StringComparison.OrdinalIgnoreCase); }
    private static bool Within(string root, string file) { return EqualPath(root, file) || file.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase); }
    private static string Absolute(object value)
    {
        string text = Text(value);
        Require(text.Length <= 1024 && Regex.IsMatch(text, "^[a-zA-Z]:[\\\\/]") && !Regex.IsMatch(text, "[\\x00-\\x1f\\x7f\"']"));
        Require(text.Substring(2).IndexOf(':') < 0);
        text = text.Replace('/', '\\');
        foreach (string part in text.Substring(3).Split('\\'))
            Require(part.Length > 0 && part != "." && part != ".." && !part.EndsWith(".") && !part.EndsWith(" ") &&
                !Regex.IsMatch(part, "[<>|?*]") && !Regex.IsMatch(part, "^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\.|$)", RegexOptions.IgnoreCase));
        string full = Path.GetFullPath(text); Require(full.Length > 3 && EqualPath(full, text)); return full;
    }
    private static string Hash(byte[] bytes) { using (var sha = SHA256.Create()) return Hex(sha.ComputeHash(bytes)); }
    private static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
    private static string Join(string root, string relative) { return Path.Combine(root, relative.Replace('/', '\\')); }

    // One Windows CRT argv encoder, including spaces, Unicode, quotes and trailing
    // backslashes. No PowerShell expressions or Start-Process concatenation.
    private static string Arguments(string[] values)
    {
        var result = new StringBuilder();
        foreach (string value in values)
        {
            if (result.Length != 0) result.Append(' ');
            result.Append('"'); int slashes = 0;
            foreach (char ch in value)
            {
                if (ch == '\\') { slashes++; continue; }
                result.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes); slashes = 0; result.Append(ch);
            }
            result.Append('\\', slashes * 2); result.Append('"');
        }
        return result.ToString();
    }
    private static ProcessStartInfo ChildInfo(string executable, string cwd)
    {
        var info = new ProcessStartInfo { FileName = executable, WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true };
        // CLR hooks load before Main; the initial parent must apply these too.
        foreach (string key in new string[] { "NODE_OPTIONS", "NODE_PATH", "COR_PROFILER", "COR_PROFILER_PATH", "COR_PROFILER_PATH_32", "COR_PROFILER_PATH_64", "APPDOMAIN_MANAGER_ASM", "APPDOMAIN_MANAGER_TYPE" })
            info.EnvironmentVariables[key] = "";
        info.EnvironmentVariables["COR_ENABLE_PROFILING"] = "0";
        return info;
    }
    private static string SystemPowerShell()
    {
        string result = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        Canonical(result, false, false); return result;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder name, uint capacity, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
    private static FileInformation Inspect(SafeFileHandle handle, string expected, bool directory)
    {
        Require(handle != null && !handle.IsInvalid);
        FileInformation info; Require(GetFileInformationByHandle(handle, out info));
        Require((info.Attributes & 0x400) == 0 && ((info.Attributes & 0x10) != 0) == directory);
        var final = new StringBuilder(32768); uint length = GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0);
        Require(length > 0 && length < final.Capacity);
        string resolved = final.ToString(); if (resolved.StartsWith("\\\\?\\")) resolved = resolved.Substring(4);
        Require(EqualPath(resolved.TrimEnd('\\'), expected.TrimEnd('\\')));
        return info;
    }
    private static SafeFileHandle Open(string file, bool directory, bool protect)
    {
        // OPEN_REPARSE_POINT plus handle identity prevents following a linked leaf.
        var handle = CreateFile(file, directory ? 0x80000000u : 0x80000000u, protect ? 1u : 7u,
            IntPtr.Zero, 3, 0x00200000u | (directory ? 0x02000000u : 0u), IntPtr.Zero);
        try { Inspect(handle, file, directory); return handle; } catch { handle.Dispose(); throw; }
    }
    private static void Canonical(string file, bool directory, bool future)
    {
        string normalized = Absolute(file), current = normalized.Substring(0, 3);
        string[] parts = normalized.Substring(3).Split('\\');
        for (int index = 0; index < parts.Length; index++)
        {
            current = Path.Combine(current, parts[index]);
            if (future && !File.Exists(current) && !Directory.Exists(current)) return;
            using (var handle = Open(current, index < parts.Length - 1 || directory, false)) { }
        }
    }
    private sealed class PinnedFile : IDisposable
    {
        public readonly string Name; private readonly FileStream stream; private readonly string pin; private readonly long maximum;
        private readonly FileInformation initial;
        public PinnedFile(string name, string expected, long limit)
        {
            Name = Absolute(name); pin = Pin(expected); maximum = limit; Canonical(Name, false, false);
            var handle = Open(Name, false, true);
            try { initial = Inspect(handle, Name, false); Require(initial.Links == 1); stream = new FileStream(handle, FileAccess.Read); Check(); }
            catch { if (stream != null) stream.Dispose(); else handle.Dispose(); throw; }
        }
        public void Check()
        {
            Require(stream.Length <= maximum);
            var current = Inspect(stream.SafeFileHandle, Name, false);
            Require(current.Links == 1);
            Require(current.Volume == initial.Volume && current.IndexHigh == initial.IndexHigh && current.IndexLow == initial.IndexLow &&
                current.SizeHigh == initial.SizeHigh && current.SizeLow == initial.SizeLow && current.Write.dwHighDateTime == initial.Write.dwHighDateTime && current.Write.dwLowDateTime == initial.Write.dwLowDateTime);
            stream.Position = 0; long count = 0; var buffer = new byte[65536];
            using (var sha = SHA256.Create())
            {
                int size; while ((size = stream.Read(buffer, 0, buffer.Length)) != 0) { count += size; Require(count <= maximum); sha.TransformBlock(buffer, 0, size, buffer, 0); }
                sha.TransformFinalBlock(new byte[0], 0, 0); Require(Hex(sha.Hash) == pin && count == stream.Length);
            }
        }
        public object Json()
        {
            Require(stream.Length <= 128 * 1024); stream.Position = 0;
            byte[] bytes = new byte[(int)stream.Length]; int offset = 0, count;
            while (offset < bytes.Length && (count = stream.Read(bytes, offset, bytes.Length - offset)) > 0) offset += count;
            Require(offset == bytes.Length && Hash(bytes) == pin);
            return new JsonReader(new UTF8Encoding(false, true).GetString(bytes)).Read();
        }
        public void Dispose() { stream.Dispose(); }
    }

    private sealed class Plan { public string Json; }
    private sealed class Trust : IDisposable
    {
        private readonly List<PinnedFile> code = new List<PinnedFile>(), metadata = new List<PinnedFile>();
        private readonly List<SafeFileHandle> directories = new List<SafeFileHandle>();
        private readonly string bindingPath, bindingPin, descriptorPin, bootstrapPin, runtimePin, bootstrap, artifact, manifestPin, launcherPin;
        public readonly string Runtime, Configuration, DataDirectory, EnvironmentFile, EntryPoint, Launcher, Supervisor, Watchdog;
        public string LauncherSha256 { get { return launcherPin; } }
        public Trust(string file, string pin)
        {
            bindingPath = file; bindingPin = pin;
            try
            {
                var binding = Object(Metadata(file, pin, 32768).Json(), "version", "descriptorPath", "descriptorSha256", "bootstrapRoot", "bootstrapManifestSha256", "stableRuntimePath", "stableRuntimeSha256");
                Require(Integer(binding["version"]) == 1);
                string descriptorPath = Absolute(binding["descriptorPath"]); descriptorPin = Pin(binding["descriptorSha256"]);
                bootstrap = Absolute(binding["bootstrapRoot"]); bootstrapPin = Pin(binding["bootstrapManifestSha256"]);
                Runtime = Absolute(binding["stableRuntimePath"]); runtimePin = Pin(binding["stableRuntimeSha256"]);
                foreach (string other in new string[] { bindingPath, descriptorPath, Runtime }) Require(!Within(bootstrap, other) && !Within(other, bootstrap));
                Canonical(bootstrap, true, false); directories.Add(Open(bootstrap, true, true));
                var manifest = Object(Code(Join(bootstrap, "bootstrap-manifest.json"), bootstrapPin, 131072).Json(), "version", "protocol", "files");
                Require(Integer(manifest["version"]) == 1 && Text(manifest["protocol"]) == "deployment-plan-v1");
                var files = Object(manifest["files"], BundleFiles);
                foreach (string relative in BundleFiles)
                {
                    var entry = Object(files[relative], "size", "sha256"); long size = Integer(entry["size"]); Require(size >= 0 && size <= 67108864);
                    var actual = Code(Join(bootstrap, relative), Pin(entry["sha256"]), size); Require(new FileInfo(actual.Name).Length == size);
                }
                launcherPin = Pin(Object(files["launcher/VKodexSupervisor.exe"], "size", "sha256")["sha256"]);
                ClosedInventory(bootstrap);
                var package = Object(code[2].Json(), "type"); // manifest, launcher, package: fixed declared order
                Require(Text(package["type"]) == "module");
                Launcher = Join(bootstrap, BundleFiles[0]); Supervisor = Join(bootstrap, "scripts/run-windows-supervisor.ps1"); Watchdog = Join(bootstrap, "scripts/watch-windows-bridge.ps1");
                Require(EqualPath(Absolute(Process.GetCurrentProcess().MainModule.FileName), Launcher));
                Code(Runtime, runtimePin, 2147483648L);
                var descriptor = Object(Metadata(descriptorPath, descriptorPin, 32768).Json(), "version", "artifactRoot", "configurationRoot", "dataDirectory", "manifestSha256");
                Require(Integer(descriptor["version"]) == 1);
                artifact = Absolute(descriptor["artifactRoot"]); Configuration = Absolute(descriptor["configurationRoot"]); DataDirectory = Absolute(descriptor["dataDirectory"]); manifestPin = Pin(descriptor["manifestSha256"]);
                foreach (string other in new string[] { artifact, Configuration, DataDirectory })
                    Require(!Within(bootstrap, other) && !Within(other, bootstrap) && !Within(other, Runtime));
                foreach (string other in new string[] { Configuration, DataDirectory, descriptorPath }) Require(!Within(artifact, other) && !Within(other, artifact));
                foreach (string other in new string[] { bindingPath, descriptorPath }) Require(!Within(artifact, other) && !Within(DataDirectory, other));
                Canonical(artifact, true, false); Canonical(Configuration, true, false); Canonical(DataDirectory, true, true);
                EnvironmentFile = Join(Configuration, ".env"); Canonical(EnvironmentFile, false, false); EntryPoint = Join(artifact, "dist/src/desktop-main.js");
            }
            catch { Dispose(); throw; }
        }
        private PinnedFile Code(string file, string pin, long limit) { var result = new PinnedFile(file, pin, limit); code.Add(result); return result; }
        private PinnedFile Metadata(string file, string pin, long limit) { var result = new PinnedFile(file, pin, limit); metadata.Add(result); return result; }
        private void ClosedInventory(string root)
        {
            var allowed = new HashSet<string>(BundleFiles, StringComparer.Ordinal); allowed.Add("bootstrap-manifest.json"); int count = 0;
            Walk(root, root, allowed, ref count); Require(count == allowed.Count);
        }
        private void Walk(string root, string directory, HashSet<string> allowed, ref int count)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string entry in Directory.GetFileSystemEntries(directory))
            {
                Require(names.Add(Path.GetFileName(entry)));
                string relative = entry.Substring(root.Length + 1).Replace('\\', '/'); bool isDirectory = Directory.Exists(entry);
                Canonical(entry, isDirectory, false);
                if (isDirectory)
                {
                    bool prefix = false; foreach (string allowedFile in allowed) if (allowedFile.StartsWith(relative + "/", StringComparison.Ordinal)) prefix = true;
                    Require(prefix); directories.Add(Open(entry, true, true)); Walk(root, entry, allowed, ref count);
                }
                else { Require(allowed.Contains(relative)); count++; Require(count <= 9); }
            }
        }
        public Plan ValidatePlan()
        {
            string cli = Join(bootstrap, "dist/src/desktop/deployment-plan-private.js");
            var info = ChildInfo(Runtime, bootstrap); info.Arguments = Arguments(new string[] { cli, "--launch-binding", bindingPath, "--launch-binding-sha256", bindingPin });
            info.RedirectStandardOutput = true; info.RedirectStandardError = true;
            info.StandardOutputEncoding = new UTF8Encoding(false, true); info.StandardErrorEncoding = new UTF8Encoding(false, true);
            string output = Capture(info);
            var plan = Object(new JsonReader(output).Read(), "executable", "entryPoint", "cwd", "environmentFile", "dataDirectory", "nativeCodexPath", "arguments", "environmentOverrides",
                "descriptorSha256", "manifestSha256", "sourceCommit", "sourceTree", "runtimeSha256", "version", "status", "protocol", "bindingPath", "bindingSha256", "bootstrapManifestSha256", "launcherPath", "launcherSha256", "supervisorPath", "watchdogPath");
            Require(Integer(plan["version"]) == 1 && Text(plan["status"]) == "validated_not_launched" && Text(plan["protocol"]) == "deployment-plan-v1");
            var expectedPaths = new Dictionary<string, string> { { "executable", Runtime }, { "entryPoint", EntryPoint }, { "cwd", Configuration }, { "environmentFile", EnvironmentFile },
                { "dataDirectory", DataDirectory }, { "bindingPath", bindingPath }, { "launcherPath", Launcher }, { "supervisorPath", Supervisor }, { "watchdogPath", Watchdog } };
            foreach (var expected in expectedPaths) Require(EqualPath(Absolute(plan[expected.Key]), expected.Value));
            string native = Absolute(plan["nativeCodexPath"]); Require(Within(artifact, native) && native.StartsWith(Join(artifact, "node_modules") + "\\", StringComparison.OrdinalIgnoreCase));
            Require(Pin(plan["bindingSha256"]) == bindingPin && Pin(plan["descriptorSha256"]) == descriptorPin && Pin(plan["manifestSha256"]) == manifestPin &&
                Pin(plan["runtimeSha256"]) == runtimePin && Pin(plan["bootstrapManifestSha256"]) == bootstrapPin && Pin(plan["launcherSha256"]) == launcherPin);
            foreach (string revision in new string[] { "sourceCommit", "sourceTree" }) Require(Regex.IsMatch(Text(plan[revision]), "^[a-f0-9]{40}$"));
            var argv = plan["arguments"] as List<object>; Require(argv != null && argv.Count == 2 && Text(argv[0]) == "--env-file=" + EnvironmentFile && EqualPath(Text(argv[1]), EntryPoint));
            var environment = Object(plan["environmentOverrides"], "BOT_DATA_DIR", "NODE_OPTIONS", "NODE_PATH");
            Require(EqualPath(Absolute(environment["BOT_DATA_DIR"]), DataDirectory) && Text(environment["NODE_OPTIONS"]) == "" && Text(environment["NODE_PATH"]) == "");
            foreach (var pinned in code) pinned.Check(); foreach (var pinned in metadata) pinned.Check();
            // Re-enumeration also rejects extra .config/modules. The bootstrap is
            // staged/protected by the caller, not an arbitrary mutable checkout.
            ClosedInventory(bootstrap);
            Canonical(Configuration, true, false); Canonical(EnvironmentFile, false, false); Canonical(DataDirectory, true, true);
            return new Plan { Json = output.Trim() };
        }
        public void ReleaseMetadata() { foreach (var pinned in metadata) pinned.Dispose(); metadata.Clear(); }
        public void Dispose() { ReleaseMetadata(); foreach (var pinned in code) pinned.Dispose(); code.Clear(); foreach (var handle in directories) handle.Dispose(); directories.Clear(); }
    }

    private static string Capture(ProcessStartInfo info)
    {
        using (var process = Process.Start(info))
        {
            Require(process != null); string output = null, error = null; Exception outputError = null, errorError = null;
            var stdout = new Thread(delegate() { try { output = Limited(process.StandardOutput, 16384); } catch (Exception e) { outputError = e; } });
            var stderr = new Thread(delegate() { try { error = Limited(process.StandardError, 16384); } catch (Exception e) { errorError = e; } });
            stdout.IsBackground = true; stderr.IsBackground = true; stdout.Start(); stderr.Start();
            bool ended = process.WaitForExit(30000);
            if (!ended || !stdout.Join(2000) || !stderr.Join(2000))
            {
                // This child is only the owned read-only Node validator, never
                // the bridge/shared backend; no descendant or foreign PID kill.
                if (!process.HasExited) process.Kill();
                process.WaitForExit(2000); throw new InvalidOperationException();
            }
            Require(outputError == null && errorError == null && process.ExitCode == 0 && string.IsNullOrWhiteSpace(error));
            Require(output != null && Encoding.UTF8.GetByteCount(output) <= 16384);
            string record = output.TrimEnd('\r', '\n'); Require(record.Length != 0 && record.IndexOf('\r') < 0 && record.IndexOf('\n') < 0 && output.Length - record.Length <= 2);
            return record;
        }
    }
    private static string Limited(StreamReader reader, int maximum)
    {
        // Decode bytes ourselves. StreamReader's automatic BOM detection must
        // not silently accept UTF-16 or replace malformed UTF-8 protocol bytes.
        using (var result = new MemoryStream())
        {
            var buffer = new byte[1024]; int size;
            while ((size = reader.BaseStream.Read(buffer, 0, buffer.Length)) != 0) { Require(result.Length + size <= maximum); result.Write(buffer, 0, size); }
            return new UTF8Encoding(false, true).GetString(result.ToArray());
        }
    }

    // Dependency-free, bounded, duplicate-aware JSON. Metadata is never code.
    // Decoded property equality rejects {"version":1,"\u0076ersion":1} too.
    private sealed class JsonReader
    {
        private readonly string text; private int index, depth, values;
        public JsonReader(string value) { text = value; Require(text != null && text.Length <= 131072); }
        public object Read() { object value = Value(); Space(); Require(index == text.Length); return value; }
        private void Space() { while (index < text.Length && (text[index] == ' ' || text[index] == '\r' || text[index] == '\n' || text[index] == '\t')) index++; }
        private char Next() { Require(index < text.Length); return text[index++]; }
        private object Value()
        {
            Space(); Require(++values <= 4096 && ++depth <= 64); char ch = Next(); object value;
            if (ch == '{')
            {
                var fields = new Dictionary<string, object>(StringComparer.Ordinal); Space();
                if (index < text.Length && text[index] == '}') { index++; value = fields; }
                else
                {
                    while (true)
                    {
                        Space(); Require(Next() == '"'); string key = String(); Require(!fields.ContainsKey(key)); Space(); Require(Next() == ':'); fields.Add(key, Value()); Space(); ch = Next(); if (ch == '}') break; Require(ch == ',');
                    }
                    value = fields;
                }
            }
            else if (ch == '[')
            {
                var entries = new List<object>(); Space();
                if (index < text.Length && text[index] == ']') index++;
                else { while (true) { entries.Add(Value()); Space(); ch = Next(); if (ch == ']') break; Require(ch == ','); } }
                value = entries;
            }
            else if (ch == '"') value = String();
            else if (ch == 't' || ch == 'f' || ch == 'n')
            {
                string suffix = ch == 't' ? "rue" : ch == 'f' ? "alse" : "ull";
                Require(index + suffix.Length <= text.Length && text.Substring(index, suffix.Length) == suffix); index += suffix.Length; value = ch == 'n' ? null : (object)(ch == 't');
            }
            else
            {
                int start = index - 1;
                if (ch == '-') ch = Next(); Require(ch >= '0' && ch <= '9');
                if (ch == '0') Require(index >= text.Length || text[index] < '0' || text[index] > '9');
                while (index < text.Length && text[index] >= '0' && text[index] <= '9') index++;
                long number; Require(long.TryParse(text.Substring(start, index - start), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out number)); value = number;
            }
            depth--; return value;
        }
        private string String()
        {
            var result = new StringBuilder();
            while (true)
            {
                char ch = Next(); if (ch == '"') break; Require(ch >= 32);
                if (ch == '\\')
                {
                    ch = Next();
                    switch (ch)
                    {
                        case '"': case '\\': case '/': break;
                        case 'b': ch = '\b'; break; case 'f': ch = '\f'; break; case 'n': ch = '\n'; break; case 'r': ch = '\r'; break; case 't': ch = '\t'; break;
                        case 'u':
                            Require(index + 4 <= text.Length && Regex.IsMatch(text.Substring(index, 4), "^[0-9a-fA-F]{4}$"));
                            ch = (char)int.Parse(text.Substring(index, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture); index += 4; break;
                        default: throw new InvalidOperationException();
                    }
                }
                result.Append(ch); Require(result.Length <= 32768);
            }
            string decoded = result.ToString();
            for (int cursor = 0; cursor < decoded.Length; cursor++) if (char.IsSurrogate(decoded[cursor])) { Require(char.IsHighSurrogate(decoded[cursor]) && cursor + 1 < decoded.Length && char.IsLowSurrogate(decoded[cursor + 1])); cursor++; }
            return decoded;
        }
    }
}
