# Run notes

This project is a Node backend MVP scaffold. It now serves the browser UI for the technician console and customer join flow.

1) Install

```bash
cd remote-support-web
npm i
```

2) Start

```bash
node server.js
```

To run the server with HTTPS on Windows, export and trust a local dev certificate:

```powershell
mkdir certs
dotnet dev-certs https -ep certs\localhost.pfx -p "devpassword" --trust
$env:HTTPS_PFX="certs\localhost.pfx"
$env:HTTPS_PFX_PASSPHRASE="devpassword"
node server.js
```

Local HTTPS will open at `https://localhost:3001/`.

You can also provide PEM certificate files:

```powershell
$env:HTTPS_KEY="certs\localhost-key.pem"
$env:HTTPS_CERT="certs\localhost-cert.pem"
node server.js
```

For quick local testing, create a self-signed certificate with OpenSSL:

```powershell
mkdir certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs\localhost-key.pem -out certs\localhost-cert.pem -days 365 -subj "/CN=localhost"
```

Customers on another network still need a public HTTPS URL, such as a Cloudflare Tunnel/ngrok URL or a deployed domain. Open the technician console from that public HTTPS URL before creating the customer invite.

Production reliability:

- A tunnel or server running on this Windows computer goes offline when this computer shuts down.
- If the live site is already using the VPS public IP, keep the production path on that VPS and disable the old local tunnel.
- For `helpsupport.top` to stay available 24/7, deploy the Node app to an always-on VPS/cloud server.
- See `deploy/PRODUCTION.md` for a ready production checklist with `systemd` and Caddy HTTPS.

Development login:

- Username: `admin`
- Password: `admin`

Override these with `TECH_USERNAME` and `TECH_PASSWORD` before starting the server.

Forgot-password email can be sent through Gmail SMTP. Use a Gmail App Password, not your normal Gmail password:

```powershell
$env:ADMIN_EMAIL="yourname@gmail.com"
$env:SMTP_HOST="smtp.gmail.com"
$env:SMTP_PORT="465"
$env:SMTP_USER="yourname@gmail.com"
$env:SMTP_PASS="your-16-character-gmail-app-password"
$env:SMTP_FROM="yourname@gmail.com"
node server.js
```

If SMTP is not configured, reset codes are written to the server console for local testing.

3) Health

- GET http://localhost:3001/health or https://localhost:3001/health when HTTPS is enabled

4) Open the app

- Agent console: http://localhost:3001/ or https://localhost:3001/ when HTTPS is enabled
- Customer join: http://localhost:3001/customer or https://localhost:3001/customer when HTTPS is enabled

## macOS / CocoaPods note
This repo’s run instructions are for the Node server and (optionally) the Windows .NET native agent/service. There is no CocoaPods/Xcode workspace in this repository to build a macOS app from. If you have a separate macOS project for the same remote-support product, its CocoaPods steps should be run from that separate codebase.

For real screen sharing, use `localhost` in development or HTTPS in production.

## Fixed LAN IP run (your requested setup)

To make generated host/customer links use your fixed computer IP (`172.31.67.181`) instead of localhost, start the server with `HOST` and `PUBLIC_BASE_URL`:

```powershell
$env:HOST="172.31.67.181"
$env:PUBLIC_BASE_URL="http://172.31.67.181:3001"
$env:PORT="3001"
node server.js
```

Then open:

- Technician console: `http://172.31.67.181:3001/`
- Customer join: `http://172.31.67.181:3001/customer`
- Health check: `http://172.31.67.181:3001/health`

Important reliability note:

- If this Windows PC is shut down, these URLs stop working because the app runs on this PC.
- For URLs that stay online even when your PC is off, deploy this app to an always-on VPS/cloud host and set `PUBLIC_BASE_URL` to that public domain/IP.

## iPhone/iPad screen sharing

iOS browsers can join a session and keep the customer online, but browser JavaScript cannot capture the full iPhone/iPad screen. Full iOS screen viewing requires a native iOS support app with Apple's ReplayKit screen broadcast flow.

