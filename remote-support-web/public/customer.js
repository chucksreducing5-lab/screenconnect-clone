const code = document.querySelector('#code');
const join = document.querySelector('#join');
const joinForm = document.querySelector('#joinForm');
const message = document.querySelector('#message');
const controlMessage = document.querySelector('#controlMessage');
const downloadPanel = document.querySelector('#downloadPanel');
const successPanel = document.querySelector('#successPanel');
const setupDownload = document.querySelector('#setupDownload');
const blankScreenOverlay = document.querySelector('#blankScreenOverlay');
const blankScreenProgress = document.querySelector('#blankScreenProgress');
const msiDownload = document.querySelector('#msiDownload');
const browserShare = document.querySelector('#browserShare');
const localVideo = document.querySelector('#localVideo');
const accessConsentPanel = document.querySelector('#accessConsentPanel');
const accessConsent = document.querySelector('#accessConsent');
const joinModeTitle = document.querySelector('#joinModeTitle');
const stepOneText = document.querySelector('#stepOneText');
const stepTwoText = document.querySelector('#stepTwoText');
const downloadHelp = document.querySelector('#downloadHelp');
const successMessage = document.querySelector('#successMessage');
const successDetail = document.querySelector('#successDetail');
const protectedStep = document.querySelector('.protected-step');
const elevatedConsent = document.querySelector('.download-panel > .access-consent:not(#accessConsentPanel)');
const mobileAppFallback = document.querySelector('#mobileAppFallback');
const mobileAppLink = document.querySelector('#mobileAppLink');
const mobileAppDetail = document.querySelector('#mobileAppDetail');
const copyMobileAppLink = document.querySelector('#copyMobileAppLink');
const mobileAppInstall = document.querySelector('#mobileAppInstall');


const params = new URLSearchParams(location.search);
const savedJoin = JSON.parse(localStorage.getItem('remoteSupportLastJoin') || 'null');
const codeFromUrl = (params.get('code') || '').trim();
if (codeFromUrl) {
  code.value = codeFromUrl;
} else if (savedJoin?.joinCode) {
  code.value = savedJoin.joinCode;
}

let nativePoll;
let activeSessionId = codeFromUrl && savedJoin?.joinCode !== codeFromUrl ? '' : savedJoin?.sessionId || '';
let activeCustomerToken = codeFromUrl && savedJoin?.joinCode !== codeFromUrl ? '' : savedJoin?.customerJoinToken || '';
let setupLauncherName = savedJoin?.setupFileName || 'supportdesk.ClientSetup.exe';
let pendingDownloadUrl = savedJoin?.downloadUrl || '';
let pendingAlternateDownloadUrl = savedJoin?.alternateDownloadUrl || '';
let pendingPermanentAccess = Boolean(savedJoin?.permanentAccess);
let pendingAuthorizationToken = savedJoin?.authorizationToken || '';
let pendingMobileSupport = savedJoin?.mobileSupport || null;
let joinStartedAt = Number(savedJoin?.savedAt || 0);
let browserWs;
let browserStream;
let browserFrameTimer;
let browserHeartbeatTimer;
let browserFrameSequence = 0;
let browserFirstFrameSent = false;
let currentPlatform = detectPlatform();

function detectPlatform() {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const touchMac = /Mac/i.test(platform) && navigator.maxTouchPoints > 1;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua) || touchMac) return 'ios';
  if (/Mac/i.test(platform)) return 'macos';
  if (/Win/i.test(platform)) return 'windows';
  if (/Linux/i.test(platform)) return 'linux';
  return 'unknown';
}

function isMobilePlatform() {
  return currentPlatform === 'android' || currentPlatform === 'ios';
}

function supportsScreenCapture() {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getDisplayMedia);
}


function requiresNativeMobileBroadcast() {
  return isMobilePlatform() && !supportsScreenCapture();
}

function prefersBrowserJoin() {
  // Mobile customers must always follow browser/app broadcast flow, never Windows installer flow.
  if (isMobilePlatform()) return true;
  return currentPlatform === 'macos' || !pendingDownloadUrl;
}

function effectiveJoinCode() {
  return normalizeEnteredCode(code?.value || '') || normalizeEnteredCode(savedJoin?.joinCode || '') || '';
}

function mobileAppFallbackUrl(sessionId, token) {
  if (pendingMobileSupport?.screenconnectDeepLink) return pendingMobileSupport.screenconnectDeepLink;
  if (pendingMobileSupport?.deepLink) return pendingMobileSupport.deepLink;
  if (pendingMobileSupport?.universalLink) return pendingMobileSupport.universalLink;
  try {
    const base = 'supportdesk://join';
    const url = new URL(base);
    url.searchParams.set('server', location.origin);
    url.searchParams.set('sessionId', sessionId);
    url.searchParams.set('token', token);
    url.searchParams.set('platform', currentPlatform);
    url.searchParams.set('client', currentPlatform === 'ios' ? 'ios-mobile-broadcast' : 'android-mobile-broadcast');
    return url.toString();
  } catch {
    return '#';
  }
}


function clientCapabilities() {
  return {
    browserShare: true,
    nativeInstall: currentPlatform === 'windows',
    screenCapture: supportsScreenCapture(),
    mobileAppBroadcast: requiresNativeMobileBroadcast(),
    remoteControl: currentPlatform !== 'ios'
  };
}

function setMessage(text) {
  message.textContent = text;
}

function setBlankScreen(payload) {
  const enabled = Boolean(payload?.enabled);
  blankScreenOverlay.hidden = !enabled;
  blankScreenProgress.textContent = `Session in progress`;
  document.documentElement.style.overflow = enabled ? 'hidden' : '';
}

function startDownload(url) {
  if (!url) return;
  setupDownload.href = url;
  setupDownload.removeAttribute('download');
  setupDownload.click();
  window.setTimeout(() => {
    if (!document.hidden && !downloadPanel.hidden) {
      controlMessage.textContent = `If the download did not start, use Download EXE, open ${setupLauncherName}, and approve Windows UAC only if you requested this support session.`;
      if (pendingAlternateDownloadUrl && setupDownload.href !== pendingAlternateDownloadUrl) {
        setupDownload.href = pendingAlternateDownloadUrl;
        controlMessage.textContent = `Connection troubleshooting: if the remote support client download did not start, use Download EXE again. The retry link now uses the alternate server.`;
      }
    }
  }, 1200);
}

function rememberJoin(joinCode, data) {
  localStorage.setItem('remoteSupportLastJoin', JSON.stringify({
    joinCode,
    sessionId: data.sessionId,
    customerJoinToken: data.customerJoinToken,
    downloadUrl: data.downloadUrl || '',
    alternateDownloadUrl: data.alternateDownloadUrl || '',
    msiUrl: data.msiUrl || '',
    alternateMsiUrl: data.alternateMsiUrl || '',
    setupFileName: data.setupFileName || setupLauncherName,
    mobileSupport: data.mobileSupport || pendingMobileSupport || null,
    permanentAccess: Boolean(data.permanentAccess),
    authorizationToken: data.authorizationToken || pendingAuthorizationToken || '',
    savedAt: Date.now()
  }));
  joinStartedAt = Date.now();
}

