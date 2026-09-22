// The guest-side agent runs as a lightweight system-tray application (no
// visible window is required for remote control to function — this mirrors
// how ConnectWise Control's guest client behaves once a session is
// attached). It:
//   1. Connects to the relay server as role=customer, client=windows-native-agent
//   2. Streams real desktop frames (ScreenCapture) at an adaptive quality
//      tier, matching the browser SCCapture's tier-upgrade/downgrade logic
//      so it never gets stuck at a low-quality tier once bandwidth allows
//      better.
//   3. Applies every `input` message it receives from the technician via
//      InputInjector.SendKey / MoveTo / Button / Wheel — this is the
//      previously-missing piece that made "most keys not working" and
//      mouse/keyboard control silently do nothing.

using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace RemoteSupportAgent;

sealed class AgentTrayContext : ApplicationContext
{
    readonly AgentOptions options;
    readonly NotifyIcon trayIcon;
    readonly CancellationTokenSource stop = new();
    readonly ScreenCapture capture = new();
    readonly HashSet<int> heldVks = new();
    readonly System.Windows.Forms.Timer captureTimer = new();

    ClientWebSocket? ws;
    bool connected;
    bool inputPermitted = true;
    bool blockInputActive;
    long framesSent;
    long bytesSent;
    DateTime lastBandwidthCheck = DateTime.UtcNow;
    double estimatedBandwidthKbps = 4000;
    string? lastFrameHash;
    int consecutiveUnchangedFrames;
    readonly SynchronizationContext? uiContext;

    public AgentTrayContext(AgentOptions options)
    {
        this.options = options;
        uiContext = SynchronizationContext.Current;

        trayIcon = new NotifyIcon
        {
            Icon = System.Drawing.SystemIcons.Application,
            Visible = true,
            Text = "Remote Support Agent — Connecting..."
        };
        var menu = new ContextMenuStrip();
        menu.Items.Add("Remote Support Agent", null, (_, _) => { });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("End session and exit", null, (_, _) => ExitAgent());
        trayIcon.ContextMenuStrip = menu;

        captureTimer.Tick += (_, _) => _ = SendFrameIfDueAsync();
        captureTimer.Interval = 1000 / 15; // capped by tier fps in SendFrameIfDueAsync
        captureTimer.Start();

        Application.ApplicationExit += (_, _) => Cleanup();

        _ = ConnectAsync();
    }

    void ExitAgent()
    {
        Cleanup();
        Application.Exit();
    }

    void Cleanup()
    {
        try { ReleaseAllHeldKeys(); } catch { }
        try { stop.Cancel(); } catch { }
        try { ws?.Dispose(); } catch { }
        try { capture.Dispose(); } catch { }
        try { trayIcon.Visible = false; } catch { }
        AgentLog.Write("Agent shutting down.");
    }

    async Task ConnectAsync()
    {
        try
        {
            AgentLog.Write($"Connecting to {ToWebSocketUrl()}");
            ws = new ClientWebSocket();
            if (options.InsecureSkipTlsVerify)
            {
                ws.Options.RemoteCertificateValidationCallback = (_, _, _, _) => true;
            }
            await ws.ConnectAsync(ToWebSocketUrl(), stop.Token);
            connected = true;
            trayIcon.Text = "Remote Support Agent — Connected, waiting for technician";
            AgentLog.Write("Connected to session WebSocket.");
            _ = Task.Run(ReceiveLoopAsync);
        }
        catch (Exception ex)
        {
            AgentLog.Write($"Connect failed: {ex}");
            trayIcon.Text = "Remote Support Agent — Connection failed";
            trayIcon.BalloonTipTitle = "Remote Support";
            trayIcon.BalloonTipText = "Could not connect to the support session. The technician may need to resend the link.";
            trayIcon.ShowBalloonTip(4000);
        }
    }

    Uri ToWebSocketUrl()
    {
        var baseUri = new Uri(options.ServerUrl!.TrimEnd('/'));
        var builder = new UriBuilder(baseUri)
        {
            Scheme = baseUri.Scheme == "https" ? "wss" : "ws",
            Path = "/",
            Query = $"role=customer&client=windows-native-agent&sessionId={Uri.EscapeDataString(options.SessionId!)}&token={Uri.EscapeDataString(options.Token!)}"
        };
        return builder.Uri;
    }

    // ─────────────────────────────────────────────────────────────────
    // Outbound: screen capture streaming with adaptive quality
    // ─────────────────────────────────────────────────────────────────

    long lastSequence;
    DateTime lastFrameSentAt = DateTime.MinValue;

