// RemoteSupportService — minimal unattended-access launcher/watchdog.
//
// Historically this project compiled the *same* Program.cs as the
// technician Host Viewer (a WinForms app), which would not even build here
// since this project has no <UseWindowsForms> flag — it was dead/aspirational
// scaffolding. Now that native-agent/native-host/native-service each live in
// their own directory with their own source, this project needs its own
// entry point.
//
// This is a small, real implementation of what AGENTS.md describes this
// project for: "a .NET 8 unattended service that registers the endpoint and
// launches the desktop helper." It launches RemoteSupportAgent.exe with the
// given connection arguments and keeps it running (restarting it if it
// exits unexpectedly), which is the behavior needed for unattended-access
// scenarios where a session should stay available even if the interactive
// agent process is closed or crashes.
//
// This file is intentionally minimal — a full Windows Service host (SCM
// integration via System.ServiceProcess/Microsoft.Extensions.Hosting) is a
// larger undertaking than this fix's scope; this provides a working
// watchdog process that can itself be installed as a service using
// standard tools (e.g. `sc.exe create` or NSSM) pointing at this exe.

using System.Diagnostics;

var options = ServiceOptions.Parse(args);
if (options is null)
{
    Console.WriteLine("Usage: RemoteSupportService.exe <server_url> --helper <path-to-RemoteSupportAgent.exe> [--session <id> --token <token>]");
    return 1;
}

Console.WriteLine($"RemoteSupportService starting. Helper: {options.HelperPath}");

var restartDelay = TimeSpan.FromSeconds(5);
while (true)
{
    try
    {
        var psi = new ProcessStartInfo
        {
            FileName = options.HelperPath,
            UseShellExecute = false
        };
        psi.ArgumentList.Add(options.ServerUrl);
        if (!string.IsNullOrWhiteSpace(options.SessionId)) { psi.ArgumentList.Add("--session"); psi.ArgumentList.Add(options.SessionId); }
        if (!string.IsNullOrWhiteSpace(options.Token)) { psi.ArgumentList.Add("--token"); psi.ArgumentList.Add(options.Token); }

        using var process = Process.Start(psi);
        if (process is null)
        {
            Console.WriteLine("Failed to start helper process.");
        }
        else
        {
            Console.WriteLine($"Helper started (PID {process.Id}). Watching for exit...");
            await process.WaitForExitAsync();
            Console.WriteLine($"Helper exited with code {process.ExitCode}. Restarting in {restartDelay.TotalSeconds}s...");
        }
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Error launching helper: {ex.Message}");
    }

    await Task.Delay(restartDelay);
}

sealed record ServiceOptions(string ServerUrl, string HelperPath, string? SessionId, string? Token)
{
    public static ServiceOptions? Parse(string[] args)
    {
        string? serverUrl = null, helperPath = null, sessionId = null, token = null;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--helper" && i + 1 < args.Length) helperPath = args[++i];
            else if (args[i] == "--session" && i + 1 < args.Length) sessionId = args[++i];
            else if (args[i] == "--token" && i + 1 < args.Length) token = args[++i];
            else if (!args[i].StartsWith("--", StringComparison.Ordinal) && serverUrl is null) serverUrl = args[i];
        }
        if (string.IsNullOrWhiteSpace(serverUrl) || string.IsNullOrWhiteSpace(helperPath)) return null;
        return new ServiceOptions(serverUrl, helperPath, sessionId, token);
    }
}