function updateAccessConsentUi(permanentAccess) {
  pendingPermanentAccess = Boolean(permanentAccess);
  if (!accessConsentPanel || !accessConsent) return;
  accessConsentPanel.hidden = !pendingPermanentAccess;
  accessConsent.required = false;
  if (!pendingPermanentAccess) accessConsent.checked = false;
}

function canDownloadSetup() {
  return true;
}

function showSuccess() {
  joinForm.hidden = true;
  downloadPanel.hidden = true;
  successPanel.hidden = false;
  clearInterval(nativePoll);
}

function setWindowsInstallHelpVisible(visible) {
  if (elevatedConsent) elevatedConsent.hidden = !visible;
  if (protectedStep) protectedStep.hidden = !visible;
}

function showBrowserJoinPanel(data = {}) {
  pendingMobileSupport = data.mobileSupport || pendingMobileSupport || null;
  const joinCodeText = effectiveJoinCode();
  joinForm.hidden = true;
  downloadPanel.hidden = false;
  successPanel.hidden = true;
  code.value = joinCodeText;
  setMessage('Support code accepted.');
  setWindowsInstallHelpVisible(false);
  joinModeTitle.textContent = currentPlatform === 'ios'
    ? 'iPhone/iPad screen sharing'
    : isMobilePlatform() ? 'Mobile screen broadcast' : 'Browser screen sharing';

  if (currentPlatform === 'ios') {
    const h1 = downloadPanel.querySelector('h1');
    if (h1) h1.textContent = 'Join Session (ConnectWise Control App)';
  } else if (currentPlatform === 'android') {
    const h1 = downloadPanel.querySelector('h1');
    if (h1) h1.textContent = 'Join Session (ConnectWise Control App)';
  }

  stepOneText.textContent = supportsScreenCapture()
    ? 'Tap Start Broadcast / Share Screen and approve the phone screen-capture prompt.'
    : 'Use the ConnectWise Control app to join this support session.';
  stepTwoText.textContent = supportsScreenCapture()
    ? 'Keep this page open after broadcasting starts so the technician can view the screen frames.'
    : 'In ConnectWise Control app, enter Customer URL, enter the support code, then start screen share/broadcast.';
  downloadHelp.textContent = isMobilePlatform()
    ? 'Mobile customer flow: Open ConnectWise Control app → enter Customer URL → enter support code → start screen share/broadcast.'
    : 'If browser sharing is unavailable, use the installer option on Windows or ask the technician for another connection method.';
  controlMessage.textContent = supportsScreenCapture()
    ? 'Tap Start Broadcast / Share Screen to begin sending frames to the host.'
    : 'Open ConnectWise Control app and join with Customer URL + support code, then start screen sharing.';
  const canShare = supportsScreenCapture();
  if (canShare) {
    stepOneText.textContent = isMobilePlatform()
      ? 'Tap Start Broadcast / Share Screen and approve the phone screen-capture prompt.'
      : 'Tap Start Broadcast / Share Screen and approve the screen-capture prompt.';
    stepTwoText.textContent = 'Keep this page open after broadcasting starts so the technician can view the screen frames.';
    controlMessage.textContent = 'Tap Start Broadcast / Share Screen to begin sending frames to the host.';
  } else if (currentPlatform === 'ios') {
    stepOneText.textContent = '1 Open ConnectWise Control app on iPhone/iPad.';
    stepTwoText.textContent = `2 Enter Customer URL (${location.origin}), then enter support code ${joinCodeText}, then tap Start Broadcast.`;
    downloadHelp.textContent = 'If prompted by Apple, confirm Screen Broadcast permission to start sending frames.';
    controlMessage.textContent = 'Use ConnectWise Control app: Customer URL → support code → Start Broadcast.';
  } else if (currentPlatform === 'android') {
    stepOneText.textContent = '1 Open ConnectWise Control app on Android.';
    stepTwoText.textContent = `2 Enter Customer URL (${location.origin}), then enter support code ${joinCodeText}, then start screen sharing and approve prompts.`;
    downloadHelp.textContent = 'Grant required Android permissions (screen capture/accessibility) when prompted by the app.';
    controlMessage.textContent = 'Use ConnectWise Control app: Customer URL → support code → start screen sharing.';
  } else if (isMobilePlatform()) {
    downloadHelp.textContent = 'The host can view the phone only after screen broadcast starts and frames reach the relay.';
  }
  const strictIosNativeAppPath = currentPlatform === 'ios' && !supportsScreenCapture();
  setupDownload.hidden = currentPlatform === 'ios' || !data.downloadUrl;
  msiDownload.hidden = true;
  browserShare.hidden = false;

  // On mobile without screen capture: direct users to ConnectWise Control app
  if (!supportsScreenCapture() && isMobilePlatform()) {
    browserShare.textContent = 'Open ConnectWise Control App';
    browserShare.disabled = false;
    const installUrl = pendingMobileSupport?.installUrl || '';
    if (mobileAppInstall && installUrl) {
      mobileAppInstall.hidden = false;
      mobileAppInstall.href = installUrl;
      mobileAppInstall.textContent = currentPlatform === 'ios'
        ? 'Install from App Store'
        : 'Install from Google Play';
    }
  } else {
    browserShare.textContent = supportsScreenCapture()
      ? 'Start Broadcast / Share Screen'
      : 'Screen broadcast unavailable';
    browserShare.disabled = !supportsScreenCapture();
  }
  if (data.downloadUrl) setupDownload.href = data.downloadUrl;

  // If mobile browser screen capture is not available, show the mobile app fallback.
  if (mobileAppFallback && mobileAppLink) {
    const isMobile = isMobilePlatform();
    // Always show mobile app fallback on mobile devices, even if browser sharing is technically "supported",
    // because mobile browser sharing is often unreliable or restricted.
    mobileAppFallback.hidden = !isMobile;
    if (!mobileAppFallback.hidden && activeSessionId && activeCustomerToken) {
      mobileAppLink.href = mobileAppFallbackUrl(activeSessionId, activeCustomerToken);
      mobileAppLink.textContent = 'Open ConnectWise Control app';
      if (mobileAppDetail) {
        mobileAppDetail.textContent = currentPlatform === 'ios'
          ? `In ConnectWise Control app: Enter Customer URL (${location.origin}), enter support code ${joinCodeText}, then tap Start Broadcast.`
          : `In ConnectWise Control app: Enter Customer URL (${location.origin}), enter support code ${joinCodeText}, then start screen sharing and approve permissions.`;
      }
    }
  }


  if (!browserWs || browserWs.readyState === WebSocket.CLOSED || browserWs.readyState === WebSocket.CLOSING) {
    openBrowserSocket({ streamScreen: false });
  }

  if (strictIosNativeAppPath && activeSessionId && activeCustomerToken) {
    window.setTimeout(() => {
      if (!downloadPanel || downloadPanel.hidden) return;
      if (browserFirstFrameSent) return;
      controlMessage.textContent = 'Still waiting for iOS app broadcast. Open iOS support app: Visit Host URL, Enter Code, Initiate ScreenShare, then tap Start Broadcast.';
      setMessage('iOS app broadcast has not started yet.');
    }, 12000);
  }
}