    async Task SendFrameIfDueAsync()
    {
        if (!connected || ws?.State != WebSocketState.Open) return;

        var tier = capture.CurrentTier;
        var minIntervalMs = 1000.0 / TierFps(capture.CurrentTierIndex);
        if ((DateTime.UtcNow - lastFrameSentAt).TotalMilliseconds < minIntervalMs) return;

        var result = capture.CaptureFrame();
        if (result is null) return;
        var (jpeg, w, h) = result.Value;

        // Cheap perceptual de-dupe: skip sending if the byte length + a
        // small hash of the payload is identical to the previous frame
        // (avoids re-sending an unchanged screen at full rate, same idea as
        // the browser capture engine's delta-detection).
        var hash = $"{jpeg.Length}:{(jpeg.Length > 64 ? BitConverter.ToString(jpeg, jpeg.Length / 2, 32) : "")}";
        if (hash == lastFrameHash)
        {
            consecutiveUnchangedFrames++;
            if (consecutiveUnchangedFrames < 30) return; // still send a keyframe periodically
        }
        consecutiveUnchangedFrames = 0;
        lastFrameHash = hash;

        var base64 = Convert.ToBase64String(jpeg);
        var payload = new
        {
            format = "jpeg",
            data = base64,
            width = w,
            height = h,
            quality = tier.JpegQuality / 100.0,
            tier = tier.Label,
            sequence = lastSequence++
        };

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var ok = await SendAsync("screen.frame", payload);
        sw.Stop();
        if (!ok) return;

        lastFrameSentAt = DateTime.UtcNow;
        framesSent++;
        bytesSent += jpeg.Length;
        AdaptQuality(jpeg.Length, sw.Elapsed.TotalMilliseconds);
        trayIcon.Text = $"Remote Support Agent — Streaming ({tier.Label})";
    }

    static double TierFps(int tierIndex) => tierIndex switch
    {
        0 => 12, // retina
        1 => 15, // ultra
        2 => 12, // high
        3 => 10, // medium
        4 => 8,  // low
        _ => 5   // minimal
    };

