using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Web.Script.Serialization;
using System.Threading.Tasks;

// A console executable is required by VS Code's cliExecutable setting on Windows.
// Native stdio is forwarded byte-for-byte; Node owns framing and the private channel.
internal static class VKodexOwnerLauncher
{
    private static void Copy(Stream source, Stream destination, bool closeDestination)
    {
        try
        {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = source.Read(buffer, 0, buffer.Length)) > 0)
            {
                destination.Write(buffer, 0, count);
                destination.Flush();
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        finally { if (closeDestination) destination.Dispose(); }
    }
    private static string Quote(string value)
    {
        var output = new System.Text.StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { output.Append('\\', slashes * 2 + 1); output.Append(c); }
            else { output.Append('\\', slashes); output.Append(c); }
            slashes = 0;
        }
        output.Append('\\', slashes * 2); output.Append('"');
        return output.ToString();
    }

    private static int Main(string[] args)
    {
        try
        {
            string configFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "owner-launcher.json");
            var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(configFile));
            string runtime = (string)config["runtimeExecutable"];
            string entry = (string)config["adapterEntry"];
            if (!Path.IsPathRooted(runtime) || !Path.IsPathRooted(entry) || !File.Exists(runtime) || !File.Exists(entry)) return 2;
            var arguments = new List<string> { Quote(entry), Quote(configFile) };
            foreach (string arg in args) arguments.Add(Quote(arg));
            var info = new ProcessStartInfo(runtime, string.Join(" ", arguments.ToArray()))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var child = Process.Start(info))
            {
                if (child == null) return 2;
                Task.Factory.StartNew(() => Copy(Console.OpenStandardInput(), child.StandardInput.BaseStream, true));
                var output = Task.Factory.StartNew(() => Copy(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false));
                var error = Task.Factory.StartNew(() => Copy(child.StandardError.BaseStream, Console.OpenStandardError(), false));
                child.WaitForExit();
                Task.WaitAll(output, error);
                return child.ExitCode;
            }
        }
        catch
        {
            Console.Error.WriteLine("VKodex owner launcher could not start; check its local configuration.");
            return 2;
        }
    }
}