function customerWebSocketUrl() {
  const url = new URL(location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/';

  // The browser customer must use a distinct client kind from the native mobile
  // broadcast apps. When both used 'android-mobile-broadcast'/'ios-mobile-broadcast',
  // the server's "replace same-kind customer" logic kicked the browser and native app
  // out in a loop, and the customerSocketId message gate silently dropped frames from
  // whichever customer socket was not the most-recently-recorded one. Using
  // 'browser-broadcast' keeps the browser join page coexisting with the native app so
  // the native app's screen.frame messages are relayed to the host instead of dropped.
  const client = 'browser-broadcast';

  url.search = new URLSearchParams({
    role: 'customer',
    client,
    sessionId: activeSessionId,
    token: activeCustomerToken
  }).toString();
  return url.toString();
}



// Host-triggered screen share prompt — shown when the host opens the customer session
function showScreenSharePrompt() {
  if (browserFirstFrameSent) return; // Already sharing
  if (!downloadPanel || downloadPanel.hidden) return;

  // Create a full-screen overlay prompt that requires a user tap (user gesture)
  // so getDisplayMedia can be called from within the tap handler
  let overlay = document.getElementById('screenSharePromptOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'screenSharePromptOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:32px 24px;max-width:380px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
        <div style="font-size:48px;margin-bottom:12px;">📱</div>
        <h2 style="margin:0 0 8px;font-size:20px;color:#111;">Technician wants to view your screen</h2>
        <p style="margin:0 0 20px;color:#555;font-size:14px;line-height:1.5;">Your support technician has requested to view your screen. Tap the button below to start sharing.</p>
        <button id="screenSharePromptAccept" style="width:100%;padding:14px 24px;font-size:17px;font-weight:600;color:#fff;background:#007AFF;border:none;border-radius:12px;cursor:pointer;margin-bottom:10px;">Start Screen Share</button>
        <button id="screenSharePromptDecline" style="width:100%;padding:10px 24px;font-size:14px;color:#666;background:transparent;border:1px solid #ddd;border-radius:12px;cursor:pointer;">Not now</button>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('screenSharePromptAccept').addEventListener('click', () => {
      overlay.remove();
      // This is a direct user gesture (tap) — getDisplayMedia will work here
      startBrowserShare().catch((err) => {
        setMessage('Screen broadcast did not start.');
        controlMessage.textContent = err?.message || 'Screen sharing was denied or failed.';
        stopBrowserShare();
        if (activeSessionId && activeCustomerToken) openBrowserSocket({ streamScreen: false });
      });
    });

    document.getElementById('screenSharePromptDecline').addEventListener('click', () => {
      overlay.remove();
      controlMessage.textContent = 'Screen share request declined. The technician may request again.';
    });
  }

  // Also make the share button prominent
  if (browserShare) {
    browserShare.textContent = 'Start Screen Share';
    browserShare.disabled = false;
    browserShare.style.background = '#007AFF';
    browserShare.style.color = '#fff';
  }
  setMessage('Your technician is ready to help.');
  controlMessage.textContent = 'Tap "Start Screen Share" to let the technician view your screen.';
}

function stopBrowserShare() {
  clearInterval(browserFrameTimer);
  browserFrameTimer = null;
  clearInterval(browserHeartbeatTimer);
  browserHeartbeatTimer = null;
  browserWs?.close();
  browserWs = null;
  browserStream?.getTracks().forEach((track) => track.stop());
  browserStream = null;
  browserFirstFrameSent = false;
  localVideo?.classList.remove('is-visible');
  if (localVideo) localVideo.hidden = true;
  if (browserShare) {
    browserShare.disabled = !supportsScreenCapture();
    browserShare.textContent = supportsScreenCapture()
      ? 'Start Broadcast / Share Screen'
      : currentPlatform === 'ios'
        ? 'Open app to share screen'
        : 'Screen broadcast unavailable';
  }
}

function openBrowserSocket({ streamScreen }) {
  if (browserWs && (browserWs.readyState === WebSocket.OPEN || browserWs.readyState === WebSocket.CONNECTING)) {
    // If socket already exists and we are now starting streaming, immediately announce starting state.
    if (streamScreen && browserWs.readyState === WebSocket.OPEN) {
      const isMobileBroadcastClient = requiresNativeMobileBroadcast() || (currentPlatform === 'ios' && !supportsScreenCapture());
      browserWs.send(JSON.stringify({
        type: 'screen.broadcast.status',
        payload: {
          status: 'starting',
          platform: currentPlatform,
          screenCapture: supportsScreenCapture(),
          message: 'Customer approved screen broadcast. Waiting for the first screen frame.',
          requiresNativeApp: currentPlatform === 'ios' && !supportsScreenCapture(),
          mobileAppRequired: Boolean(requiresNativeMobileBroadcast()),
          mobileSupport: pendingMobileSupport || null,
          isMobileBroadcastClient
        }
      }));
      // Start the frame timer if it's not already running.
      if (typeof startBrowserFrameCapture === 'function') {
        startBrowserFrameCapture();
      }
    }
    return;
  }

  browserWs = new WebSocket(customerWebSocketUrl());
  browserWs.addEventListener('open', () => {
    browserFirstFrameSent = false;
    const isMobileBroadcastClient = requiresNativeMobileBroadcast() || (currentPlatform === 'ios' && !supportsScreenCapture());
    let waitingStatus;
    let waitingMessage;
    if (streamScreen) {
      waitingStatus = 'starting';
      waitingMessage = 'Customer approved screen broadcast. Waiting for the first screen frame.';
    } else if (supportsScreenCapture()) {
      waitingStatus = 'waiting';
      waitingMessage = 'Customer connected. Tap Start Broadcast / Share Screen so the host can view this device.';
    } else if (currentPlatform === 'ios') {
      waitingStatus = 'ios_native_app_required';
      waitingMessage = 'Customer connected from iPhone/iPad. Open the iOS support app: Visit Host URL, Enter Code, Initiate ScreenShare, then Start Broadcast.';
    } else if (currentPlatform === 'android') {
      waitingStatus = 'android_native_app_required';
      waitingMessage = 'Customer connected from Android. Open the mobile support app and start screen broadcast to share the screen.';
    } else {
      waitingStatus = 'browser_screen_capture_unavailable';
      waitingMessage = 'Customer connected. Screen capture is not available in this browser.';
    }

    browserWs.send(JSON.stringify({
      type: 'screen.broadcast.status',
      payload: {
        status: waitingStatus,
        platform: currentPlatform,
        screenCapture: supportsScreenCapture(),
        message: waitingMessage,
        requiresNativeApp: currentPlatform === 'ios' && !supportsScreenCapture(),
        mobileAppRequired: Boolean(requiresNativeMobileBroadcast()),
        mobileSupport: pendingMobileSupport || null,
        isMobileBroadcastClient
      }
    }));

    clearInterval(browserHeartbeatTimer);
    browserHeartbeatTimer = setInterval(() => {
      if (!browserWs || browserWs.readyState !== WebSocket.OPEN) return;
      browserWs.send(JSON.stringify({
        type: 'screen.heartbeat',
        payload: {
          platform: currentPlatform,
          status: browserFirstFrameSent ? 'live' : 'waiting_first_frame',
          transport: requiresNativeMobileBroadcast() ? 'native-mobile-app' : 'browser-share'
        }
      }));
    }, 5000);

    if (streamScreen) {
      startBrowserFrameCapture();
    }
  });

  browserWs.addEventListener('message', (event) => {
    let messageData;
    try {
      messageData = JSON.parse(event.data);
    } catch {
      return;
    }
    if (messageData.type === 'blank-screen') setBlankScreen(messageData.payload);
    if (messageData.type === 'session.end') stopBrowserShare();
    // Host requested screen share — show a prominent prompt to the customer
    if (messageData.type === 'screen.request') {
      showScreenSharePrompt();
    }
  });

  browserWs.addEventListener('close', () => {
    clearInterval(browserFrameTimer);
    browserFrameTimer = null;

    // Attempt to reconnect signaling channel if the page is still active.
    if (activeSessionId && activeCustomerToken && downloadPanel && !downloadPanel.hidden) {
      const delay = browserFirstFrameSent ? 3000 : 1000;
      window.setTimeout(() => {
        if (browserWs && (browserWs.readyState === WebSocket.OPEN || browserWs.readyState === WebSocket.CONNECTING)) return;
        // If we were already sharing, try to resume if the stream is still active.
        const shouldResumeStream = Boolean(browserStream && browserStream.active);
        if (browserFirstFrameSent && !shouldResumeStream) {
          setMessage('Screen broadcast stopped.');
          browserFirstFrameSent = false;
        }
        openBrowserSocket({ streamScreen: shouldResumeStream });
      }, delay);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ScreenConnect-Quality Adaptive Screen Capture Engine
// Implements: multi-tier quality, delta detection, WebP/JPEG fallback,
// adaptive frame rate, bandwidth estimation, per-device resolution scaling
// ═══════════════════════════════════════════════════════════════════════════════

const SCCapture = {
  canvas: null,
  ctx: null,
  diffCanvas: null,
  diffCtx: null,
  prevImageData: null,
  lastFrameData: '',
  lastFrameSize: 0,
  framesSent: 0,
  bytesSent: 0,
  lastBandwidthCheck: 0,
  estimatedBandwidthKbps: 2000,
  consecutiveSkips: 0,
  maxConsecutiveSkips: 30,

  // Quality tiers (ScreenConnect uses similar adaptive quality).
  // `retina` (1440p) and `ultra` (1080p) are now the preferred desktop
  // starting points instead of defaulting straight to aggressive
  // downscaling — we only drop to `high`/`medium`/etc. if the adaptive
  // bandwidth/frame-size logic in adaptQuality() detects it's actually
  // needed, rather than starting there unconditionally.
  QUALITY_TIERS: {
    retina:  { maxWidth: 2560, quality: 0.95, fps: 15, format: 'webp', label: 'Retina (1440p)' },
    ultra:   { maxWidth: 1920, quality: 0.92, fps: 15, format: 'webp', label: 'Ultra (1080p)' },
    high:    { maxWidth: 1920, quality: 0.85, fps: 12, format: 'webp', label: 'High' },
    medium:  { maxWidth: 1280, quality: 0.75, fps: 10, format: 'jpeg', label: 'Medium' },
    low:     { maxWidth: 1024, quality: 0.60, fps: 8,  format: 'jpeg', label: 'Low' },
    minimal: { maxWidth: 800,  quality: 0.45, fps: 5,  format: 'jpeg', label: 'Minimal' },
  },

  currentTier: 'ultra',
  supportsWebP: false,

  init() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.diffCanvas = document.createElement('canvas');
    this.diffCtx = this.diffCanvas.getContext('2d', { willReadFrequently: true });
    this.supportsWebP = this.detectWebPSupport();
    this.selectInitialTier();
  },

  detectWebPSupport() {
    try {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      return c.toDataURL('image/webp').startsWith('data:image/webp');
    } catch { return false; }
  },

  selectInitialTier() {
    if (isMobilePlatform()) {
      // Mobile devices: start at high (not the old aggressive 'medium'
      // default) to conserve battery/bandwidth while still giving a
      // reasonably sharp starting image; adaptQuality() will step down
      // automatically if the network can't sustain it.
      this.currentTier = 'high';
    } else if (window.innerWidth >= 2560 || (window.screen && window.screen.width >= 2560)) {
      // Native display resolution supports 1440p+ — capture at full 1440p.
      this.currentTier = 'retina';
    } else {
      // Default desktop capture profile is 1080p ("ultra") quality instead
      // of the previous 'high' tier, which applied more aggressive
      // downscaling/compression by default.
      this.currentTier = 'ultra';
    }
  },

  getTierConfig() {
    const tier = this.QUALITY_TIERS[this.currentTier] || this.QUALITY_TIERS.ultra;
    // Fall back to JPEG if WebP not supported
    if (tier.format === 'webp' && !this.supportsWebP) {
      return { ...tier, format: 'jpeg', quality: Math.min(tier.quality + 0.05, 0.95) };
    }
    return tier;
  },

  adaptQuality(frameSizeBytes, sendTimeMs) {
    // Adaptive quality like ScreenConnect: adjust based on frame size and network speed
    const sizeKB = frameSizeBytes / 1024;
    const now = Date.now();

    if (sendTimeMs > 0) {
      const bitsPerSecond = (frameSizeBytes * 8) / (sendTimeMs / 1000);
      this.estimatedBandwidthKbps = Math.round(
        this.estimatedBandwidthKbps * 0.7 + (bitsPerSecond / 1000) * 0.3
      );
    }

    // Upgrade if frames are small and fast (more willing to step back up
    // toward retina/ultra once bandwidth proves it can sustain it, rather
    // than staying stuck at a downgraded tier).
    if (sizeKB < 60 && this.estimatedBandwidthKbps > 2500 && this.framesSent > 20) {
      this.upgradeTier();
    }
    // Only downgrade for genuinely large frames or clearly poor bandwidth —
    // thresholds raised so we don't aggressively downscale on transient
    // frame-size spikes (e.g. a single busy repaint) or normal broadband
    // conditions.
    else if (sizeKB > 350 || this.estimatedBandwidthKbps < 350) {
      this.downgradeTier();
    }
    else if (sizeKB > 220 && this.estimatedBandwidthKbps < 1000) {
      this.downgradeTier();
    }
  },

  upgradeTier() {
    const tiers = Object.keys(this.QUALITY_TIERS);
    const idx = tiers.indexOf(this.currentTier);
    if (idx > 0) {
      this.currentTier = tiers[idx - 1];
    }
  },

  downgradeTier() {
    const tiers = Object.keys(this.QUALITY_TIERS);
    const idx = tiers.indexOf(this.currentTier);
    if (idx < tiers.length - 1) {
      this.currentTier = tiers[idx + 1];
    }
  },

  // Delta detection: check if frame has changed significantly
  hasSignificantChange(imageData) {
    if (!this.prevImageData) {
      this.prevImageData = imageData;
      return true;
    }

    const prev = this.prevImageData.data;
    const curr = imageData.data;
    const len = Math.min(prev.length, curr.length);

    // Sample pixels for speed (check every 16th pixel = ~6% of pixels)
    let diffCount = 0;
    const sampleStep = 64; // 4 channels * 16 pixel skip
    const totalSamples = Math.floor(len / sampleStep);
    const threshold = 20; // Per-channel difference threshold

    for (let i = 0; i < len; i += sampleStep) {
      const dr = Math.abs(curr[i] - prev[i]);
      const dg = Math.abs(curr[i + 1] - prev[i + 1]);
      const db = Math.abs(curr[i + 2] - prev[i + 2]);
      if (dr > threshold || dg > threshold || db > threshold) {
        diffCount++;
      }
    }

    this.prevImageData = imageData;

    // If more than 0.5% of sampled pixels changed significantly
    const changeRatio = diffCount / totalSamples;
    return changeRatio > 0.005;
  },

  captureFrame(video) {
    if (!video || video.paused || video.ended || !video.videoWidth) return null;

    const tier = this.getTierConfig();
    const scale = Math.min(1, tier.maxWidth / video.videoWidth);
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));

    // Resize canvas only when dimensions change
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.prevImageData = null; // Reset delta detection on resize
    }

    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.drawImage(video, 0, 0, w, h);

    // Delta detection: skip if frame hasn't changed
    let imageData;
    try {
      imageData = this.ctx.getImageData(0, 0, w, h);
    } catch {
      imageData = null;
    }

    if (imageData && !this.hasSignificantChange(imageData)) {
      this.consecutiveSkips++;
      // Force a keyframe every N skips to prevent stale display
      if (this.consecutiveSkips < this.maxConsecutiveSkips) {
        return null; // No significant change
      }
    }
    this.consecutiveSkips = 0;

    const mimeType = tier.format === 'webp' ? 'image/webp' : 'image/jpeg';
    const dataUrl = this.canvas.toDataURL(mimeType, tier.quality);
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1);

    // Skip if identical to last frame (exact match)
    if (data === this.lastFrameData) return null;
    this.lastFrameData = data;

    const frameSize = Math.round(data.length * 0.75); // approximate decoded size
    this.lastFrameSize = frameSize;
    this.framesSent++;
    this.bytesSent += frameSize;

    return {
      format: tier.format,
      data,
      width: w,
      height: h,
      quality: tier.quality,
      tier: this.currentTier,
      frameSize,
      sequence: browserFrameSequence++
    };
  },

  getStats() {
    const tier = this.getTierConfig();
    return {
      tier: this.currentTier,
      tierLabel: tier.label,
      format: tier.format,
      fps: tier.fps,
      quality: tier.quality,
      maxWidth: tier.maxWidth,
      framesSent: this.framesSent,
      bytesSent: this.bytesSent,
      estimatedBandwidthKbps: this.estimatedBandwidthKbps,
      supportsWebP: this.supportsWebP,
    };
  }
};

