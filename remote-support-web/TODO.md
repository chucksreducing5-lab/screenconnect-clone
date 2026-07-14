# Remote support end-to-end flow hardening - Execution TODO

- [x] Analyze existing server/web/mobile flows and identify gaps against requested behavior
- [ ] Implement server-side customer lifecycle states, platform detection granularity, auth handoff, and reconnect-aware status transitions (`server.js`)
- [ ] Implement customer web flow fixes for deterministic join behavior, iPhone/iPad detection, status timeline, and app fallback routing (`public/customer.js`)
- [ ] Implement host-side status ladder and explicit waiting/error messaging (`public/host-client.js`)
- [ ] Implement Android reconnect/backoff/auth/status emissions in screen capture service (`native-android/.../ScreenCaptureService.kt`)
- [ ] Implement Android activity flow messaging updates around permission/session steps (`native-android/.../MainActivity.kt`)
- [ ] Implement iOS app-side session guidance/status persistence improvements (`native-ios/.../ViewController.swift`)
- [ ] Implement iOS broadcast extension reconnect/backoff/auth/status monitoring (`native-ios/.../IOSBroadcastRelay.swift`)
- [ ] Implement iOS SampleHandler lifecycle/error status emissions (`native-ios/.../SampleHandler.swift`)
- [ ] Run sanity checks and summarize final fix coverage

## Focused iteration: backend + host-client reliability fixes (current)

- [x] Patch `server.js` to persist `/api/session/:id/permissions` updates to disk immediately
- [x] Patch `public/host-client.js` to prevent duplicate keyboard event transmission
- [x] Run quick sanity check and confirm no syntax regressions

## Full implementation batch (in progress)

- [ ] Phase 1: Implement server-side customer lifecycle states, platform detection granularity, auth handoff, and reconnect-aware status transitions (`server.js`)
- [ ] Phase 2: Implement customer web deterministic join flow, iPhone/iPad detection, status timeline, and app fallback routing (`public/customer.js`)
- [ ] Phase 2: Implement host-side status ladder and explicit waiting/error messaging (`public/host-client.js`)
- [ ] Phase 3: Implement Android reconnect/backoff/auth/status emissions (`native-android/.../ScreenCaptureService.kt`)
- [ ] Phase 3: Implement Android activity flow messaging updates (`native-android/.../MainActivity.kt`)
- [ ] Phase 4: Implement iOS app-side session guidance/status persistence improvements (`native-ios/.../ViewController.swift`)
- [ ] Phase 4: Implement iOS broadcast reconnect/backoff/auth/status monitoring (`native-ios/.../IOSBroadcastRelay.swift`)
- [ ] Phase 4: Implement iOS SampleHandler lifecycle/error status emissions (`native-ios/.../SampleHandler.swift`)
- [ ] Phase 5: Run sanity checks and summarize final fix coverage
