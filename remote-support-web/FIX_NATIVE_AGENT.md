# Fix: Real Native Windows Customer Agent (capture + input injection)

## The problem

The customer reported, when testing with the **downloaded native Windows app**:

- Most keyboard keys don't work (`.`, numbers, "and many more").
- Screen image quality never changes — "very cheap ... nothing is visible ... needs to be HD".

## Root cause

All three native Windows projects in this repo (`RemoteSupportAgent.csproj`,
`RemoteSupportHost.csproj`, `RemoteSupportService.csproj`) compiled the exact
same `Program.cs` — which only implements the **technician's Host Viewer**:

- It connects with `role=agent&client=host-viewer`.
- It **receives** `screen.frame` messages and paints them.
- It **sends** `input` messages when the technician types/clicks.

There was no code anywhere in the repository that:

- Captured the **customer's** real desktop (no `BitBlt` / `CopyFromScreen` / DXGI), or
- **Applied** incoming `input` messages on the customer's machine (no
  `SendInput` / `keybd_event` anywhere).

So the "Customer Agent" `.exe` customers download and run was, in reality,
just another copy of the Host Viewer. It had nothing to capture with and
nothing to inject with — which is exactly consistent with the reported
symptoms (keys "not working", image quality "never changing" because no real
frames were ever produced by that binary; whatever image did show up came
from an unrelated/stale path).

## The fix

Restructured the native source layout to match what `AGENTS.md` always said
it should be, and — for the first time — actually implemented the
customer-side agent:

```
native-agent/    <- NEW real implementation: desktop capture + input injection
native-host/     <- unchanged Host Viewer (technician side), just moved into its own folder
native-service/  <- NEW minimal watchdog/launcher for unattended access
```

### `native-agent/` — the real Customer Agent

| File | Responsibility |
|---|---|
| `Program.cs` | Entry point. Resolves session/token from the launch link (same base64url launch-data pattern as the Host Viewer, but hits `/api/agent-launch/{id}` with the **customer** token), enables per-monitor DPI awareness, starts the tray app. |
| `NativeMethods.cs` | Win32 P/Invoke surface: `SendInput`, `GetKeyState`, `BlockInput`, `GetSystemMetrics`, `SetProcessDpiAwareness`, INPUT/KEYBDINPUT/MOUSEINPUT structs, VK/flag constants. |
| `InputInjector.cs` | **Real keyboard/mouse injection.** Resolves DOM `code` (layout-independent, e.g. `Period`, `Slash`, `Digit1`, `Semicolon`, `BracketLeft`, ...) to Windows virtual-key codes first, with `key`-based and single-character fallbacks. Covers letters, digits, all F-keys, numpad, modifiers (left/right), and the full set of OEM punctuation keys — this is exactly the set of keys the customer said were "not working". Also implements mouse move/click/wheel using normalized 0..1 coordinates mapped to the correct absolute position across multi-monitor virtual-desktop bounds (including negative-origin monitors). |
| `ScreenCapture.cs` | **Real desktop capture.** Uses `Graphics.CopyFromScreen` over the full virtual desktop, then high-quality bicubic downscale + JPEG encode at an adaptive quality tier (Retina/1440p, Ultra/1080p, High, Medium, Low, Minimal — mirrors the browser's existing tier system) instead of a fixed low-quality/no-op image. |
| `AgentTrayContext.cs` | Ties it together as a system-tray app: connects to the relay as `role=customer&client=windows-native-agent` (previously this would have wrongly been `role=agent`, which is the technician role), streams frames at the tier's target FPS with bandwidth-adaptive tier upgrade/downgrade (same thresholds as the browser), and applies every incoming `input` message via `InputInjector`. Releases any held keys on disconnect/exit to avoid "stuck key" bugs. |

### `native-service/Program.cs` — unattended-access watchdog

Previously this project had no source of its own at all (it also just
inherited the Host Viewer `Program.cs`, which wouldn't even build without
`UseWindowsForms`). It's now a small real watchdog: launches
`RemoteSupportAgent.exe` with the connection arguments and restarts it if it
exits or crashes, matching what `AGENTS.md` describes ("registers the
endpoint and launches the desktop helper"). It is intentionally minimal (no
SCM integration) — it can be pointed at by `sc.exe create` or NSSM if a real
Windows Service wrapper is needed later.

### `server.js`

Added a dedicated branch for `clientKind === 'windows-native-agent'` so the
session is **not** marked `nativeConnected` purely from the socket handshake
— exactly like the existing Android/iOS broadcast clients, the session only
becomes "live" once a real `screen.frame` message actually arrives. This
keeps the "live means real frame data, not just a connected socket"
guarantee consistent across every client kind (browser, mobile, and now the
native Windows agent).

## Build limitations of this sandbox

This sandbox has **no .NET SDK installed**, so none of this C# code could be
compiled or run here. Everything was written carefully and manually
verified (brace/paren balance, cross-checked against the existing Host
Viewer's working patterns for WebSocket connection/reconnect, launch-data
decoding, and DPI handling), but it has **not been built or tested on an
actual Windows machine**.

To produce real, runnable `.exe` files, someone with a Windows machine (or a
Windows CI runner) needs to run:

```bash
cd remote-support-web
dotnet publish -c Release -o native-agent/publish  native-agent/RemoteSupportAgent.csproj
dotnet publish -c Release -o native-host/publish   native-host/RemoteSupportHost.csproj
dotnet publish -c Release -o native-service/publish native-service/RemoteSupportService.csproj
```

`server.js` already expects the published agent/host executables at
`native-agent/publish` / `native-host/publish` respectively (see
`agentPublishDir` / `hostPublishDir`), so once built, those `publish/`
folders just need to be deployed to the production server for the
`/download/...` routes to serve the new, working binaries.

## What is intentionally out of scope here

The user separately reported that browser-based customer control was also
incomplete (the browser `customer.js` never applies incoming `input`
messages), but confirmed they are specifically testing with **the downloaded
native Windows app**, so this fix focuses entirely on the native agent. The
browser-side input-application gap still exists and would need a follow-up
fix if browser-to-browser control is also required.
