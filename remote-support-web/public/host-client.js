const remoteTitle = document.querySelector('#remoteTitle');
const remoteFrame = document.querySelector('#remoteFrame');
const remoteEmpty = document.querySelector('#remoteEmpty');
const remoteScreen = document.querySelector('#remoteScreen');
const remoteStatus = document.querySelector('#remoteStatus');
const remoteStatusMessage = document.querySelector('#remoteStatusMessage');
const remoteStatusPanel = document.querySelector('.remote-status');
const connectionBadge = document.querySelector('#connectionBadge');
const infoCustomer = document.querySelector('#infoCustomer');
const infoStatus = document.querySelector('#infoStatus');
const infoDuration = document.querySelector('#infoDuration');
const infoSessionId = document.querySelector('#infoSessionId');
const sessionDuration = document.querySelector('#sessionDuration');
const chatMessages = document.querySelector('#chatMessages');
const chatForm = document.querySelector('#chatForm');
const chatInput = document.querySelector('#chatInput');
const endSessionButton = document.querySelector('#endSessionButton');
const statusActions = document.querySelector('#statusActions');
const requestBroadcastRestart = document.querySelector('#requestBroadcastRestart');
const inputToggle = document.querySelector('#inputToggle');
const blankToggle = document.querySelector('#blankToggle');
const blankTile = document.querySelector('#blankTile');
const blockInputToggle = document.querySelector('#blockInputToggle');
const blockGuest = document.querySelector('#blockGuest');
const fileQueue = document.querySelector('#fileQueue');
// Optional canvas elements (added to index.html) for higher-quality rendering
const nativeFrameCanvas = document.querySelector('#nativeFrameCanvas');
const nativeFrameLargeCanvas = document.querySelector('#nativeFrameLargeCanvas');
const remoteFrameCanvas = document.querySelector('#remoteFrameCanvas');
const renderModeToggleHost = document.querySelector('#renderModeToggleHost');
let useCanvasRendering = true;
const requestHighQualityHost = document.querySelector('#requestHighQualityHost');
let highQualityRequested = false;

// Reconnection state
let hostReconnectAttempts = 0;
const MAX_HOST_RECONNECT_ATTEMPTS = 10;
const BASE_HOST_RECONNECT_DELAY_MS = 1000;
const MAX_HOST_RECONNECT_DELAY_MS = 30000;

// Automatically request higher-quality capture from the guest when the
// host has a large display or a high devicePixelRatio. This avoids forcing
// HQ for small windows but gives the host an HD experience when appropriate.
function maybeRequestHighQuality(autoReason) {
  try {
    if (highQualityRequested) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const displayW = Math.max(0, (remoteFrameCanvas?.getBoundingClientRect().width || window.innerWidth) * dpr);
    // If host display is large or device has high DPR, request HQ frames.
    if (displayW >= 1200 || dpr > 1.25) {
      highQualityRequested = true;
      if (requestHighQualityHost) requestHighQualityHost.textContent = 'HQ✓';
      // Ask agent to use larger dimension and higher quality/frame-rate.
      const payload = { format: 'webp', quality: 0.9, maxDimension: Math.min(3840, Math.round(displayW)), fps: 20 };
      send('screen.capture.settings', payload);
      setStatus('Request sent', `Requested high-quality frames${autoReason ? ' (' + autoReason + ')' : ''}.`);
    }
  } catch (e) {
    // Non-fatal: continue without auto-HQ
  }
}

// Top-level renderer: draw base64 frames into available canvases. This
// implementation prefers createImageBitmap for quality/performance and
// falls back to the Image-based approach.
async function drawFrameToCanvases(src) {
  // Prefer createImageBitmap (better for performance and quality) but
  // fall back to Image object if unavailable or conversion fails.
  let bitmap = null;
  try {
    const comma = src.indexOf(',');
    const b64 = comma >= 0 ? src.slice(comma + 1) : src;
    const bin = atob(b64);
    const len = bin.length;
    const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: 'image/octet-stream' });
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    bitmap = null;
  }

  const drawUsingBitmap = (bitmapOrImage) => {
    const draw = (canvas) => {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      const displayW = Math.max(1, Math.floor(rect.width));
      const displayH = Math.max(1, Math.floor(rect.height));

      canvas.width = Math.max(1, Math.floor(displayW * dpr));
      canvas.height = Math.max(1, Math.floor(displayH * dpr));
      canvas.style.width = displayW + 'px';
      canvas.style.height = displayH + 'px';

      ctx.imageSmoothingEnabled = true;
      try { ctx.imageSmoothingQuality = 'high'; } catch (e) {}
      try { ctx.webkitImageSmoothingEnabled = true; } catch (e) {}

      const srcW = bitmapOrImage.width || bitmapOrImage.naturalWidth || canvas.width;
      const srcH = bitmapOrImage.height || bitmapOrImage.naturalHeight || canvas.height;

      const scale = Math.min(canvas.width / srcW, canvas.height / srcH);
      const dw = Math.round(srcW * scale);
      const dh = Math.round(srcH * scale);
      const dx = Math.round((canvas.width - dw) / 2);
      const dy = Math.round((canvas.height - dh) / 2);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      try {
        ctx.drawImage(bitmapOrImage, 0, 0, srcW, srcH, dx, dy, dw, dh);
      } catch (e) {}
    };

    draw(nativeFrameCanvas);
    draw(nativeFrameLargeCanvas);
    draw(remoteFrameCanvas);

    if (remoteFrame) {
      try { remoteFrame.hidden = true; } catch (e) {}
    }
  };

  if (bitmap) {
    drawUsingBitmap(bitmap);
    try { bitmap.close?.(); } catch (e) {}
    return;
  }

  try {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => drawUsingBitmap(img);
    img.src = src;
  } catch (e) {
    // ignore
  }
}

