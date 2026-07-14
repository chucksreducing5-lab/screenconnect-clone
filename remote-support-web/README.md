# remote-support-web (MVP)

This is an initial scaffold for a remote support system:

- Remote endpoint registration with hostname, OS, status, identity token, and last-seen time
- Central Express/WebSocket server for authentication placeholders, routing, active sessions, and audit records
- Technician console with online/offline devices, session creation, screen viewer, input toggle, file-transfer queue, terminal queue, recording flag, and audit log
- Browser endpoint join page that acts as the prototype remote agent for screen streaming
- Native Windows desktop helper in `native-agent/` for real desktop capture and mouse input injection
- Native Windows unattended service in `native-service/` that keeps the endpoint registered and starts the visible desktop helper in the active user session
- WebRTC signaling relay for screen sharing with `getDisplayMedia`
- WebSocket relay for native screen frames and input/control/chat-style messages
- Agent job polling for terminal commands and remote file download jobs
- Technician-controlled session end/disconnect flow
- Technician-controlled customer blank screen/privacy overlay with a progress message

Important: unattended support is split into a Windows service plus a per-user desktop helper. The service runs in Session 0 and cannot directly capture/control the interactive desktop, so it only registers, heartbeats, polls for pending sessions, and launches the visible helper into the active console session.

## Run

1) Install dependencies

## macOS / CocoaPods note
This repository is currently a Node web app + Windows .NET native agent/service (`native-agent/` and `native-service/`). It does not contain a CocoaPods/Xcode project (`Podfile`, `*.xcworkspace`, `Agent.xcworkspace`) or scripts like `check_pod_frameworks.sh`, so the macOS/CocoaPods build workflow described elsewhere is **not applicable** to this repo as it stands.


```bash
cd remote-support-web
npm i
```

2) Start server

```bash
node server.js
```

To serve over HTTPS on Windows, export and trust a local dev certificate:

```powershell
mkdir certs
dotnet dev-certs https -ep certs\helpsupport.top.pfx -p "devpassword" --trust
$env:HTTPS_PFX="certs\helpsupport.top.pfx"
$env:HTTPS_PFX_PASSPHRASE="devpassword"
node server.js
```

You can also set PEM certificate paths before starting:

```powershell
$env:HTTPS_KEY="certs\helpsupport.top-key.pem"
$env:HTTPS_CERT="certs\helpsupport.top-cert.pem"
node server.js
```

For quick local testing, create a self-signed certificate with OpenSSL:

```powershell
mkdir certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs\helpsupport.top-key.pem -out certs\helpsupport.top-cert.pem -days 365 -subj "/CN=helpsupport.top"
```

Server: `http://helpsupport.top:3001` or `https://helpsupport.top:3001` when HTTPS is enabled

Open:

- Technician console: `http://helpsupport.top:3001/`
- Browser remote agent: `http://helpsupport.top:3001/customer`

Screen sharing requires a secure browser context. It works on `helpsupport.top` for development, and requires HTTPS when deployed. For customers outside your network, open the technician console from a public HTTPS URL before creating the invite so the generated customer link uses that public address.

## Native Windows Agent

Install the .NET 8 SDK, then run:

```powershell
cd native-agent
dotnet run -- http://helpsupport.top:3001
```

Flow:

1. The agent loads or creates a device ID in `%APPDATA%\RemoteSupportAgent\agent.json`.
2. It registers with `/api/agent/register` and sends heartbeats with `/api/agent/:id/heartbeat`.
3. A technician selects the device and starts a session in the web console.
4. The agent claims its pending session from `/api/agent/:id/session`.
5. It connects to the WebSocket relay, captures desktop JPEG frames, and sends `screen.frame` messages.
6. If the technician enables input control, pointer and keyboard events are relayed back and injected into the current Windows desktop session.
7. Terminal and file jobs are polled from `/api/agent/:id/jobs` and reported to `/api/agent/:id/jobs/:jobId/result`.
8. The technician can toggle Blank screen to show the customer-side update overlay and toggle it again to restore the screen.

## Native Windows Unattended Service

Publish both native projects:

```powershell
dotnet publish native-agent\RemoteSupportAgent.csproj -c Release -o native-agent\publish
dotnet publish native-service\RemoteSupportService.csproj -c Release -o native-service\publish
```

Install the service from an elevated PowerShell prompt, pointing it at the published desktop helper:

```powershell
native-service\publish\RemoteSupportService.exe --install http://helpsupport.top:3001 --helper "C:\Users\dell\Desktop\remote-support-web\native-agent\publish\RemoteSupportAgent.exe"
```

For a public deployment, replace `http://helpsupport.top:3001` with the public HTTPS server URL used by the technician console.

What it does:

- Stores shared device identity in `%ProgramData%\RemoteSupportAgent\agent.json`
- Writes service logs to `%ProgramData%\RemoteSupportAgent\service.log`
- Registers the endpoint as `unattended: true`
- Sends heartbeats while Windows is running
- Polls for technician-created sessions assigned to that device
- Starts `RemoteSupportAgent.exe` in the active signed-in user's desktop session with `--service-helper`
- Leaves capture, input injection, blank screen, terminal, and file jobs in the visible desktop helper

Uninstall:

```powershell
native-service\publish\RemoteSupportService.exe --uninstall
```

Run without installing, useful for debugging:

```powershell
native-service\publish\RemoteSupportService.exe --console http://helpsupport.top:3001 --helper "C:\Users\dell\Desktop\remote-support-web\native-agent\publish\RemoteSupportAgent.exe"
```

The service requires a signed-in interactive user before it can launch the helper. A future production installer should add an explicit customer consent screen, technician authentication, code signing, and a visible tray app with Disable/Uninstall controls.

## API

- `GET /api/devices`
- `POST /api/agent/register`
- `POST /api/agent/:id/heartbeat`
- `GET /api/agent/:id/session`
- `GET /api/agent/:id/jobs`
- `POST /api/agent/:id/jobs/:jobId/result`
- `POST /api/session/create`
- `POST /api/session/:id/validate`
- `POST /api/session/:id/join`
- `GET /api/session/:id/status`
- `POST /api/session/:id/recording`
- `POST /api/session/:id/end`
- `POST /api/session/:id/file-transfer`
- `POST /api/session/:id/terminal`
- `GET /api/audit`

WebSocket handshake expects query params:

- `role=agent|customer`
- `sessionId=<joinCode>`
- `token=<agentPortalToken|customerJoinToken>`

## Next implementation step

Add H.264/WebRTC transport, upload-side file transfer, session recording storage, durable storage, production authentication, and a first-class installer/tray app for consent and revocation.