    void AdaptQuality(int frameBytes, double sendTimeMs)
    {
        var sizeKB = frameBytes / 1024.0;
        if (sendTimeMs > 0)
        {
            var bitsPerSecond = (frameBytes * 8) / (sendTimeMs / 1000.0);
            estimatedBandwidthKbps = estimatedBandwidthKbps * 0.7 + (bitsPerSecond / 1000.0) * 0.3;
        }

        if (sizeKB < 60 && estimatedBandwidthKbps > 2500 && framesSent > 20)
        {
            capture.UpgradeTier();
        }
        else if (sizeKB > 350 || estimatedBandwidthKbps < 350)
        {
            capture.DowngradeTier();
        }
        else if (sizeKB > 220 && estimatedBandwidthKbps < 1000)
        {
            capture.DowngradeTier();
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Inbound: technician input + control messages
    // ─────────────────────────────────────────────────────────────────

    async Task ReceiveLoopAsync()
    {
        try
        {
            var buffer = new byte[1024 * 64];
            while (ws?.State == WebSocketState.Open && !stop.IsCancellationRequested)
            {
                using var stream = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await ws.ReceiveAsync(buffer, stop.Token);
                    if (result.MessageType == WebSocketMessageType.Close) return;
                    stream.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                HandleMessage(Encoding.UTF8.GetString(stream.ToArray()));
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            AgentLog.Write($"Receive loop error: {ex}");
        }
        finally
        {
            connected = false;
            ReleaseAllHeldKeys();
            if (!stop.IsCancellationRequested)
            {
                trayIcon.Text = "Remote Support Agent — Disconnected, reconnecting...";
                await Task.Delay(2000);
                _ = ConnectAsync();
            }
        }
    }

    void HandleMessage(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("type", out var typeProp)) return;
            var type = typeProp.GetString();
            var payload = doc.RootElement.TryGetProperty("payload", out var p) ? p : default;

            switch (type)
            {
                case "input":
                    HandleInput(payload);
                    break;
                case "block-input":
                    blockInputActive = payload.ValueKind == JsonValueKind.Object &&
                        payload.TryGetProperty("enabled", out var be) && be.GetBoolean();
                    break;
                case "blank-screen":
                    // Native agent has no way to physically blank the guest's
                    // monitor without a driver-level filter; acknowledged but
                    // intentionally a no-op here to avoid claiming a capability
                    // that isn't actually implemented.
                    break;
                case "session.end":
                    if (uiContext is not null) uiContext.Post(_ => ExitAgent(), null);
                    else ExitAgent();
                    break;
            }
        }
        catch (Exception ex)
        {
            AgentLog.Write($"HandleMessage error: {ex}");
        }
    }

    void HandleInput(JsonElement payload)
    {
        if (!inputPermitted || blockInputActive) return;
        if (payload.ValueKind != JsonValueKind.Object) return;

        var kind = payload.TryGetProperty("kind", out var kindProp) ? kindProp.GetString() : null;
        if (string.IsNullOrEmpty(kind)) return;

        switch (kind)
        {
            case "keydown":
            case "keyup":
            {
                var code = payload.TryGetProperty("code", out var c) ? c.GetString() : null;
                var key = payload.TryGetProperty("key", out var k) ? k.GetString() : null;
                var shift = payload.TryGetProperty("shiftKey", out var sk) && sk.GetBoolean();
                var ctrl = payload.TryGetProperty("ctrlKey", out var ck) && ck.GetBoolean();
                var alt = payload.TryGetProperty("altKey", out var ak) && ak.GetBoolean();
                var meta = payload.TryGetProperty("metaKey", out var mk) && mk.GetBoolean();

                InputInjector.SendKey(kind, code, key, shift, ctrl, alt, meta);

                // Track held keys (by resolved VK) so a disconnect/blur can
                // force-release everything and nothing gets stuck down.
                var vk = ResolveTrackedVk(code, key);
                if (vk != 0)
                {
                    if (kind == "keydown") heldVks.Add(vk);
                    else heldVks.Remove(vk);
                }
                break;
            }
            case "pointerdown":
            case "pointerup":
            {
                var x = payload.TryGetProperty("x", out var xEl) ? xEl.GetDouble() : 0;
                var y = payload.TryGetProperty("y", out var yEl) ? yEl.GetDouble() : 0;
                var button = payload.TryGetProperty("button", out var bEl) ? bEl.GetInt32() : 0;
                InputInjector.Button(x, y, button, kind == "pointerdown");
                break;
            }
            case "pointermove":
            {
                var x = payload.TryGetProperty("x", out var xEl) ? xEl.GetDouble() : 0;
                var y = payload.TryGetProperty("y", out var yEl) ? yEl.GetDouble() : 0;
                InputInjector.MoveTo(x, y);
                break;
            }
            case "pointerdblclick":
            {
                var x = payload.TryGetProperty("x", out var xEl) ? xEl.GetDouble() : 0;
                var y = payload.TryGetProperty("y", out var yEl) ? yEl.GetDouble() : 0;
                var button = payload.TryGetProperty("button", out var bEl) ? bEl.GetInt32() : 0;
                InputInjector.Button(x, y, button, true);
                InputInjector.Button(x, y, button, false);
                InputInjector.Button(x, y, button, true);
                InputInjector.Button(x, y, button, false);
                break;
            }
            case "wheel":
            {
                var x = payload.TryGetProperty("x", out var xEl) ? xEl.GetDouble() : 0;
                var y = payload.TryGetProperty("y", out var yEl) ? yEl.GetDouble() : 0;
                var deltaY = payload.TryGetProperty("deltaY", out var dyEl) ? dyEl.GetDouble() : 0;
                var deltaX = payload.TryGetProperty("deltaX", out var dxEl) ? dxEl.GetDouble() : 0;
                InputInjector.Wheel(x, y, deltaY, deltaX);
                break;
            }
        }
    }

    static int ResolveTrackedVk(string? code, string? key)
    {
        // Reuse the same resolution logic as InputInjector by calling a
        // lightweight duplicate lookup path is unnecessary — we only need
        // the VK for held-key bookkeeping, so approximate via the public
        // SendKey's internal map isn't exposed; keep this simple by hashing
        // code/key into 0 (skip tracking) for anything not a plain letter.
        // For correctness of "release all held keys", the important cases
        // (letters, digits, common modifiers) are covered.
        if (string.IsNullOrEmpty(code)) return 0;
        if (code.StartsWith("Key") && code.Length == 4) return code[3];
        if (code.StartsWith("Digit") && code.Length == 6) return 0x30 + (code[5] - '0');
        return code switch
        {
            "ShiftLeft" => 0xA0,
            "ShiftRight" => 0xA1,
            "ControlLeft" => 0xA2,
            "ControlRight" => 0xA3,
            "AltLeft" => 0xA4,
            "AltRight" => 0xA5,
            _ => 0
        };
    }

    void ReleaseAllHeldKeys()
    {
        foreach (var vk in heldVks) InputInjector.ReleaseKey(vk);
        heldVks.Clear();
    }

    async Task<bool> SendAsync(string type, object payload)
    {
        if (ws?.State != WebSocketState.Open) return false;
        try
        {
            var json = JsonSerializer.Serialize(new { type, payload });
            var bytes = Encoding.UTF8.GetBytes(json);
            await ws.SendAsync(bytes, WebSocketMessageType.Text, true, stop.Token);
            return true;
        }
        catch (Exception ex)
        {
            AgentLog.Write($"Send failed: {ex}");
            return false;
        }
    }
}
