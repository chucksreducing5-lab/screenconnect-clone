const remoteTitle = document.querySelector('#remoteTitle');
const remoteFrame = document.querySelector('#remoteFrame');
const remoteEmpty = document.querySelector('#remoteEmpty');
const remoteStatus = document.querySelector('#remoteStatus');
const remoteStatusMessage = document.querySelector('#remoteStatusMessage');

const params = new URLSearchParams(location.search);
const sessionId = params.get('sessionId') || '';
const token = params.get('token') || '';
const displayName = params.get('displayName') || '';
const configuredBaseUrl = params.get('baseUrl') || location.origin;

let ws;
let connected = false;
let lastFrameAt = 0;
let lastFramePayload = null;
let frameWatchdog = null;
let newestFrame = null;
let renderScheduled = false;

function setStatus(title, message) {
  remoteStatus.textContent = title;
  remoteStatusMessage.textContent = message;
}

function scheduleFrameRender(payload) {
  newestFrame = payload;
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    const frame = newestFrame;
    newestFrame = null;
    if (!frame) return;

    const fmt = frame.format || frame.mime || 'jpeg';
    const data = frame.data ?? frame.image ?? frame.frame;
    if (typeof data !== 'string' || !data.length) return;

    const mime = String(fmt).includes('/') ? String(fmt) : `image/${String(fmt)}`;
    remoteFrame.hidden = false;
    remoteEmpty.hidden = true;
    remoteFrame.src = `data:${mime};base64,${data}`;

    lastFrameAt = Date.now();
    lastFramePayload = frame;

    if (!connected) {
      connected = true;
      setStatus('Connected', 'Screen is being displayed (view only).');
    }

    if (displayName) remoteTitle.textContent = displayName;
  });
}

function connect() {
  if (!sessionId || !token) {
    setStatus('Missing session details', 'Close this window and launch the viewer from your technician console.');
    return;
  }

  const wsUrl = new URL(configuredBaseUrl);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.pathname = '/';
  wsUrl.search = new URLSearchParams({
    role: 'agent',
    client: 'host-viewer',
    sessionId,
    token
  }).toString();

  // IMPORTANT: viewer-only means we never send input/control messages.
  // We only listen for screen.frame and render it.
  ws = new WebSocket(wsUrl.toString());

  ws.addEventListener('open', () => {
    setStatus('Waiting for screen...', 'Connecting to the session.');
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    const { type, payload } = msg || {};

    if (type === 'screen.frame') {
      scheduleFrameRender(payload || {});
      return;
    }

    if (type === 'session.end') {
      setStatus('Session ended', 'The remote support session has ended.');
      ws?.close();
      return;
    }

    if (type === 'error') {
      setStatus('Connection error', payload?.message || 'Unauthorized or session not found.');
    }
  });

  ws.addEventListener('close', () => {
    setStatus('Disconnected', 'This viewer is no longer connected to the session. Retrying in 5s...');
    setTimeout(connect, 5000);
  });

  // Watchdog similar to host-client: if frames stall, try to re-render last good one.
  if (!frameWatchdog) {
    frameWatchdog = setInterval(() => {
      if (!connected) return;
      const nowTs = Date.now();
      if (lastFrameAt && nowTs - lastFrameAt > 5000 && lastFramePayload?.data) {
        scheduleFrameRender(lastFramePayload);
        setStatus('Re-rendering', 'Recovered screen stream (viewer).');
      }
    }, 1000);
  }
}

connect();

