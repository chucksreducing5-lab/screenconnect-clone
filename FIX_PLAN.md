# Fix Plan

## 1. Keyboard input (host-client.js + Program.cs)
- [x] Centralize keyboard handling in host-client.js: remove the duplicate/competing
      `document.addEventListener('keydown', ...)` zoom-shortcut handler colliding with
      the `sendKey` handler; consolidate into one listener path bound at `window` level
      that also handles the Ctrl+/-/0/H zoom shortcuts, then forwards everything else
      to a single `sendKey` dispatcher.
- [x] De-duplicate key events: the previous code attached `keydown`/`keyup` listeners
      BOTH on `remoteScreen` and on `window`, causing the same physical keypress to be
      sent twice (once from each listener) whenever `remoteScreen` was the focused/active
      element. Fix so exactly one input event is produced per keydown and one release
      event per keyup.
- [x] Do not drop `event.repeat` keydowns — held keys must continue to register (OS-level
      autorepeat) but must not be coalesced/deduped in a way that causes stuck keys.
      Ensure `repeat` flag is still forwarded so the host side can decide OS-native
      autorepeat behavior instead of the browser swallowing repeats.
- [x] Expand `KeyName`/mapping on the C# host side (Program.cs `KeyName`) to cover the
      full standard set: punctuation/symbol keys (OemXXX), function keys F1-F24,
      numpad keys, media keys, Windows/Meta key, Insert, PrintScreen, CapsLock, NumLock,
      ScrollLock, Pause, Applications key, left/right variants of Ctrl/Alt/Shift, etc.
      Today only a small subset (letters, digits, a few named keys) map; everything else
      returns "" and is silently dropped.
- [x] Correctly report Shift/Ctrl/Alt/Meta (Windows key) modifier state from Program.cs;
      `metaKey` was hard-coded `false` there always.

## 2. Capture / display quality (customer.js)
- [x] Increase the default and max capture resolution tiers — today `ultra`/`high` cap
      at 1920 maxWidth already but "medium"/default entry tiers used lower profiles and
      mobile defaults to 'medium' (1280) with heavy compression. Add a 1440p ultra tier,
      raise starting tier's quality settings, and prefer less aggressive downscaling
      when bandwidth is good.
- [x] Improve default capture parameters (frameRate hints in `getDisplayMedia`, initial
      tier selection) so desktop share doesn't default to an unnecessarily low profile.

## 3. Host-side rendering (host-client.js SCViewer, Program.cs)
- [x] Ensure canvas rendering keeps `imageSmoothingEnabled = true` and
      `imageSmoothingQuality = 'high'` (already present) and correctly scales for
      devicePixelRatio (already present) — verify and tidy; also switch the PictureBox
      (native host) to a proper high-quality GDI+ interpolation mode instead of the
      basic `PictureBoxSizeMode.Zoom` default (which uses nearest-neighbor scaling).

## 4. Signaling vs. frame traffic / live status (server.js)
- [x] The browser customer signaling socket (`clientKind === 'browser-broadcast'`)
      is correctly excluded from `nativeConnected` on connect, but the aggregated
      "live/guestConnected" status exposed to the technician list
      (`/api/sessions/:id/status`, `publicSession()`) still treats `browserConnected`
      (mere socket connection) as equivalent to a live session in some places
      (`guestConnected = ... || pub.browserConnected`). Fix so "live" is only true when
      `nativeConnected` (native app) OR `screenStreaming` (`hasRecentScreenStream`,
      i.e., recent `lastFrameAt`) is true — never from socket connection alone.
- [x] Apply the same fix to `getSessionStatus()` in app.js (technician dashboard),
      which currently shows "online" purely from `s.guestConnected`.