const params = new URLSearchParams(location.search);
// No-op anchor to prepare insertion.
const sessionId = params.get('sessionId') || '';
const token = params.get('token') || '';
const displayName = params.get('displayName') || 'Guest User';
const configuredBaseUrl = params.get('baseUrl') || location.origin;

let ws;
let inputEnabled = true;
let blankScreenEnabled = false;
let blockInputEnabled = false;
let connected = false;
let guestPlatform = 'unknown';
let guestClientKind = 'unknown';
let serverRejected = false;
let lastInputAt = 0;
let lastFrameAt = 0;
let lastFramePayload = null;
let frameWatchdog = null;
let newestFrame = null;
let renderScheduled = false;
let sessionStartAt = Date.now();
let sessionTimer = null;
let inputEventSeq = 0;

function isIosPlatformValue(platform) {
  const value = String(platform || '').toLowerCase();
  return value === 'ios' || value === 'iphone' || value === 'ipad';
}

// Render-mode toggle handling for host client window
function setUseCanvasRenderingHost(value) {
  useCanvasRendering = Boolean(value);
  if (renderModeToggleHost) renderModeToggleHost.textContent = useCanvasRendering ? 'Canvas' : 'Image';
  if (!useCanvasRendering) {
    if (remoteFrame) remoteFrame.hidden = false;
    if (remoteFrameCanvas) remoteFrameCanvas.hidden = true;
    if (nativeFrameCanvas) nativeFrameCanvas.hidden = true;
    if (nativeFrameLargeCanvas) nativeFrameLargeCanvas.hidden = true;
  } else {
    if (remoteFrame) remoteFrame.hidden = true;
    if (remoteFrameCanvas) remoteFrameCanvas.hidden = false;
    if (nativeFrameCanvas) nativeFrameCanvas.hidden = false;
    if (nativeFrameLargeCanvas) nativeFrameLargeCanvas.hidden = false;
  }
}

if (renderModeToggleHost) {
  renderModeToggleHost.addEventListener('click', () => setUseCanvasRenderingHost(!useCanvasRendering));
}
setUseCanvasRenderingHost(true);

// High-quality capture request: toggles a request to the server/agent to increase capture quality
if (requestHighQualityHost) {
  requestHighQualityHost.addEventListener('click', () => {
    highQualityRequested = !highQualityRequested;
    requestHighQualityHost.textContent = highQualityRequested ? 'HQ✓' : 'HQ';
    // Send a capture settings request to the server which should forward to the agent
    const payload = highQualityRequested
      ? { format: 'webp', quality: 0.9, maxDimension: 1920, fps: 15 }
      : { format: 'jpeg', quality: 0.6, maxDimension: 1280, fps: 10 };
    send('screen.capture.settings', payload);
    setStatus('Request sent', highQualityRequested ? 'Requested high-quality frames from customer agent.' : 'Requested standard-quality frames.');
  });
}

function renderNewestFrame() {
  renderScheduled = false;
  const frame = newestFrame;
  newestFrame = null;
  if (!frame) return;

  // Keep the placeholder image src so naturalWidth/naturalHeight remain available
  try {
    if (remoteFrame) remoteFrame.src = frame.src;
  } catch (e) {
    // ignore
  }

  // Hide the empty placeholder
  if (remoteEmpty) remoteEmpty.hidden = true;

  lastFrameAt = Date.now();
  lastFramePayload = { format: frame.format, data: frame.data };

  if (useCanvasRendering) {
    if (nativeFrameLargeCanvas) nativeFrameLargeCanvas.hidden = false;
    if (nativeFrameCanvas) nativeFrameCanvas.hidden = false;
    if (remoteFrameCanvas) remoteFrameCanvas.hidden = false;
    // Draw to any available canvas using high-quality smoothing and devicePixelRatio.
    drawFrameToCanvases(frame.src);
  } else {
    // Fallback: show image element so browser handles scaling.
    try { if (remoteFrame) remoteFrame.src = frame.src; } catch (e) {}
    if (remoteFrame) remoteFrame.hidden = false;
    if (nativeFrameLargeCanvas) nativeFrameLargeCanvas.hidden = true;
    if (nativeFrameCanvas) nativeFrameCanvas.hidden = true;
    if (remoteFrameCanvas) remoteFrameCanvas.hidden = true;
  }

  const wasConnected = connected;
  connected = true;

  let statusDetail = 'Your guest is connected. Remote screen control is available.';
  if (isIosPlatformValue(guestPlatform)) {
    statusDetail = 'Your guest is connected. Remote view is active (iOS does not support remote control).';
  } else if (guestPlatform === 'android') {
    statusDetail = 'Your guest is connected. Remote screen control is available via Android accessibility.';
  } else if (guestPlatform === 'macos') {
    statusDetail = 'Your guest is connected. Remote view is active (macOS browser sharing).';
  }

  // drawFrameToCanvases is implemented at top-level for reuse by watchdog and other code.

  setStatus('Connected', statusDetail);
  if (displayName) remoteTitle.textContent = displayName;

  if (!wasConnected) {
    inputToggle.classList.add('active');
    remoteStatusPanel.hidden = true;
    remoteScreen.focus();
    startSessionTimer();
  }
}

