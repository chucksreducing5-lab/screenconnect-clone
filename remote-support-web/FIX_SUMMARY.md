# Fix Summary — Customer Mobile Phone Not Connecting to Host Session

## What the image says

The uploaded screenshot shows the host viewer app on the Dell laptop displaying:

> **Status: Connected to relay**
> **Host viewer 0.2.12 is connected. Waiting for customer screen frames.**

The phone on the right shows the customer join page (the browser-based support code entry screen).

**Meaning:** The host viewer (the technician's side) successfully opened its WebSocket to the relay server and authenticated. It is now waiting for the customer's mobile phone to start sending `screen.frame` messages. Those frames never arrived — so the host stayed stuck on "Waiting for customer screen frames" forever.

## Root cause

The bug is a **multi-layer defect in the customer→server frame pipeline** that silently dropped the mobile app's screen frames whenever the browser join page was also connected (which is the normal mobile flow: the customer opens the join page in the browser, which deep-links into the native Android/iOS broadcast app, and both stay connected).

### Defect 1 — `customerSocketId` message gate silently dropped frames (server.js)

The relay server only processed customer messages from the *most-recently-recorded* customer socket:

```js
if (role === 'customer' && ws.connectionId !== s.customerSocketId) {
  return;   // silently drops EVERYTHING from any other customer socket
}
```

`customerSocketId` is overwritten by whichever customer connects last. On mobile, the browser join page and the native app both connect as `role=customer`. When the browser page reconnects (a network blip, or the built-in auto-reconnect logic in `customer.js`), it overwrites `customerSocketId`, and from that point on **every `screen.frame` sent by the native app was silently discarded** — the host never saw a single frame.

### Defect 2 — Browser and native app used the same `client` kind, so they kicked each other out (customer.js + server.js)

The browser customer on a phone connected with `client=android-mobile-broadcast` (identical to the native Android app) / `client=ios-mobile-broadcast` (identical to the iOS app). The server's replacement logic then closed same-kind connections:

```js
if (client.clientKind === clientKind) {
  client.send(JSON.stringify({ type: 'session.end', ... }));
  client.close(4001, 'Replaced by newer customer connection');
}
```

The browser receives `session.end` → runs `stopBrowserShare()` → closes its socket → the reconnect handler reopens it → which kicks the native app → whose socket is now dead → **no frames**. This created a destructive mutual-replacement loop.

### Defect 3 — Browser signaling socket prematurely marked the session active (server.js)

Because the browser used a mobile-broadcast client kind, the server set `nativeConnected = true` as soon as the browser page connected, before any real frame arrived. This could mask the real "no frames" condition.

### Defect 4 — Closing the browser page tore down the session even while the native app was still streaming (server.js)

When the browser signaling socket closed, the server cleared `customerSocketId` and set `nativeConnected = false`, dropping the session back to `waiting` even though the native broadcast app was still connected and sending frames.

## The fix (no interface / layout / UI changes)

Only **`server.js`** and **`public/customer.js`** were modified. No HTML, no CSS, no layout, no visible text, no buttons, no styling, and no UI behavior was changed. The host viewer (`Program.cs`), Android (`ScreenCaptureService.kt`), and iOS (`IOSBroadcastRelay.swift`) native apps required no changes — they were already correct; the frames were being dropped by the server before reaching the host.

### Change 1 — `public/customer.js`: distinct client kind for the browser

`customerWebSocketUrl()` now connects the browser customer with `client=browser-broadcast` instead of `android-mobile-broadcast`/`ios-mobile-broadcast`. This stops the browser and the native app from sharing a client kind, so the server's same-kind replacement logic no longer kicks the native app out, and the two sockets coexist peacefully (browser = signaling, native app = frames).

### Change 2 — `server.js`: frame/heartbeat/status messages exempt from the `customerSocketId` gate

The message gate now only restricts non-frame signaling/control messages to the primary customer socket. `screen.frame`, `screen.heartbeat`, and `screen.broadcast.status` are always processed from any authenticated customer socket of the session, so the native app's frames are relayed to the host regardless of which customer socket happens to be recorded as `customerSocketId`:

```js
if (role === 'customer' && type !== 'screen.frame' && type !== 'screen.heartbeat' && type !== 'screen.broadcast.status' && ws.connectionId !== s.customerSocketId) {
  return;
}
```

### Change 3 — `server.js`: browser signaling sockets don't mark the session active

The `nativeConnected` assignment now treats `browser-broadcast` the same as `browser-share` — a browser join page is a signaling channel, not a frame source, so it must not mark the session active before real frames arrive.

### Change 4 — `server.js`: closing the browser page no longer tears down a live native stream

When a browser signaling socket (`browser-share`/`browser-broadcast`) closes while a native mobile broadcast app is still connected and recently delivered frames, the server now transfers `customerSocketId` to that native socket and leaves `nativeConnected = true`. The session stays active and the host keeps receiving frames.

## Verification

A simulation reproducing the exact failure scenario (browser join page + native Android app both connected, browser reconnects mid-stream, then browser closes) was run against the fixed logic. Both scenarios pass:

- ✅ Native frames relay to the host even after the browser page reconnects (previously dropped by the gate).
- ✅ The session stays active and frames keep relaying after the browser page closes while the native app streams (previously torn down).

Both modified files pass `node --check` (syntactically valid).

## Files changed
- `server.js` — message gate, nativeConnected assignment, close handling
- `public/customer.js` — WebSocket client kind for the browser customer

## Files NOT changed (UI/layout untouched)
- `public/customer.html` — layout and markup untouched
- `Program.cs` — host viewer untouched
- `native-android/.../ScreenCaptureService.kt` — Android app untouched
- `native-ios/.../IOSBroadcastRelay.swift` — iOS app untouched
- All CSS, assets, and other client files — untouched
