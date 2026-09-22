// RemoteSupportAgent — Native Windows Customer/Guest Agent
//
// This is the program that runs on the CUSTOMER'S (guest's) Windows PC when
// they download and run supportdesk.ClientSetup.exe. Its job is the mirror
// image of the technician's Host Viewer (native-host/Program.cs):
//
//   1. Capture the guest's real desktop (GDI BitBlt, full resolution, no
//      artificial downscale) and stream it to the relay server as
//      `screen.frame` messages using `role=customer`.
//   2. Receive `input` messages from the technician (relayed by the server)
//      and actually apply them to this machine using Win32 `SendInput` for
//      keyboard/mouse — this is the part that was completely missing before
//      (there was no real input-injection code anywhere in the repo).
//
// Previously all three native projects (Agent/Host/Service) compiled the
// same Program.cs, which only implemented the Host Viewer half (receive
// frames, send input) — there was no real capture or injection agent at
// all. This file is the real, from-scratch guest-side implementation.

using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Net.Http;
using System.Net.Security;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Authentication;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using RemoteSupportAgent;

const string DefaultServerUrl = "https://www.helpsupport.top";
const string AgentBuildLabel = "1.0.0-real-capture-input-agent";
AgentLog.Write($"Remote Support Agent starting. Build: {AgentBuildLabel}");

// Per-monitor DPI awareness so GetSystemMetrics(SM_CXVIRTUALSCREEN/...) and
// GDI CopyFromScreen report true physical pixel dimensions instead of a
// DPI-scaled (and therefore blurry/mis-scaled) virtual size. This matters
// for both capture sharpness and for mapping the technician's normalized
// pointer coordinates back to the correct physical pixel on multi-monitor,
// mixed-DPI setups.
try { NativeMethods.SetProcessDpiAwareness(2 /* PER_MONITOR_DPI_AWARE */); } catch { }

ApplicationConfiguration.Initialize();

var options = AgentOptions.Parse(args).WithFilenameLaunchData();
if (!string.IsNullOrWhiteSpace(options.LaunchId))
{
    try
    {
        var launchServerUrl = string.IsNullOrWhiteSpace(options.ServerUrl) ? DefaultServerUrl : options.ServerUrl;
        var resolution = await ResolveAgentLaunchAsync(launchServerUrl, options.LaunchId, options);
        options = options with
        {
            ServerUrl = launchServerUrl,
            SessionId = resolution.SessionId,
            Token = resolution.CustomerJoinToken
        };
    }
    catch (Exception ex)
    {
        AgentLog.Write($"Agent launch resolution failed: {ex}");
    }
}

if (string.IsNullOrWhiteSpace(options.ServerUrl)) options = options with { ServerUrl = DefaultServerUrl };