function scheduleFrameRender(format, data) {
  const mime = String(format).includes('/') ? String(format) : `image/${String(format)}`;
  newestFrame = {
    format,
    data,
    src: `data:${mime};base64,${data}`
  };

  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(renderNewestFrame);
}

function statusTone(title) {
  const normalized = String(title || '').toLowerCase();
  if (normalized.includes('connected') || normalized.includes('live')) {
    // Host only considers the session "connected" (green badge) once screen frames are arriving.
    return connected ? 'connected' : 'waiting';
  }
  if (normalized.includes('disconnected') || normalized.includes('ended') || normalized.includes('error')) return 'disconnected';
  return 'waiting';
}

function updateConnectionBadge(tone) {
  if (!connectionBadge) return;
  connectionBadge.classList.remove('connected', 'waiting', 'disconnected');
  connectionBadge.classList.add(tone);
  connectionBadge.textContent = tone.charAt(0).toUpperCase() + tone.slice(1);
}

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function startSessionTimer() {
  if (sessionTimer) return;
  sessionTimer = setInterval(() => {
    const sec = Math.max(0, Math.floor((Date.now() - sessionStartAt) / 1000));
    const pretty = formatDuration(sec);
    if (sessionDuration) sessionDuration.textContent = pretty;
    if (infoDuration) infoDuration.textContent = pretty;
  }, 1000);
}