The customer join page now detects iPhone/iPad browsers and shows the mobile app path instead of leaving the host in a generic limited-permissions state. A native app should open the `supportdesk://join?...` link, connect to the session WebSocket with `role=customer&client=ios-mobile-broadcast`, then send `screen.frame` messages using the same payload shape as the browser broadcaster:

```json
{
  "type": "screen.frame",
  "payload": {
    "format": "jpeg",
    "data": "<base64 image>",
    "sequence": 1
  }
}
```

Set `IOS_APP_URL` to your App Store/TestFlight/install page so the customer page can tell users where to install the native broadcaster if the `supportdesk://` link does not open an app. Android can use `ANDROID_APP_URL`; Android browsers that expose screen capture can still use the browser broadcast button.

The host console and downloaded host viewer will show "iOS app required" until frames arrive. iOS remote control/input injection is not available from a normal web page; treat the iOS path as screen-viewing unless you add a managed native capability that Apple permits.

## Mobile connection reliability checks (Android / iPhone)

Use this checklist when mobile customers can enter code but host never receives screen:

1. **PUBLIC_BASE_URL / DOWNLOAD_BASE_URL must be stable HTTPS domain**
   - Ensure server env uses your production hostname (example: `https://www.helpsupport.top`).
   - Avoid mixed local/tunnel/domain origins for join/download/socket URLs.

2. **WebSocket upgrade must pass through reverse proxy / Cloudflare**
   - Customer and host signaling uses `wss://<domain>/` (root path).
   - Proxy must allow websocket upgrade on `/` and keep long-lived connections.

3. **Cloudflare SSL mode**
   - Use Full (strict) with valid origin cert whenever possible.
   - Mismatched SSL mode can cause intermittent mobile websocket disconnects.

4. **iOS behavior**
   - Safari/web page may not provide full-device capture in all contexts.
   - iPhone/iPad must use iOS support app + ReplayKit broadcast flow.
   - Host should expect `ios_broadcast_connected_waiting_first_frame` before first frame arrives.

5. **Android behavior**
   - Android can use browser capture when available; otherwise support app must start MediaProjection.
   - Host may see `android_broadcast_connected_waiting_first_frame` before first frame.

6. **Verify end-to-end quickly**
   - Host creates session -> customer joins code -> websocket connected -> first `screen.frame` received.
   - If stuck before first frame, check customer app permissions + proxy websocket forwarding first.

## Native Android app (MediaProjection) - local build/run

Scaffold location: `native-android/`

1. Open Android Studio and select `native-android` as project root.
2. Sync Gradle.
3. Build debug APK.
4. Run app on Android 10+ device.
5. Enter:
   - Server URL (example: `https://www.helpsupport.top`)
   - Session ID / join code
   - Customer token
6. Tap **Start Screen Broadcast** and accept system capture prompt.

The service sends:
- `screen.broadcast.status` with `client=android-mobile-broadcast`
- `screen.frame` messages with base64 JPEG payloads to existing server relay.

## Native iOS app (ReplayKit Broadcast Upload Extension) - implementation notes

Scaffold location: `native-ios/`

1. Create/import an Xcode project with:
   - Host app target (`RemoteSupportApp`)
   - Broadcast Upload Extension target (`RemoteSupportBroadcastExtension`)
2. Configure an App Group (example: `group.top.helpsupport.remotesupport`) for shared settings.
3. Host app saves:
   - `serverUrl`
   - `sessionId`
   - `token`
4. Broadcast extension uses `SampleHandler.swift` + `IOSBroadcastRelay.swift` to:
   - connect websocket as `client=ios-mobile-broadcast`
   - send `screen.broadcast.status`
   - encode frames to JPEG and send `screen.frame`.

iOS runtime flow:
- customer starts broadcast from Control Center / in-app ReplayKit UI
- extension streams frames to existing server and host viewer.
