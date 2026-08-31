using System;
using System.Diagnostics;
using System.IO;

internal static class Program
{
    private static int Main(string[] args)
    {
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
}