function appendChat(sender, text) {
  if (!chatMessages || !text) return;
  const row = document.createElement('div');
  row.className = `chat-line ${sender === 'host' ? 'host' : 'guest'}`;
  row.textContent = `${sender === 'host' ? 'You' : 'Guest'}: ${text}`;
  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setStatus(title, message) {
  remoteStatus.textContent = title;
  remoteStatusMessage.textContent = message;
  const tone = statusTone(title);
  updateConnectionBadge(tone);
  if (infoStatus) infoStatus.textContent = tone.charAt(0).toUpperCase() + tone.slice(1);
}

function showStatusPanel(title, message) {
  remoteStatusPanel.hidden = false;
  setStatus(title, message);
  if (statusActions) {
    const isMobile = isIosPlatformValue(guestPlatform) || guestPlatform === 'android';
    const isStuck = title.toLowerCase().includes('waiting') || title.toLowerCase().includes('frame') || title.toLowerCase().includes('disconnected');
    statusActions.hidden = !(isMobile && isStuck);
  }
}

if (requestBroadcastRestart) {
  requestBroadcastRestart.addEventListener('click', () => {
    send('screen.broadcast.request', { action: 'restart' });
    setStatus('Request sent', 'A request to restart the screen broadcast was sent to the guest app.');
    if (statusActions) statusActions.hidden = true;
  });
}

function nextInputSeq() {
  inputEventSeq += 1;
  return inputEventSeq;
}

function send(type, payload) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function publicWebSocketUrl() {
  const url = new URL(configuredBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/';
  url.search = new URLSearchParams({
    role: 'agent',
    client: 'host-viewer',
    sessionId,
    token
  }).toString();
  return url.toString();
}

async function fetchTroubleshooting() {
  if (!sessionId || !token) return null;
  try {
    const baseUrl = new URL(configuredBaseUrl, location.href);
    const url = new URL(`/api/session/${encodeURIComponent(sessionId)}/troubleshooting`, baseUrl);
    url.searchParams.set('token', token);
    const response = await fetch(url.toString());
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function hostTroubleshootingMessage(data, fallback) {
  if (!data?.ok) return fallback;
  const session = data.session || {};
  if (data.lastJoinError) return data.lastJoinError;
  if (session.permanentAccess && !session.permanentAccessAuthorizedAt) {
    return 'The customer must confirm unattended access before the client can activate.';
  }
  if (!session.nativeClaimed && !session.browserConnected) {
    return 'Waiting for the customer to open the support client or tap Start Broadcast / Share Screen on their phone.';
  }
  if ((session.nativeConnected || session.browserConnected) && !session.screenStreaming) {
    return 'The customer joined, but no screen frames have reached the server yet. Ask them to tap Start Broadcast / Share Screen and approve the phone screen-capture prompt.';
  }
  if (session.screenStreaming && session.lastFrameReceivers === 0) {
    return session.lastFrameDropReason || 'Screen frames are reaching the server, but no host viewer is receiving them.';
  }
  if (session.nativeClaimed && !session.nativeConnected && !session.browserConnected) {
    return data.guidance?.ifStuckConnecting || fallback;
  }
  if (session.blankScreen) return 'The guest screen is currently blanked.';
  if (session.permissions?.input === false) return 'Remote keyboard and mouse input is disabled for this session.';
  return data.guidance?.ifNoFrames || fallback;
}

async function showTroubleshootingStatus(title, fallback) {
  const diagnostics = await fetchTroubleshooting();
  showStatusPanel(title, hostTroubleshootingMessage(diagnostics, fallback));
}

function connect() {
  if (infoSessionId) infoSessionId.textContent = sessionId || '-';
  if (infoCustomer) infoCustomer.textContent = displayName;
  if (remoteTitle) remoteTitle.textContent = displayName;
  startSessionTimer();

  if (!sessionId || !token) {
    setStatus('Missing session details', 'Close this window and launch the host client again from the technician console.');
    return;
  }

  setStatus(
    'Connecting to your session...',
    'Opening the secure signaling channel to the relay server. This usually takes a few seconds.'
  );

  ws = new WebSocket(publicWebSocketUrl());

  ws.addEventListener('error', () => {
    setStatus(
      'Could not reach the relay server',
      'The host client failed to open a connection to the relay server. Check your internet connection and the server URL, then refresh this window.'
    );
  });

  ws.addEventListener('open', () => {
    // Reset reconnection attempts on successful connection
    hostReconnectAttempts = 0;
    setStatus('Waiting for your guest...', 'You have successfully connected to the session, but your guest has not yet connected. Your session will start when they connect.');
    window.setTimeout(() => {
      if (!connected) {
        void showTroubleshootingStatus('Waiting for your guest...', 'The session is open, but no customer screen stream has connected yet.');
      }
    }, 12000);
    // On open, consider requesting higher-quality frames automatically for HD hosts
    try { maybeRequestHighQuality('auto on connect'); } catch (e) {}
    window.setTimeout(() => {
      if (connected && !lastFrameAt) {
        showStatusPanel(
          'Still waiting for customer screen frames',
          'Customer appears connected but no frames arrived yet. On iPhone/iPad the customer must open iOS support app: Visit Host URL, Enter Code, Initiate ScreenShare, then Start Broadcast.'
        );
      }
    }, 15000);
  });

  // Watchdog: if the host viewer stops receiving frames, force a re-render.
  // This recovers from browser/UI “stuck image” states without affecting input relay.
  if (!frameWatchdog) {
    frameWatchdog = setInterval(() => {
      const nowTs = Date.now();
      if (!connected) return;
      if (lastFrameAt && nowTs - lastFrameAt > 5000 && lastFramePayload?.data) {
        const fmt = lastFramePayload.format || lastFramePayload.mime || 'jpeg';
        const data = lastFramePayload.data;
        const mime = String(fmt).includes('/') ? String(fmt) : `image/${String(fmt)}`;
        const src = `data:${mime};base64,${data}`;
        // Update image natural size and also draw to canvases for higher-quality rendering.
        try { if (remoteFrame) remoteFrame.src = src; } catch (e) {}
        drawFrameToCanvases(src);
        if (remoteEmpty) remoteEmpty.hidden = true;
        setStatus('Connected', 'Recovered screen stream (watchdog).');
      } else if (lastFrameAt && nowTs - lastFrameAt > 10000) {
        void showTroubleshootingStatus('Waiting for screen frames', 'The guest is connected, but no recent screen frames are arriving.');
      }
    }, 1000);
  }

  ws.addEventListener('message', async (event) => {
    const { type, payload } = JSON.parse(event.data);
    if (type === 'screen.frame') {
      // Make rendering resilient: payload may be malformed or arrive in unexpected shape.
      const fmt = payload && (payload.format || payload.mime || 'jpeg');
      const data = payload && (payload.data ?? payload.image ?? payload.frame);

      if (typeof data !== 'string' || !data.length) {
        // Keep last good frame (avoid clearing), but mark status for visibility.
        setStatus('Connected', 'Guest connected, waiting for next valid screen frame...');
        return;
      }

      scheduleFrameRender(fmt, data);
      // On receiving the first frames, auto-upgrade capture quality if host looks like an HD display.
      try { maybeRequestHighQuality('auto on first frame'); } catch (e) {}
    }

    if (type === 'screen.broadcast.status') {
      if (payload?.platform) guestPlatform = String(payload.platform).toLowerCase();
      const status = payload?.status || 'waiting';
      if (status === 'live') {
        setStatus('Broadcast live', payload?.message || 'Mobile screen broadcast is live. Waiting for the next frame...');
      } else if (status === 'starting') {
        showStatusPanel('Starting broadcast', payload?.message || 'The customer approved screen broadcast. Waiting for the first frame...');
      } else if (status === 'waiting' || status === 'waiting_first_frame') {
        updateWaitingForMobileFramesStatus(payload);
      } else if (status === 'ios_broadcast_connected_waiting_first_frame') {
        showStatusPanel(
          'iPhone connected (waiting for first frame)',
          payload?.message || 'iOS support app connected but no frames yet. Ask customer to tap Start Broadcast in Apple prompt.'
        );
      } else if (status === 'android_broadcast_connected_waiting_first_frame') {
        showStatusPanel(
          'Android connected (waiting for first frame)',
          payload?.message || 'Android support app connected but no frames yet. Ask customer to confirm MediaProjection/screen capture.'
        );
      } else if (status === 'stream_stale' || status === 'reconnect_required') {
        showStatusPanel(
          'Broadcast interrupted',
          payload?.message || 'Mobile broadcast interrupted. Ask customer to restart broadcast and keep app in foreground. Use the “Restart broadcast” action if available.'
        );
        // If we have the restart button, ensure the action panel becomes visible for quick recovery.
        if (remoteStatusPanel && statusActions) statusActions.hidden = false;
      } else if (status === 'unavailable') {
        showStatusPanel(
          payload?.requiresNativeApp ? 'iOS app required' : 'Broadcast unavailable',
          payload?.message || (
            payload?.requiresNativeApp
              ? 'Ask the customer to open the iOS support app and start Screen Broadcast.'
              : 'This phone browser cannot start screen broadcast.'
          )
        );
      }
      return;
    }

    if (type === 'peer.connected' && payload?.role === 'customer') {
      if (payload?.clientKind) guestClientKind = payload.clientKind;
      if (payload?.platform) guestPlatform = String(payload.platform).toLowerCase();

      if (guestClientKind === 'ios-mobile-broadcast') guestPlatform = 'iphone';
      if (guestClientKind === 'android-mobile-broadcast' || guestClientKind === 'mobile-broadcast') guestPlatform = 'android';
      if (guestClientKind === 'windows-native-agent') guestPlatform = 'windows';

      const clientKind = String(payload?.clientKind || '').toLowerCase();
      const browserShareClient = clientKind === 'browser-share' || clientKind === 'browser-broadcast';
      const iosBroadcastClient = clientKind === 'ios-mobile-broadcast';
      const androidBroadcastClient = clientKind === 'android-mobile-broadcast' || clientKind === 'mobile-broadcast';
      const mobileBroadcastClient = iosBroadcastClient || androidBroadcastClient;

      showStatusPanel(
        (browserShareClient || mobileBroadcastClient) ? 'Customer connected (waiting for screen)' : 'Guest connected',
        iosBroadcastClient
          ? 'iPhone/iPad customer is connected. Ask them to open the iOS support app: Visit Host URL, Enter Code, Initiate ScreenShare, then Start Broadcast.'
          : androidBroadcastClient
            ? 'Android customer is connected. Ask them to start screen sharing in the support app and approve all capture/accessibility prompts.'
            : browserShareClient
              ? 'The phone joined the session. Ask the customer to tap Start Broadcast / Share Screen and approve the capture prompt.'
              : 'The guest connected. Waiting for screen frames...'
      );
      return;
    }

    if (type === 'peer.disconnected' && payload?.role === 'customer') {
      connected = false;
      showStatusPanel('Guest disconnected', 'The customer device left the session.');
      return;
    }

    if (type === 'chat') {
      setStatus('Guest message', payload.message || 'Message received.');
      appendChat('guest', payload.message || '');
    }
    if (type === 'input.applied') {
      if (payload && payload.ok === false) {
        setStatus('Input not applied', payload.error || 'Windows rejected the remote input event.');
      }
      return;
    }
    if (type === 'input.relayed') {
      if (payload && payload.ok === false) {
        setStatus('Input not relayed', payload.error || 'No live customer agent received the input.');
      }
      return;
    }
    if (type === 'block-input.applied') {
      setStatus(payload.enabled ? 'Guest input blocked' : 'Guest input restored', payload.enabled ? 'The customer keyboard and mouse are blocked.' : 'The customer keyboard and mouse are available again.');
    }
    if (type === 'session.end') {
      if (blockInputEnabled) toggleBlockInput(false);
      if (blankScreenEnabled) toggleBlankScreen(false);
      setStatus('Session ended', 'The remote support session has ended.');
      ws.close();
    }
    if (type === 'error') {
      const transientCode = payload?.code === 'HOST_ALREADY_CONNECTED';
      serverRejected = !transientCode;
      setStatus(
        transientCode ? 'Another host viewer is still connected' : 'Could not open session',
        payload?.message || 'The server rejected this host connection.'
      );
      ws.close();
      if (transientCode) {
        setTimeout(connect, 5000);
      }
    }
  });

  ws.addEventListener('close', () => {
    if (serverRejected) return;
    
    // Exponential backoff with jitter
    const attempt = hostReconnectAttempts++;
    const baseDelay = Math.min(BASE_HOST_RECONNECT_DELAY_MS * Math.pow(2, attempt), MAX_HOST_RECONNECT_DELAY_MS);
    const jitter = Math.random() * 0.3 * baseDelay; // 0-30% jitter
    const delay = Math.floor(baseDelay + jitter);
    
    void showTroubleshootingStatus('Disconnected', `The host client is no longer connected to the session. Retrying in ${Math.round(delay / 1000)}s... (attempt ${attempt + 1})`);
    setTimeout(() => {
      if (hostReconnectAttempts >= MAX_HOST_RECONNECT_ATTEMPTS) {
        void showTroubleshootingStatus('Connection failed', 'Maximum reconnection attempts reached. Please refresh the page to try again.');
        return;
      }
      connect();
    }, delay);
  });
}

function updateWaitingForMobileFramesStatus(payload = {}) {
  const isIos = isIosPlatformValue(guestPlatform) || isIosPlatformValue(payload?.platform) || Boolean(payload?.requiresNativeApp);
  const waitingTitle = isIos ? 'iPhone connected (waiting for screen broadcast)' : 'Mobile connected (waiting for screen broadcast)';
  const waitingMessage = isIos
    ? 'Customer iPhone joined but no screen frames yet. Ask customer to open iOS support app: Visit Host URL, Enter Code, Initiate ScreenShare, then Start Broadcast.'
    : 'Customer mobile joined but no screen frames yet. Ask customer to tap Start Broadcast / Share Screen and approve capture permission.';
  showStatusPanel(waitingTitle, payload?.message || waitingMessage);
}

function remotePoint(event) {
  // The streamed element uses `object-fit: contain`, which creates letterboxing.
  // Coordinates must be mapped against the actual <img> box (not the container).
  const frameEl = remoteFrame || document.querySelector('#nativeFrame') || document.querySelector('#nativeFrameLarge');
  if (!frameEl) return { x: 0.5, y: 0.5 };
  const imgBox = frameEl.getBoundingClientRect();

  // Default to the full box (works for near-square/edge cases).
  let left = imgBox.left;
  let top = imgBox.top;
  let width = imgBox.width;
  let height = imgBox.height;

  // When the <img> is rendered, object-fit:contain keeps aspect ratio and
  // letterboxes inside the <img> box. Map pointer coordinates into that
  // contained region.
  const nw = (frameEl.naturalWidth || frameEl.width || 0) ;
  const nh = (frameEl.naturalHeight || frameEl.height || 0) ;

  if (nw > 0 && nh > 0 && width > 0 && height > 0) {
    // Contained image size inside the <img> box.
    const frameRatio = nw / nh;
    const boxRatio = width / height;

    if (boxRatio > frameRatio) {
      // Box is wider than content: constrained by height.
      height = imgBox.height;
      width = height * frameRatio;
      left = imgBox.left + (imgBox.width - width) / 2;
      top = imgBox.top;
    } else {
      // Box is taller than content: constrained by width.
      width = imgBox.width;
      height = width / frameRatio;
      top = imgBox.top + (imgBox.height - height) / 2;
      left = imgBox.left;
    }
  }

  // If width/height is degenerate for any reason, avoid NaNs.
  if (!(width > 0) || !(height > 0)) {
    return { x: 0.5, y: 0.5 };
  }

  const x = (event.clientX - left) / width;
  const y = (event.clientY - top) / height;


  return {
    x: Number(Math.min(1, Math.max(0, x)).toFixed(4)),
    y: Number(Math.min(1, Math.max(0, y)).toFixed(4))
  };
}

function isRemoteScreenInteractive() {
  // If the customer monitor is blanked, the image is effectively not interactable.
  // We still allow the host to click so we can unblank (buttons already exist),
  // but input events should not get sent.
  return !blankScreenEnabled;
}

function sendPointer(event) {
  if (!inputEnabled) return;
  if (!isRemoteScreenInteractive()) return;
  if (!connected) return;

  event.preventDefault();
  lastInputAt = Date.now();

  try {
    if (event.type === 'pointerdown') {
      remoteScreen.setPointerCapture?.(event.pointerId);
    } else if (event.type === 'pointerup' || event.type === 'pointercancel') {
      remoteScreen.releasePointerCapture?.(event.pointerId);
    }
  } catch {
    // ignore pointer capture errors
  }

  remoteScreen.focus();
  const point = remotePoint(event);
  const kind = event.type === 'pointercancel' ? 'pointerup' : event.type;
  const button = event.button >= 0 ? event.button : 0;
  send('input', {
    kind,
    x: point.x,
    y: point.y,
    button,
    pointerType: event.pointerType || 'mouse',
    seq: nextInputSeq()
  });
}


function sendWheel(event) {
  if (!inputEnabled) return;
  if (!isRemoteScreenInteractive()) return;
  if (!connected) return;
  event.preventDefault();
  lastInputAt = Date.now();
  remoteScreen.focus();
  const point = remotePoint(event);
  send('input', {
    kind: 'wheel',
    x: point.x,
    y: point.y,
    deltaY: Math.max(-1200, Math.min(1200, Math.round(event.deltaY)))
  });
}


function sendKey(event) {
  if (!inputEnabled) return;
  if (!connected) return;
  if (!isRemoteScreenInteractive()) return;
  event.preventDefault();
  lastInputAt = Date.now();
  // Avoid sending duplicate printable characters by not forwarding the
  // keyup event for normal printable keys. Modifiers (Shift/Ctrl/Alt/Meta)
  // still send both down and up so the remote side sees correct modifier state.
  try {
    const key = String(event.key || '');
    const modifiers = ['Shift', 'ShiftLeft', 'ShiftRight', 'Control', 'ControlLeft', 'ControlRight', 'Alt', 'AltLeft', 'AltRight', 'Meta', 'MetaLeft', 'MetaRight'];
    const nonPrintableSpecial = ['Enter','Backspace','Tab','Escape','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'];
    const isModifier = modifiers.includes(event.code) || modifiers.includes(key);
    const isPrintable = key.length === 1 || nonPrintableSpecial.includes(key);

    if (event.type === 'keyup' && isPrintable && !isModifier) {
      // suppress keyup for printable keys to avoid duplicate characters
      return;
    }

    send('input', {
      kind: event.type,
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: Boolean(event.repeat),
      isComposing: Boolean(event.isComposing),
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      seq: nextInputSeq()
    });
  } catch (e) {
    // Best-effort: if anything goes wrong, still attempt to send basic key info.
    try { send('input', { kind: event.type, key: event.key, seq: nextInputSeq() }); } catch (e2) {}
  }
}


async function setServerInputPermission(value) {
  try {
    await fetch(`/api/session/${encodeURIComponent(sessionId)}/permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-token': token },
      body: JSON.stringify({ input: Boolean(value) })
    });
  } catch (e) {
    // Non-fatal: local toggle still works, but server relay may remain disabled.
  }
}

function toggleInput() {
  inputEnabled = !inputEnabled;
  inputToggle.classList.toggle('active', inputEnabled);
  setStatus(inputEnabled ? 'Input enabled' : 'Input suspended', inputEnabled ? 'Mouse and keyboard events will be sent to the guest.' : 'Mouse and keyboard events are not being sent.');
  void setServerInputPermission(inputEnabled);
}

function toggleBlankScreen(forceValue) {
  blankScreenEnabled = typeof forceValue === 'boolean' ? forceValue : !blankScreenEnabled;
  blankToggle.classList.toggle('active', blankScreenEnabled);
  blankTile.classList.toggle('enabled', blankScreenEnabled);
  send('blank-screen', {
    enabled: blankScreenEnabled,
    title: 'Windows is updating',
    message: 'Please wait and do not turn off your computer while updating',
    progress: 65
  });
}

function toggleBlockInput(forceValue) {
  blockInputEnabled = typeof forceValue === 'boolean' ? forceValue : !blockInputEnabled;
  blockInputToggle?.classList.toggle('active', blockInputEnabled);
  blockGuest?.classList.toggle('enabled', blockInputEnabled);
  send('block-input', {
    enabled: blockInputEnabled
  });
  setStatus(blockInputEnabled ? 'Blocking guest input' : 'Restoring guest input', blockInputEnabled ? 'Customer keyboard and mouse input will be blocked.' : 'Customer keyboard and mouse input will be restored.');
}

async function queueFile() {
  await fetch(`/api/session/${encodeURIComponent(sessionId)}/file-transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-token': token },
    body: JSON.stringify({ name: 'diagnostics.zip', direction: 'upload', size: 7340032 })
  });
  setStatus('File queued', 'The file transfer request was sent to the guest client.');
}

// Input: send down/up immediately, coalesce high-frequency move/wheel events.
let latestMovePayload = null;
let latestWheelPayload = null;
let moveSendScheduled = false;
let wheelSendScheduled = false;

const MOVE_SEND_MAX_HZ = 60; // feels real-time while preventing WS flooding
const WHEEL_SEND_MAX_HZ = 60;
const MOVE_SEND_MIN_MS = 1000 / MOVE_SEND_MAX_HZ;
const WHEEL_SEND_MIN_MS = 1000 / WHEEL_SEND_MAX_HZ;
let lastMoveSendAt = 0;
let lastWheelSendAt = 0;

function scheduleSendMove() {
  if (moveSendScheduled) return;
  moveSendScheduled = true;
  const doSend = () => {
    moveSendScheduled = false;
    if (!latestMovePayload) return;

    const nowTs = Date.now();
    if (nowTs - lastMoveSendAt < MOVE_SEND_MIN_MS) {
      // Re-schedule shortly to respect max rate.
      setTimeout(doSend, MOVE_SEND_MIN_MS - (nowTs - lastMoveSendAt));
      return;
    }

    lastMoveSendAt = nowTs;
    send('input', latestMovePayload);
    latestMovePayload = null;
  };
  // Use rAF for low latency; fall back to setTimeout if tab is throttled.
  requestAnimationFrame(doSend);
}

function scheduleSendWheel() {
  if (wheelSendScheduled) return;
  wheelSendScheduled = true;
  const doSend = () => {
    wheelSendScheduled = false;
    if (!latestWheelPayload) return;

    const nowTs = Date.now();
    if (nowTs - lastWheelSendAt < WHEEL_SEND_MIN_MS) {
      setTimeout(doSend, WHEEL_SEND_MIN_MS - (nowTs - lastWheelSendAt));
      return;
    }

    lastWheelSendAt = nowTs;
    send('input', latestWheelPayload);
    latestWheelPayload = null;
  };
  requestAnimationFrame(doSend);
}

function handlePointerDown(event) {
  // Pointer down should be immediate.
  sendPointer(event);
}

function handlePointerMove(event) {
  if (!inputEnabled) return;
  if (!isRemoteScreenInteractive()) return;
  if (!connected) return;
  event.preventDefault();

  const point = remotePoint(event);
  if (!point) return;

  // Coalesce: keep only latest pointer position.
  latestMovePayload = {
    kind: event.type === 'pointercancel' ? 'pointerup' : event.type,
    x: point.x,
    y: point.y,
    button: event.button >= 0 ? event.button : 0,
    pointerType: event.pointerType || 'mouse',
    seq: nextInputSeq()
  };
  scheduleSendMove();
}

function handlePointerUp(event) {
  // Pointer up/cancel should be immediate.
  sendPointer(event);
}

function handleWheel(event) {
  // Wheel should be immediate-ish but not flood.
  if (!inputEnabled) return;
  if (!isRemoteScreenInteractive()) return;
  if (!connected) return;
  event.preventDefault();
  const point = remotePoint(event);
  if (!point) return;

  latestWheelPayload = {
    kind: 'wheel',
    x: point.x,
    y: point.y,
    deltaX: Math.max(-1200, Math.min(1200, Math.round(event.deltaX || 0))),
    deltaY: Math.max(-1200, Math.min(1200, Math.round(event.deltaY || 0))),
    deltaMode: Number.isFinite(event.deltaMode) ? event.deltaMode : 0,
    seq: nextInputSeq()
  };
  scheduleSendWheel();
}

function handleDoubleClick(event) {
  if (!inputEnabled) return;
  if (!isRemoteScreenInteractive()) return;
  if (!connected) return;
  event.preventDefault();
  const point = remotePoint(event);
  send('input', {
    kind: 'pointerdblclick',
    x: point.x,
    y: point.y,
    button: event.button >= 0 ? event.button : 0,
    pointerType: event.pointerType || 'mouse',
    seq: nextInputSeq()
  });
}

remoteScreen.addEventListener('pointerdown', handlePointerDown);
remoteScreen.addEventListener('pointermove', handlePointerMove);
remoteScreen.addEventListener('pointerup', handlePointerUp);
remoteScreen.addEventListener('pointercancel', handlePointerUp);
remoteScreen.addEventListener('dblclick', handleDoubleClick);
remoteScreen.addEventListener('wheel', handleWheel, { passive: false });
remoteScreen.addEventListener('keydown', sendKey);
remoteScreen.addEventListener('keyup', sendKey);



window.addEventListener('keydown', (event) => {
  if (event.target === remoteScreen) return;
  if (document.activeElement === remoteScreen || document.activeElement === document.body) sendKey(event);
});
window.addEventListener('keyup', (event) => {
  if (event.target === remoteScreen) return;
  if (document.activeElement === remoteScreen || document.activeElement === document.body) sendKey(event);
});
inputToggle.classList.add('active');
inputToggle.addEventListener('click', toggleInput);
blankToggle.addEventListener('click', toggleBlankScreen);
blankTile.addEventListener('click', toggleBlankScreen);
blockInputToggle?.addEventListener('click', () => toggleBlockInput());
blockGuest?.addEventListener('click', () => toggleBlockInput());
fileQueue.addEventListener('click', () => queueFile().catch(() => setStatus('File queue failed', 'Could not queue the file transfer.')));

chatForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = (chatInput?.value || '').trim();
  if (!message) return;
  send('chat', { message });
  appendChat('host', message);
  chatInput.value = '';
});

endSessionButton?.addEventListener('click', () => {
  send('session.end', { reason: 'Host ended session' });
  setStatus('Session ended', 'The remote support session has ended by host.');
  ws?.close();
});

connect();