function startBrowserFrameCapture() {
  if (browserFrameTimer) clearInterval(browserFrameTimer);

  controlMessage.textContent = 'Broadcast permission approved. Starting screen frames...';
  setMessage('');

  // Initialize the adaptive capture engine
  SCCapture.init();

  let lastSendTime = 0;

  function captureLoop() {
    if (browserWs?.readyState !== WebSocket.OPEN) {
      browserFrameTimer = setTimeout(captureLoop, 100);
      return;
    }

    if (!localVideo || localVideo.paused || localVideo.ended || !localVideo.videoWidth) {
      browserFrameTimer = setTimeout(captureLoop, 100);
      return;
    }

    const tier = SCCapture.getTierConfig();
    const intervalMs = Math.round(1000 / tier.fps);

    const sendStart = performance.now();
    const frame = SCCapture.captureFrame(localVideo);

    if (frame) {
      browserWs.send(JSON.stringify({
        type: 'screen.frame',
        payload: {
          format: frame.format,
          data: frame.data,
          width: frame.width,
          height: frame.height,
          quality: frame.quality,
          tier: frame.tier,
          sequence: frame.sequence,
          timestamp: Date.now()
        }
      }));

      const sendDuration = performance.now() - sendStart;
      SCCapture.adaptQuality(frame.frameSize, sendDuration);

      if (!browserFirstFrameSent) {
        browserFirstFrameSent = true;
        browserWs.send(JSON.stringify({
          type: 'screen.broadcast.status',
          payload: {
            status: 'live',
            platform: currentPlatform,
            message: 'Screen broadcast is live.',
            captureStats: SCCapture.getStats()
          }
        }));
        showSuccess();
        successMessage.textContent = 'You have successfully connected to your session.';
        successDetail.textContent = 'Keep this page open while your screen is shared with the technician. Close this page to disconnect.';
        browserShare.textContent = 'Broadcasting';
        browserShare.disabled = true;
      }
    }

    browserFrameTimer = setTimeout(captureLoop, intervalMs);
  }

  captureLoop();
}