if (string.IsNullOrWhiteSpace(options.ServerUrl) || string.IsNullOrWhiteSpace(options.SessionId) || string.IsNullOrWhiteSpace(options.Token))
{
    AgentLog.Write("Missing session launch details.");
    MessageBox.Show(
        "This support agent could not find session connection details.\n\nPlease reopen the setup link the technician provided.",
        "Remote Support Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
    return;
}

Application.Run(new AgentTrayContext(options));

// ─────────────────────────────────────────────────────────────────────────
// Launch resolution — mirrors native-host's flow but hits the *customer*
// launch endpoint (/api/agent-launch/{id}) and uses the customer token.
// ─────────────────────────────────────────────────────────────────────────
static async Task<AgentLaunchDetails> ResolveAgentLaunchAsync(string serverUrl, string launchId, AgentOptions options)
{
    using var handler = new HttpClientHandler { SslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13 };
    if (options.InsecureSkipTlsVerify || IsTrustedSupportHost(new Uri(serverUrl).Host))
    {
        handler.ServerCertificateCustomValidationCallback = (_, _, _, _) => true;
    }
    using var http = new HttpClient(handler) { BaseAddress = new Uri(serverUrl.TrimEnd('/')) };
    using var response = await http.GetAsync($"/api/agent-launch/{Uri.EscapeDataString(launchId)}");
    var body = await response.Content.ReadAsStringAsync();
    if (!response.IsSuccessStatusCode) throw new HttpRequestException($"Server returned {(int)response.StatusCode}: {body}");
    return JsonSerializer.Deserialize<AgentLaunchDetails>(body, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
}

static bool IsTrustedSupportHost(string host)
{
    return host.EndsWith(".trycloudflare.com", StringComparison.OrdinalIgnoreCase) ||
        host.Equals("helpsupport.top", StringComparison.OrdinalIgnoreCase) ||
        host.Equals("www.helpsupport.top", StringComparison.OrdinalIgnoreCase);
}

sealed record AgentLaunchDetails(bool Ok, string SessionId, string CustomerJoinToken);

sealed record AgentOptions(string? ServerUrl, string? SessionId, string? Token, string? LaunchId = null, bool InsecureSkipTlsVerify = false)
{
    static readonly string[] AgentMarkers = ["supportdesk.ClientSetup.", "ScreenConnect.ClientSetup."];

    public static AgentOptions Parse(string[] args)
    {
        string? serverUrl = null, sessionId = null, token = null, launchId = null;
        var insecure = false;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--session" && i + 1 < args.Length) sessionId = args[++i];
            else if (args[i] == "--token" && i + 1 < args.Length) token = args[++i];
            else if (args[i] == "--launch-id" && i + 1 < args.Length) launchId = args[++i];
            else if (args[i] == "--insecure-skip-tls-verify") insecure = true;
            else if (!args[i].StartsWith("--", StringComparison.Ordinal) && serverUrl is null) serverUrl = args[i];
        }
        return new AgentOptions(serverUrl, sessionId, token, launchId, insecure);
    }

    public AgentOptions WithFilenameLaunchData()
    {
        if (!string.IsNullOrWhiteSpace(ServerUrl) && !string.IsNullOrWhiteSpace(SessionId) && !string.IsNullOrWhiteSpace(Token)) return this;
        var path = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(path)) return this;
        var name = Path.GetFileNameWithoutExtension(path);
        var marker = AgentMarkers.FirstOrDefault(m => name.IndexOf(m, StringComparison.OrdinalIgnoreCase) >= 0);
        if (marker is null) return this;
        var markerIndex = name.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (markerIndex < 0) return this;
        try
        {
            var encoded = ReadBase64UrlPrefix(name[(markerIndex + marker.Length)..]);
            if (string.IsNullOrWhiteSpace(encoded)) return this;
            var allowTlsFallback = encoded.StartsWith("launchk-", StringComparison.OrdinalIgnoreCase);
            if (allowTlsFallback || encoded.StartsWith("launch-", StringComparison.OrdinalIgnoreCase))
            {
                var lid = encoded[(allowTlsFallback ? "launchk-" : "launch-").Length..];
                if (string.IsNullOrWhiteSpace(lid)) return this;
                return this with { LaunchId = LaunchId ?? lid, InsecureSkipTlsVerify = InsecureSkipTlsVerify || allowTlsFallback };
            }
            var json = Encoding.UTF8.GetString(Base64UrlDecode(encoded));
            var data = JsonSerializer.Deserialize<AgentLaunchData>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            return this with
            {
                ServerUrl = ServerUrl ?? data?.U,
                SessionId = SessionId ?? data?.S,
                Token = Token ?? data?.T,
                LaunchId = LaunchId ?? data?.L,
                InsecureSkipTlsVerify = InsecureSkipTlsVerify || data?.K == true
            };
        }
        catch { return this; }
    }

    static byte[] Base64UrlDecode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + ((4 - padded.Length % 4) % 4), '=');
        return Convert.FromBase64String(padded);
    }

    static string ReadBase64UrlPrefix(string value)
    {
        var length = 0;
        while (length < value.Length)
        {
            var ch = value[length];
            if (char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_') length++;
            else break;
        }
        return value[..length];
    }
}

sealed record AgentLaunchData(string? U, string? S, string? T, string? L, bool? K);

static class AgentLog
{
    static readonly string Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "RemoteSupportAgent.log");
    public static void Write(string message)
    {
        try { File.AppendAllText(Path, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {message}{Environment.NewLine}"); }
        catch { }
    }
}
