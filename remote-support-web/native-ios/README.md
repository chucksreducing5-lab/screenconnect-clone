# native-ios (ReplayKit Broadcast Upload Extension scaffold)

This folder contains a starter structure for an iOS native implementation using:
- Host app (collects server/session/token settings)
- ReplayKit Broadcast Upload Extension (captures frames)
- WebSocket sender (`screen.frame`) to the existing server relay

## Structure

- `RemoteSupportIOS/` (Xcode project placeholder)
  - `RemoteSupportApp/`
  - `RemoteSupportBroadcastExtension/`

## Required implementation notes

1. Host app must collect:
   - Server URL
   - Session ID
   - Customer token

2. Broadcast extension:
   - Uses `RPBroadcastSampleHandler`
   - Converts `CMSampleBuffer` to JPEG
   - Sends JSON via WebSocket:
     - `type: "screen.frame"`
     - payload: `{ sequence, width, height, format: "jpeg", data: "<base64>" }`
   - Also sends `screen.broadcast.status` updates.

3. WebSocket URL format:
   `wss://<host>/?role=customer&client=ios-mobile-broadcast&sessionId=<id>&token=<token>`

4. App Group should be used to pass host app config into extension.

This scaffold is intentionally minimal and code-first details are in the source files created in this folder.