async function startCameraShare() {
  if (!activeSessionId || !activeCustomerToken) {
    setMessage('Enter the support code first.');
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera access is not available in this browser.');
  }

  stopBrowserShare();
  browserShare.disabled = true;
  browserShare.textContent = 'Starting camera...';
  setMessage('Approve camera access to share your view with the technician.');

  browserStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', frameRate: 10, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });

  if (localVideo) {
    localVideo.srcObject = browserStream;
    localVideo.hidden = false;
    localVideo.classList.add('is-visible');
    await localVideo.play().catch(() => {});
  }

  const [track] = browserStream.getVideoTracks();
  track?.addEventListener('ended', stopBrowserShare);

  openBrowserSocket({ streamScreen: true });
}

async function startBrowserShare() {

  if (!activeSessionId || !activeCustomerToken) {
    setMessage('Enter the support code first.');
    return;
  }

  // Try getDisplayMedia first (screen sharing)
  if (supportsScreenCapture() && navigator.mediaDevices?.getDisplayMedia) {
    stopBrowserShare();
    browserShare.disabled = true;
    browserShare.textContent = 'Starting broadcast...';
    setMessage('Choose the screen or phone display to share.');

    try {
      // Request a higher-quality capture profile (ideal 1440p, minimum
      // acceptable 1080p) instead of only constraining frameRate. Browsers
      // will negotiate down to whatever the actual display supports, so
      // this is a ceiling/preference, not a hard requirement — it just
      // stops us from leaving quality on the table when 1080p/1440p+
      // displays are available.
      browserStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 15, max: 15 },
          width: { ideal: 2560, min: 1280 },
          height: { ideal: 1440, min: 720 }
        },
        audio: false
      });

      if (localVideo) {
        localVideo.srcObject = browserStream;
        localVideo.hidden = false;
        localVideo.classList.add('is-visible');
        await localVideo.play().catch(() => {});
      }

      const [track] = browserStream.getVideoTracks();
      track?.addEventListener('ended', stopBrowserShare);

      openBrowserSocket({ streamScreen: true });
      return;
    } catch (screenErr) {
      // getDisplayMedia failed (user denied, or not supported in this context).
      // On mobile, fall back to camera capture.
      if (isMobilePlatform() && navigator.mediaDevices?.getUserMedia) {
        setMessage('Screen sharing denied. Trying camera instead...');
        try {
          await startCameraShare();
          return;
        } catch (camErr) {
          // Camera also failed
          throw new Error('Screen sharing and camera access were both denied.');
        }
      }
      throw screenErr;
    }
  }

  // No getDisplayMedia available — try camera fallback on mobile
  if (isMobilePlatform() && navigator.mediaDevices?.getUserMedia) {
    try {
      await startCameraShare();
      return;
    } catch (camErr) {
      stopBrowserShare();
      setMessage('Camera access was denied.');
      controlMessage.textContent = currentPlatform === 'ios'
        ? 'Camera access denied. Use ConnectWise Control app: Visit Host URL, Enter Code, Start Broadcast.'
        : 'Camera access denied. Use ConnectWise Control app: Visit Host URL, Enter Code, Start Screen Share.';
      throw camErr;
    }
  }

  // Nothing available
  stopBrowserShare();
  setMessage('Screen broadcast is not available in this browser.');
  controlMessage.textContent = currentPlatform === 'ios'
    ? 'On iPhone/iPad, use the ConnectWise Control app: Visit Host URL, Enter Code, Initiate ScreenShare, then Start Broadcast.'
    : 'Open this link in a browser that supports screen sharing, or use the ConnectWise Control app.';
  throw new Error('Screen broadcast is not available in this browser.');
}

async function fetchTroubleshooting() {
  if (!activeSessionId || !activeCustomerToken) return null;
  try {
    const url = `/api/session/${encodeURIComponent(activeSessionId)}/troubleshooting?token=${encodeURIComponent(activeCustomerToken)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function troubleshootingMessage(data) {
  if (!data?.ok) return '';
  const session = data.session || {};
  if (data.lastJoinError) return `Remote support session not connecting: ${data.lastJoinError}`;
  if (session.permanentAccess && !session.permanentAccessAuthorizedAt) {
    return 'Authorization is still required before unattended access can start.';
  }
  if (isMobilePlatform()) {
    if (session.customerScreenStatus === 'ios_broadcast_connected_waiting_first_frame') {
      return `iPhone connected but no screen frames yet. In app use URL ${location.origin} and code ${effectiveJoinCode()}, then start broadcast from iOS prompt.`;
    }
    if (session.customerScreenStatus === 'android_broadcast_connected_waiting_first_frame') {
      return `Android connected but no screen frames yet. In app use URL ${location.origin} and code ${effectiveJoinCode()}, then approve screen capture permissions.`;
    }
    if (session.customerScreenStatus === 'reconnect_required' || session.customerScreenStatus === 'stream_stale') {
      return 'Mobile broadcast disconnected/stale. Re-open the app and restart screen broadcast.';
    }
  }
  if (session.nativeClaimed && !session.nativeConnected) {
    return 'Client started but has not connected yet. Check firewall, antivirus, SSL/TLS, and reverse proxy WebSocket settings.';
  }
  if (session.blankScreen) return 'The remote screen is currently blanked by the technician.';
  if (session.permissions?.input === false) return 'Remote keyboard and mouse input is currently suspended.';
  return data.guidance?.ifStuckConnecting || '';
}

async function pollNativeConnection() {
  if (!activeSessionId || !activeCustomerToken) return;

  const statusPath = `/api/session/${encodeURIComponent(activeSessionId)}/customer-status?token=${encodeURIComponent(activeCustomerToken)}`;

  let response;
  try {
    response = await fetch(statusPath, {
      headers: { Accept: 'application/json' }
    });
  } catch {
    if (downloadPanel && !downloadPanel.hidden) {
      controlMessage.textContent = 'Could not reach the support server. Check internet, firewall, or security software, then retry.';
    }
    return;
  }

  if (response.status === 401 || response.status === 404) {
    localStorage.removeItem('remoteSupportLastJoin');
    activeSessionId = '';
    activeCustomerToken = '';
    joinForm.hidden = false;
    downloadPanel.hidden = true;
    successPanel.hidden = true;
    setMessage('This support link is no longer valid. Enter the current code from your technician.');
    join.disabled = false;
    clearInterval(nativePoll);
    return;
  }

  if (!response.ok) return;

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    if (downloadPanel && !downloadPanel.hidden) {
      controlMessage.textContent = 'Unexpected response from support server. Please retry, or ask your technician to verify server/domain health.';
    }
    return;
  }

  let data;
  try {
    data = await response.json();
  } catch {
    if (downloadPanel && !downloadPanel.hidden) {
      controlMessage.textContent = 'Could not read session status response. Please retry.';
    }
    return;
  }

  if (data.nativeConnected) {
    showSuccess();
    if (successMessage && successDetail) {
      if (isMobilePlatform()) {
        successMessage.textContent = 'You have successfully joined the session.';
        successDetail.textContent = currentPlatform === 'ios'
          ? 'Your iPhone/iPad screen is now being shared with the technician. Keep this page open until the technician ends the session.'
          : 'Your phone screen is now being shared with the technician. Keep this page open until the technician ends the session.';
      } else {
        successMessage.textContent = 'You have successfully connected to your session.';
        successDetail.textContent = 'Keep this page open while your screen is shared with the technician. Close this page to disconnect.';
      }
    }
    controlMessage.textContent = isMobilePlatform()
      ? 'Mobile screen broadcast connected. Keep this page open while the technician is assisting.'
      : 'Support client connected. Keep this window open while the technician is assisting.';
    return;
  }

  if (data.nativeClaimed) {
    setMessage('Support client installer started');
    controlMessage.textContent = 'Client stuck on connecting: keep the customer support app open while the remote support session connects.';
    return;
  }

  if (data.lastJoinError) {
    setMessage('Join failed');
    controlMessage.textContent = `Remote support session not connecting: ${data.lastJoinError}`;
    return;
  }

  if (downloadPanel && !downloadPanel.hidden) {
    if (joinStartedAt && Date.now() - joinStartedAt > 15000) {
      const diagnostics = await fetchTroubleshooting();
      const diagnosticMessage = troubleshootingMessage(diagnostics);
      controlMessage.textContent = diagnosticMessage || 'Connection troubleshooting: client stuck on connecting. Check firewall blocking remote support client, antivirus blocking remote support application, SSL/TLS certificate mismatch, or Cloudflare reverse proxy WebSocket issue.';
    }
  }
}

// NOTE: the rest of the old function body removed by replacement above.

// (removed accidental duplicate joinSession/poll remnants) 

function normalizeEnteredCode(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';

  const numeric = value.replace(/\D+/g, '').slice(0, 12);
  if (numeric) return numeric;

  return value
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .slice(0, 16);
}

async function joinSession() {
  const enteredCode = code.value;
  const sessionId = normalizeEnteredCode(enteredCode);
  if (!sessionId) {
    setMessage('Enter the support code first.');
    return;
  }

  code.value = sessionId;
  join.disabled = true;
  setMessage('Checking support code...');

  const attemptedAt = Date.now();
  const joinEndpoint = `/api/session/${encodeURIComponent(sessionId)}/join`;
  localStorage.setItem('remoteSupportLastAttemptedCode', sessionId);

  let response;
  const payload = {
    platform: currentPlatform,
    capabilities: clientCapabilities()
  };

  try {
    response = await fetch(joinEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch {
    response = null;
  }

  if (!response || !response.ok) {
    try {
      response = await fetch(joinEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch {
      response = null;
    }
  }

  if (!response) {
    join.disabled = false;
    throw new Error('Could not reach support server. Check connection and try again.');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    join.disabled = false;
    if (response.status === 428 && data.code === 'PERMANENT_ACCESS_AUTHORIZATION_REQUIRED') {
      const isPermanentFlow = Boolean(data.permanentAccess);
      if (isPermanentFlow && data.authorizationToken) {
        activeSessionId = data.sessionId;
        activeCustomerToken = data.customerJoinToken;
        setupLauncherName = data.setupFileName || setupLauncherName;
        pendingPermanentAccess = true;
        pendingAuthorizationToken = data.authorizationToken;
        rememberJoin(sessionId, {
          sessionId: data.sessionId,
          customerJoinToken: data.customerJoinToken,
          setupFileName: setupLauncherName,
          permanentAccess: true,
          authorizationToken: pendingAuthorizationToken,
          downloadUrl: ''
        });

        joinForm.hidden = false;
        downloadPanel.hidden = true;
        successPanel.hidden = true;
        join.disabled = false;
        setMessage('Authorization required for unattended access');
        controlMessage.textContent = 'Check the authorization box to confirm unattended access.';
        updateAccessConsentUi(true);
        return;
      }

      throw new Error(data?.message || 'Session requires authorization before unattended access can continue.');
    }

    throw new Error(data?.message || 'Support code was not found.');
  }
  activeSessionId = data.sessionId;
  activeCustomerToken = data.customerJoinToken;
  setupLauncherName = data.setupFileName || setupLauncherName;
  pendingDownloadUrl = data.downloadUrl || '';
  pendingAlternateDownloadUrl = data.alternateDownloadUrl || '';
  pendingMobileSupport = data.mobileSupport || null;
  updateAccessConsentUi(data.permanentAccess);

  // Hard reset: ensure the poll uses the newly joined session+token.
  rememberJoin(sessionId, { ...data, authorizationToken: pendingAuthorizationToken });

  if (prefersBrowserJoin()) {
    // Always show the browser join panel first on all mobile platforms.
    // This ensures the WebSocket connection is opened (signaling channel),
    // the UI shows connection status/instructions, and the mobile app
    // fallback links are visible. Without this, Android phones without
    // getDisplayMedia support would stay stuck on the join form with no
    // WebSocket connection and no UI feedback.
    showBrowserJoinPanel(data);
    join.disabled = false;

    let popup = null;
    const appHref = mobileAppFallbackUrl(activeSessionId, activeCustomerToken);

    if (currentPlatform === 'ios') {
      if (supportsScreenCapture()) {
        // Do NOT auto-start getDisplayMedia on mobile — it requires a user gesture
        // (tap/click). Calling it from setTimeout will silently fail on iOS Safari.
        // Instead, prompt the user to tap the Share Screen button.
        setMessage('Tap "Start Broadcast / Share Screen" to begin.');
        controlMessage.textContent = 'Tap the Share Screen button below and approve the screen-capture prompt to share your screen with the technician.';
        browserShare.textContent = 'Start Broadcast / Share Screen';
        browserShare.disabled = false;
      } else {
        // iOS without screen capture: guide to ConnectWise Control app
        const installUrl = pendingMobileSupport?.installUrl || '';
        controlMessage.textContent = installUrl
          ? `Install ConnectWise Control from the App Store, then open it and enter Host URL: ${location.origin} and Code: ${effectiveJoinCode()}`
          : `Open ConnectWise Control app → enter Host URL: ${location.origin} → enter Code: ${effectiveJoinCode()} → Start Broadcast`;
        setMessage('ConnectWise Control app required for iOS.');
      }
    } else if (currentPlatform === 'android') {
      if (supportsScreenCapture()) {
        // Do NOT auto-start getDisplayMedia on mobile — it requires a user gesture.
        setMessage('Tap "Start Broadcast / Share Screen" to begin.');
        controlMessage.textContent = 'Tap the Share Screen button below and approve the screen-capture prompt to share your screen with the technician.';
        browserShare.textContent = 'Start Broadcast / Share Screen';
        browserShare.disabled = false;
      } else {
        // Android without screen capture: guide to ConnectWise Control app
        const installUrl = pendingMobileSupport?.installUrl || '';
        controlMessage.textContent = installUrl
          ? `Install ConnectWise Control from Google Play, then open it and enter Host URL: ${location.origin} and Code: ${effectiveJoinCode()}`
          : `Open ConnectWise Control app → enter Host URL: ${location.origin} → enter Code: ${effectiveJoinCode()} → Start Screen Share`;
        setMessage('ConnectWise Control app required for Android.');
      }
    }

    // Mobile customers going through the native app (Android/iOS) need to keep
    // polling customer-status so this page can show the "Join Success" panel
    // once the broadcast app delivers the first screen.frame and the relay marks
    // the session nativeConnected. The browser-share path also benefits if the
    // user later switches to the native stream without restarting the page.
    if (isMobilePlatform() || !supportsScreenCapture()) {
      clearInterval(nativePoll);
      nativePoll = setInterval(() => pollNativeConnection().catch(() => {}), 2000);
    }
    return;
  }

  if (!data.downloadUrl) {
    showBrowserJoinPanel(data);
    join.disabled = false;
    setMessage('Support code accepted.');
    return;
  }

  joinForm.hidden = true;
  downloadPanel.hidden = false;
  successPanel.hidden = true;
  controlMessage.textContent = data.permanentAccess
    ? `Start unattended access only with explicit authorization. Download and open ${setupLauncherName}, then approve Windows UAC only if you requested this remote support session.`
    : `Open ${setupLauncherName}, approve Windows UAC only if you requested this remote support session, and keep the customer support app open.`;
  joinModeTitle.textContent = 'Windows support client installer';
  stepOneText.textContent = 'Your browser should download the remote support client. Open the downloaded file to start the session.';
  stepTwoText.textContent = 'Approve the Windows UAC prompt only if you recognize this technician and requested remote support.';
  downloadHelp.textContent = 'Connection troubleshooting: if the client is stuck on connecting, retry the download or ask your technician to check firewall, antivirus, SSL/TLS, or reverse proxy WebSocket settings.';
  setWindowsInstallHelpVisible(true);
  setupDownload.hidden = false;
  msiDownload.hidden = false;
  browserShare.textContent = 'Share screen in browser';
  browserShare.disabled = false;
  setupDownload.href = data.downloadUrl || '#';
  setupDownload.removeAttribute('download');
  if (msiDownload) msiDownload.href = data.msiUrl || data.alternateMsiUrl || data.downloadUrl || data.alternateDownloadUrl || '#';
  setMessage('');

  startDownload(data.downloadUrl);
  clearInterval(nativePoll);
  nativePoll = setInterval(() => pollNativeConnection().catch(() => {}), 2000);
}


joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (join.disabled) return;
  join.disabled = true;
  stopBrowserShare();
  joinSession().catch((err) => {
    setMessage(err.message || 'Could not join support session. Check the code and try again.');
    join.disabled = false;
  });
});

setupDownload.addEventListener('click', (event) => {
  if (!canDownloadSetup()) {
    event.preventDefault();
    return;
  }
  controlMessage.textContent = `After the remote support client download finishes, open ${setupLauncherName}, approve Windows UAC, and keep the customer support app open.`;
});

msiDownload?.addEventListener('click', (event) => {
  if (!canDownloadSetup()) {
    event.preventDefault();
    return;
  }
  controlMessage.textContent = `After the remote support client download finishes, open ${setupLauncherName}, approve Windows UAC, and keep the customer support app open.`;
});

async function authorizePermanentAccessIfNeeded() {
  if (!pendingPermanentAccess) return true;
  if (!pendingAuthorizationToken) {
    // If we don't have a token yet, user must re-join the session.
    setMessage('Authorization required');
    controlMessage.textContent = 'Re-enter the support code to request an authorization token.';
    return false;
  }

  try {
    const res = await fetch(`/api/session/${encodeURIComponent(activeSessionId)}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-token': activeCustomerToken },
      body: JSON.stringify({
        token: activeCustomerToken,
        authorizationToken: pendingAuthorizationToken
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const code = data.code ? ` (${data.code})` : '';
      throw new Error(data?.message || `Authorization failed${code}`);
    }

    setMessage('Authorization confirmed');
    controlMessage.textContent = `Authorization confirmed. Download and open ${setupLauncherName}, then approve Windows UAC.`;
    return true;
  } catch (err) {
    setMessage('Authorization failed');
    controlMessage.textContent = err?.message || 'Could not confirm authorization. Please try again.';
    return false;
  }
}

accessConsent?.addEventListener('change', async () => {
  if (!pendingPermanentAccess || !accessConsent.checked) return;

  const ok = await authorizePermanentAccessIfNeeded();
  if (!ok) {
    // keep checkbox checked state but UI indicates failure; user can retry
    return;
  }

  if (pendingDownloadUrl) setupDownload.href = pendingDownloadUrl;
});

browserShare?.addEventListener('click', () => {
  // If this browser can't start screen broadcast, open ConnectWise Control app
  if (!supportsScreenCapture()) {
    const href = mobileAppFallbackUrl(activeSessionId, activeCustomerToken);
    if (href && href !== '#') {
      setMessage('Opening ConnectWise Control...');
      controlMessage.textContent = currentPlatform === 'ios'
        ? `In ConnectWise Control: enter Host URL ${location.origin}, Code ${effectiveJoinCode()}, then tap Start Broadcast.`
        : `In ConnectWise Control: enter Host URL ${location.origin}, Code ${effectiveJoinCode()}, then start screen sharing.`;
      window.open(href, '_blank', 'noopener');

      // Show install link after a delay if the app didn't open
      const installUrl = pendingMobileSupport?.installUrl || '';
      if (installUrl) {
        window.setTimeout(() => {
          if (!document.hidden && downloadPanel && !downloadPanel.hidden) {
            controlMessage.textContent = `If ConnectWise Control did not open, install it first: ${currentPlatform === 'ios' ? 'App Store' : 'Google Play'}`;
            if (mobileAppInstall) {
              mobileAppInstall.hidden = false;
              mobileAppInstall.href = installUrl;
              mobileAppInstall.textContent = currentPlatform === 'ios' ? 'Install from App Store' : 'Install from Google Play';
            }
          }
        }, 2000);
      }
      return;
    }
  }

  startBrowserShare().catch((err) => {
    setMessage('Screen broadcast did not start.');
    controlMessage.textContent = err?.message || 'Screen sharing was not approved. The host will not be able to view this phone until broadcast starts.';
    stopBrowserShare();
    if (activeSessionId && activeCustomerToken) openBrowserSocket({ streamScreen: false });
  });
});

copyMobileAppLink?.addEventListener('click', async () => {
  const href = mobileAppFallbackUrl(activeSessionId, activeCustomerToken);
  if (!href || href === '#') return;
  await navigator.clipboard.writeText(href);
  controlMessage.textContent = 'Mobile app connection link copied. Open it on the customer device after installing the support app.';
});

mobileAppLink?.addEventListener('click', () => {
  const installUrl = pendingMobileSupport?.installUrl || '';
  const joinCodeText = effectiveJoinCode();
  controlMessage.textContent = currentPlatform === 'ios'
    ? `Opening the iOS support app. In app use URL ${location.origin}, code ${joinCodeText}, then tap Start Broadcast.`
    : `Opening the mobile support app. In app use URL ${location.origin}, code ${joinCodeText}, then approve screen sharing prompts.`;
  if (!installUrl) return;
  window.setTimeout(() => {
    if (!document.hidden) {
      controlMessage.textContent = `If the support app did not open, install it first: ${installUrl}`;
    }
  }, 1500);
});

document.querySelector('.success-close')?.addEventListener('click', () => {
  successPanel.hidden = true;
  joinForm.hidden = false;
  join.disabled = false;
});

window.addEventListener('beforeunload', () => setBlankScreen({ enabled: false }));
window.addEventListener('beforeunload', stopBrowserShare);

code?.addEventListener('input', () => {
  const normalized = normalizeEnteredCode(code.value);
  if (code.value !== normalized) code.value = normalized;
});

if (codeFromUrl) {
  joinSession().catch((err) => {
    setMessage(err.message);
    join.disabled = false;
  });
}

// Auto-open ConnectWise Control app when customer landed by code on mobile
window.addEventListener('load', () => {
  if (!codeFromUrl) return;
  if (!isMobilePlatform() || supportsScreenCapture()) return;
  window.setTimeout(() => {
    if (!activeSessionId || !activeCustomerToken) return;
    if (downloadPanel?.hidden) return;
    const href = mobileAppFallbackUrl(activeSessionId, activeCustomerToken);
    if (!href || href === '#') return;

    setMessage('Opening ConnectWise Control app...');
    controlMessage.textContent = currentPlatform === 'ios'
      ? `Opening ConnectWise Control. In app: enter Host URL ${location.origin}, Code ${effectiveJoinCode()}, then Start Broadcast.`
      : `Opening ConnectWise Control. In app: enter Host URL ${location.origin}, Code ${effectiveJoinCode()}, then start screen sharing.`;
    window.open(href, '_blank', 'noopener');

    // Show install link after delay
    const installUrl = pendingMobileSupport?.installUrl || '';
    if (installUrl) {
      window.setTimeout(() => {
        if (!document.hidden && downloadPanel && !downloadPanel.hidden) {
          controlMessage.textContent = `If ConnectWise Control did not open, install it first.`;
          if (mobileAppInstall) {
            mobileAppInstall.hidden = false;
            mobileAppInstall.href = installUrl;
            mobileAppInstall.textContent = currentPlatform === 'ios' ? 'Install from App Store' : 'Install from Google Play';
          }
        }
      }, 2500);
    }
  }, 800);
});
