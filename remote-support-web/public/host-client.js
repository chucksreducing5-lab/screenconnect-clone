// ═══════════════════════════════════════════════════════════════════════════════
// ScreenConnect-Quality Host Viewer
// Canvas-based rendering, adaptive quality display, FPS counter, zoom/pan,
// quality HUD overlay, improved input forwarding with touch translation
// ═══════════════════════════════════════════════════════════════════════════════

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
const infoQuality = document.querySelector('#infoQuality');
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
const qualityHud = document.querySelector('#qualityHud');
const fpsDisplay = document.querySelector('#fpsDisplay');
const qualityTierDisplay = document.querySelector('#qualityTier');
const resolutionDisplay = document.querySelector('#resolution');
const bandwidthDisplay = document.querySelector('#bandwidth');
const latencyDisplay = document.querySelector('#latency');

const params = new URLSearchParams(location.search);
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
let sessionStartAt = Date.now();
let sessionTimer = null;
let inputEventSeq = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// Canvas-Based Screen Renderer (ScreenConnect-quality rendering)
// ═══════════════════════════════════════════════════════════════════════════════

const SCViewer = {
  canvas: null,
  ctx: null,
  currentImage: null,
  pendingImage: null,
  renderScheduled: false,
  naturalWidth: 0,
  naturalHeight: 0,
  
  // FPS tracking
  frameCount: 0,
  fpsFrameCount: 0,
  lastFpsUpdate: 0,
  currentFps: 0,
  
  // Quality stats
  lastFormat: 'jpeg',
  lastQuality: 0,
  lastTier: 'unknown',
  lastFrameSize: 0,
  totalBytesReceived: 0,
  framesReceived: 0,
  lastFrameTimestamp: 0,
  avgLatency: 0,
  
  // Zoom/Pan state
  zoom: 1,
  panX: 0,
  panY: 0,
  isPanning: false,
  panStartX: 0,
  panStartY: 0,
  minZoom: 1,
  maxZoom: 5,
  
  // HUD visibility
  hudVisible: false,

  init() {
    // Create canvas for rendering
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'viewerCanvas';
    this.canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;cursor:crosshair;touch-action:none;user-select:none;-webkit-user-select:none;image-rendering:auto;';
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    
    // Insert canvas into the remote screen area
    if (remoteScreen) {
      remoteScreen.appendChild(this.canvas);
    }
    
    // Create quality HUD overlay
    this.createHUD();
    
    // FPS counter
    this.lastFpsUpdate = performance.now();
    setInterval(() => this.updateFpsCounter(), 1000);
    
    // Handle zoom with mouse wheel (Ctrl+scroll)
    this.canvas.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        this.setZoom(this.zoom + delta, e.offsetX, e.offsetY);
      }
    }, { passive: false });
    
    // Handle zoom reset on double-click with Ctrl
    this.canvas.addEventListener('dblclick', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.resetZoom();
      }
    });
    
    // Keyboard zoom shortcuts
    document.addEventListener('keydown', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); this.setZoom(this.zoom + 0.25); }
      if (e.key === '-') { e.preventDefault(); this.setZoom(this.zoom - 0.25); }
      if (e.key === '0') { e.preventDefault(); this.resetZoom(); }
      // Toggle HUD with Ctrl+H
      if (e.key === 'h' || e.key === 'H') { e.preventDefault(); this.toggleHUD(); }
    });
  },

  createHUD() {
    if (qualityHud) return; // Already exists in HTML
    
    const hud = document.createElement('div');
    hud.id = 'qualityHud';
    hud.className = 'quality-hud';
    hud.innerHTML = `
      <div class="hud-row"><span class="hud-label">FPS</span><span id="fpsDisplay" class="hud-value">0</span></div>
      <div class="hud-row"><span class="hud-label">Quality</span><span id="qualityTier" class="hud-value">—</span></div>
      <div class="hud-row"><span class="hud-label">Resolution</span><span id="resolution" class="hud-value">—</span></div>
      <div class="hud-row"><span class="hud-label">Bandwidth</span><span id="bandwidth" class="hud-value">—</span></div>
      <div class="hud-row"><span class="hud-label">Latency</span><span id="latency" class="hud-value">—</span></div>
      <div class="hud-row"><span class="hud-label">Frames</span><span id="framesTotal" class="hud-value">0</span></div>
      <div class="hud-row"><span class="hud-label">Zoom</span><span id="zoomLevel" class="hud-value">100%</span></div>
    `;
    hud.hidden = true;
    if (remoteScreen) remoteScreen.appendChild(hud);
  },

  toggleHUD() {
    this.hudVisible = !this.hudVisible;
    const hud = document.getElementById('qualityHud');
    if (hud) hud.hidden = !this.hudVisible;
  },

  updateFpsCounter() {
    const now = performance.now();
    const elapsed = (now - this.lastFpsUpdate) / 1000;
    this.currentFps = Math.round(this.fpsFrameCount / Math.max(elapsed, 0.001));
    this.fpsFrameCount = 0;
    this.lastFpsUpdate = now;
    
    // Update HUD elements
    const fpsEl = document.getElementById('fpsDisplay');
    const tierEl = document.getElementById('qualityTier');
    const resEl = document.getElementById('resolution');
    const bwEl = document.getElementById('bandwidth');
    const latEl = document.getElementById('latency');
    const framesEl = document.getElementById('framesTotal');
    const zoomEl = document.getElementById('zoomLevel');
    
    if (fpsEl) fpsEl.textContent = this.currentFps;
    if (tierEl) tierEl.textContent = this.lastTier ? `${this.lastTier} (${this.lastFormat})` : '—';
    if (resEl) resEl.textContent = this.naturalWidth ? `${this.naturalWidth}×${this.naturalHeight}` : '—';
    if (bwEl) {
      const kbps = Math.round((this.totalBytesReceived * 8) / Math.max(1, (Date.now() - sessionStartAt) / 1000) / 1000);
      bwEl.textContent = kbps > 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} Kbps`;
    }
    if (latEl) latEl.textContent = this.avgLatency > 0 ? `${Math.round(this.avgLatency)} ms` : '—';
    if (framesEl) framesEl.textContent = this.framesReceived;
    if (zoomEl) zoomEl.textContent = `${Math.round(this.zoom * 100)}%`;
    
    // Update info panel quality
    if (infoQuality) {
      infoQuality.textContent = `${this.lastTier || 'Waiting'} • ${this.currentFps} FPS • ${this.lastFormat.toUpperCase()}`;
    }
  },

  setZoom(newZoom, anchorX, anchorY) {
    const prev = this.zoom;
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, newZoom));
    
    if (anchorX !== undefined && anchorY !== undefined) {
      // Zoom toward the anchor point
      const scale = this.zoom / prev;
      this.panX = anchorX - (anchorX - this.panX) * scale;
      this.panY = anchorY - (anchorY - this.panY) * scale;
    }
    
    this.constrainPan();
    this.render();
  },

  resetZoom() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.render();
  },

  constrainPan() {
    if (this.zoom <= 1) {
      this.panX = 0;
      this.panY = 0;
      return;
    }
    const maxPanX = (this.canvas.width * (this.zoom - 1)) / 2;
    const maxPanY = (this.canvas.height * (this.zoom - 1)) / 2;
    this.panX = Math.max(-maxPanX, Math.min(maxPanX, this.panX));
    this.panY = Math.max(-maxPanY, Math.min(maxPanY, this.panY));
  },

  // Schedule a frame render using requestAnimationFrame for smooth 60hz display
  scheduleRender(format, data, width, height, quality, tier, timestamp) {
    this.pendingImage = { format, data, width, height, quality, tier, timestamp };
    
    if (!this.renderScheduled) {
      this.renderScheduled = true;
      requestAnimationFrame(() => this.processPendingFrame());
    }
  },

  processPendingFrame() {
    this.renderScheduled = false;
    const frame = this.pendingImage;
    this.pendingImage = null;
    if (!frame) return;

    const img = new Image();
    img.onload = () => {
      this.currentImage = img;
      this.naturalWidth = frame.width || img.naturalWidth;
      this.naturalHeight = frame.height || img.naturalHeight;
      this.lastFormat = frame.format || 'jpeg';
      this.lastQuality = frame.quality || 0;
      this.lastTier = frame.tier || 'unknown';
      this.lastFrameSize = Math.round(frame.data.length * 0.75);
      this.totalBytesReceived += this.lastFrameSize;
      this.framesReceived++;
      this.fpsFrameCount++;
      this.lastFrameTimestamp = frame.timestamp || Date.now();
      
      // Estimate latency from timestamp
      if (frame.timestamp) {
        const latency = Date.now() - frame.timestamp;
        this.avgLatency = this.avgLatency > 0
          ? this.avgLatency * 0.8 + latency * 0.2
          : latency;
      }
      
      this.render();
      
      // Update connection state
      lastFrameAt = Date.now();
      lastFramePayload = { format: frame.format, data: frame.data };

      if (!connected) {
        connected = true;
        onFirstFrame();
      }

      remoteFrame.hidden = true;
      remoteEmpty.hidden = true;
      this.canvas.hidden = false;
      
      let statusDetail = 'Remote screen connected. Full remote control is available.';
      if (guestPlatform === 'ios') {
        statusDetail = 'iOS device connected. View-only mode (iOS does not support remote input).';
      } else if (guestPlatform === 'android') {
        statusDetail = 'Android device connected. Remote control via accessibility service.';
      } else if (guestPlatform === 'macos') {
        statusDetail = 'macOS device connected. Remote view active.';
      }
      setStatus('Connected', statusDetail);
    };
    
    img.onerror = () => {
      // Keep last good frame visible
    };
    
    const mime = String(frame.format).includes('/') ? String(frame.format) : `image/${String(frame.format)}`;
    img.src = `data:${mime};base64,${frame.data}`;
  },

  render() {
    if (!this.currentImage || !this.ctx) return;
    
    const img = this.currentImage;
    const canvas = this.canvas;
    
    // Size canvas to match container
    const container = canvas.parentElement;
    if (!container) return;
    
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = Math.round(rect.width);
    const displayHeight = Math.round(rect.height);
    
    // Set canvas internal resolution (high DPI support)
    if (canvas.width !== displayWidth * dpr || canvas.height !== displayHeight * dpr) {
      canvas.width = displayWidth * dpr;
      canvas.height = displayHeight * dpr;
      canvas.style.width = displayWidth + 'px';
      canvas.style.height = displayHeight + 'px';
    }
    
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(dpr, dpr);
    
    // Clear
    ctx.fillStyle = '#050a12';
    ctx.fillRect(0, 0, displayWidth, displayHeight);
    
    // Calculate image placement with object-fit: contain
    const imgRatio = img.naturalWidth / img.naturalHeight;
    const containerRatio = displayWidth / displayHeight;
    
    let drawWidth, drawHeight, drawX, drawY;
    
    if (containerRatio > imgRatio) {
      // Container wider than image
      drawHeight = displayHeight;
      drawWidth = drawHeight * imgRatio;
      drawX = (displayWidth - drawWidth) / 2;
      drawY = 0;
    } else {
      // Container taller than image
      drawWidth = displayWidth;
      drawHeight = drawWidth / imgRatio;
      drawX = 0;
      drawY = (displayHeight - drawHeight) / 2;
    }
    
    // Apply zoom and pan
    if (this.zoom > 1) {
      const centerX = displayWidth / 2 + this.panX;
      const centerY = displayHeight / 2 + this.panY;
      ctx.translate(centerX, centerY);
      ctx.scale(this.zoom, this.zoom);
      ctx.translate(-centerX, -centerY);
    }
    
    // High quality rendering
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    
    // Draw the remote screen image
    ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
    
    ctx.restore();
  },

  // Convert screen coordinates to remote machine coordinates (0-1 normalized)
  screenToRemote(clientX, clientY) {
    if (!this.currentImage || !this.canvas) return { x: 0.5, y: 0.5 };
    
    const rect = this.canvas.getBoundingClientRect();
    const canvasX = clientX - rect.left;
    const canvasY = clientY - rect.top;
    const displayWidth = rect.width;
    const displayHeight = rect.height;
    
    // Undo zoom/pan
    let x = canvasX;
    let y = canvasY;
    
    if (this.zoom > 1) {
      const centerX = displayWidth / 2 + this.panX;
      const centerY = displayHeight / 2 + this.panY;
      x = (x - centerX) / this.zoom + centerX;
      y = (y - centerY) / this.zoom + centerY;
    }
    
    // Calculate image bounds (object-fit: contain)
    const img = this.currentImage;
    const imgRatio = img.naturalWidth / img.naturalHeight;
    const containerRatio = displayWidth / displayHeight;
    
    let drawWidth, drawHeight, drawX, drawY;
    
    if (containerRatio > imgRatio) {
      drawHeight = displayHeight;
      drawWidth = drawHeight * imgRatio;
      drawX = (displayWidth - drawWidth) / 2;
      drawY = 0;
    } else {
      drawWidth = displayWidth;
      drawHeight = drawWidth / imgRatio;
      drawX = 0;
      drawY = (displayHeight - drawHeight) / 2;
    }
    
    // Map to 0-1 range within the image area
    const normalizedX = (x - drawX) / drawWidth;
    const normalizedY = (y - drawY) / drawHeight;
    
    return {
      x: Number(Math.min(1, Math.max(0, normalizedX)).toFixed(5)),
      y: Number(Math.min(1, Math.max(0, normalizedY)).toFixed(5))
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// Status & Connection Management
// ═══════════════════════════════════════════════════════════════════════════════

function onFirstFrame() {
  inputToggle.classList.add('active');
  remoteStatusPanel.hidden = true;
  remoteScreen.focus();
  startSessionTimer();
  if (displayName) remoteTitle.textContent = displayName;
}

function statusTone(title) {
  const normalized = String(title || '').toLowerCase();
  if (normalized.includes('connected') || normalized.includes('live')) {
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
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  row.textContent = `[${time}] ${sender === 'host' ? 'You' : 'Guest'}: ${text}`;
  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setStatus(title, message) {
  if (remoteStatus) remoteStatus.textContent = title;
  if (remoteStatusMessage) remoteStatusMessage.textContent = message;
  const tone = statusTone(title);
  updateConnectionBadge(tone);
  if (infoStatus) infoStatus.textContent = tone.charAt(0).toUpperCase() + tone.slice(1);
}

function showStatusPanel(title, message) {
  remoteStatusPanel.hidden = false;
  setStatus(title, message);
  if (statusActions) {
    const isMobile = guestPlatform === 'ios' || guestPlatform === 'android';
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

// ═══════════════════════════════════════════════════════════════════════════════
// WebSocket Connection
// ═══════════════════════════════════════════════════════════════════════════════

function connect() {
  if (infoSessionId) infoSessionId.textContent = sessionId || '-';
  if (infoCustomer) infoCustomer.textContent = displayName;
  if (remoteTitle) remoteTitle.textContent = displayName;
  startSessionTimer();

  // Initialize the canvas viewer
  SCViewer.init();

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
    setStatus('Waiting for your guest...', 'You have successfully connected to the session, but your guest has not yet connected. Your session will start when they connect.');
    window.setTimeout(() => {
      if (!connected) {
        void showTroubleshootingStatus('Waiting for your guest...', 'The session is open, but no customer screen stream has connected yet.');
      }
    }, 12000);
    window.setTimeout(() => {
      if (connected && !lastFrameAt) {
        showStatusPanel(
          'Still waiting for customer screen frames',
          'Customer appears connected but no frames arrived yet. On iPhone/iPad the customer must open iOS support app: Visit Host URL, Enter Code, Initiate ScreenShare, then Start Broadcast.'
        );
      }
    }, 15000);
  });

  // Watchdog: if the host viewer stops receiving frames, show status
  if (!frameWatchdog) {
    frameWatchdog = setInterval(() => {
      const nowTs = Date.now();
      if (!connected) return;
      if (lastFrameAt && nowTs - lastFrameAt > 5000 && lastFramePayload?.data) {
        // Re-render last frame to recover from any rendering glitch
        SCViewer.render();
        setStatus('Connected', 'Recovered screen stream (watchdog).');
      } else if (lastFrameAt && nowTs - lastFrameAt > 10000) {
        void showTroubleshootingStatus('Waiting for screen frames', 'The guest is connected, but no recent screen frames are arriving.');
      }
    }, 2000);
  }

  ws.addEventListener('message', async (event) => {
    const { type, payload } = JSON.parse(event.data);
    
    if (type === 'screen.frame') {
      const fmt = payload && (payload.format || payload.mime || 'jpeg');
      const data = payload && (payload.data ?? payload.image ?? payload.frame);

      if (typeof data !== 'string' || !data.length) {
        setStatus('Connected', 'Guest connected, waiting for next valid screen frame...');
        return;
      }

      // Use the new canvas-based renderer
      SCViewer.scheduleRender(
        fmt,
        data,
        payload.width || 0,
        payload.height || 0,
        payload.quality || 0,
        payload.tier || 'unknown',
        payload.timestamp || 0
      );
      
      // Also keep the img element updated as fallback
      const mime = String(fmt).includes('/') ? String(fmt) : `image/${String(fmt)}`;
      remoteFrame.src = `data:${mime};base64,${data}`;
    }

    if (type === 'screen.broadcast.status') {
      if (payload?.platform) guestPlatform = String(payload.platform).toLowerCase();
      
      // Update capture stats if available
      if (payload?.captureStats) {
        SCViewer.lastTier = payload.captureStats.tierLabel || payload.captureStats.tier || 'unknown';
        SCViewer.lastFormat = payload.captureStats.format || 'jpeg';
      }
      
      const status = payload?.status || 'waiting';
      if (status === 'live') {
        setStatus('Broadcast live', payload?.message || 'Screen broadcast is live. Waiting for the next frame...');
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
          payload?.message || 'Mobile broadcast interrupted. Ask customer to restart broadcast and keep app in foreground.'
        );
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

      if (guestClientKind === 'ios-mobile-broadcast') guestPlatform = 'ios';
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
          ? 'iPhone/iPad customer is connected. Ask them to open the iOS support app and Start Broadcast.'
          : androidBroadcastClient
            ? 'Android customer is connected. Ask them to start screen sharing and approve capture permissions.'
            : browserShareClient
              ? 'Customer joined the session. Ask them to tap Start Broadcast / Share Screen.'
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
    
    if (type === 'permissions.update') {
      // Live permission updates from server
      if (payload) {
        if (typeof payload.input === 'boolean') {
          inputEnabled = payload.input;
          inputToggle.classList.toggle('active', inputEnabled);
        }
      }
    }
  });

  ws.addEventListener('close', () => {
    if (serverRejected) return;
    void showTroubleshootingStatus('Disconnected', 'The host client is no longer connected to the session. Retrying in 5s...');
    setTimeout(connect, 5000);
  });
}

function updateWaitingForMobileFramesStatus(payload = {}) {
  const isIos = guestPlatform === 'ios' || String(payload?.platform || '').toLowerCase() === 'ios' || Boolean(payload?.requiresNativeApp);
  const waitingTitle = isIos ? 'iPhone connected (waiting for screen broadcast)' : 'Mobile connected (waiting for screen broadcast)';
  const waitingMessage = isIos
    ? 'Customer iPhone joined but no screen frames yet. Ask customer to open iOS support app and Start Broadcast.'
    : 'Customer mobile joined but no screen frames yet. Ask customer to tap Start Broadcast / Share Screen.';
  showStatusPanel(waitingTitle, payload?.message || waitingMessage);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Input Handling (ScreenConnect-quality: pointer, keyboard, wheel, touch)
// ═══════════════════════════════════════════════════════════════════════════════

function isRemoteScreenInteractive() {
  return !blankScreenEnabled;
}

// Pointer event coalescing for smooth input at high frequency
let latestMovePayload = null;
let moveSendScheduled = false;
const MOVE_SEND_MAX_HZ = 60;
const MOVE_SEND_MIN_MS = 1000 / MOVE_SEND_MAX_HZ;
let lastMoveSendAt = 0;

function scheduleSendMove() {
  if (moveSendScheduled) return;
  moveSendScheduled = true;
  const doSend = () => {
    moveSendScheduled = false;
    if (!latestMovePayload) return;
    const nowTs = Date.now();
    if (nowTs - lastMoveSendAt < MOVE_SEND_MIN_MS) {
      setTimeout(doSend, MOVE_SEND_MIN_MS - (nowTs - lastMoveSendAt));
      return;
    }
    lastMoveSendAt = nowTs;
    send('input', latestMovePayload);
    latestMovePayload = null;
  };
  requestAnimationFrame(doSend);
}

function getRemotePoint(event) {
  // Use canvas-based coordinate mapping for accurate input
  if (SCViewer.currentImage && SCViewer.canvas) {
    return SCViewer.screenToRemote(event.clientX, event.clientY);
  }
  
  // Fallback to img-based mapping
  const imgBox = remoteFrame.getBoundingClientRect();
  let left = imgBox.left, top = imgBox.top, width = imgBox.width, height = imgBox.height;
  const nw = remoteFrame.naturalWidth || 0;
  const nh = remoteFrame.naturalHeight || 0;
  if (nw > 0 && nh > 0 && width > 0 && height > 0) {
    const frameRatio = nw / nh;
    const boxRatio = width / height;
    if (boxRatio > frameRatio) {
      height = imgBox.height;
      width = height * frameRatio;
      left = imgBox.left + (imgBox.width - width) / 2;
    } else {
      width = imgBox.width;
      height = width / frameRatio;
      top = imgBox.top + (imgBox.height - height) / 2;
    }
  }
  if (!(width > 0) || !(height > 0)) return { x: 0.5, y: 0.5 };
  const x = (event.clientX - left) / width;
  const y = (event.clientY - top) / height;
  return {
    x: Number(Math.min(1, Math.max(0, x)).toFixed(5)),
    y: Number(Math.min(1, Math.max(0, y)).toFixed(5))
  };
}

function handlePointerDown(event) {
  if (!inputEnabled || !isRemoteScreenInteractive() || !connected) return;
  event.preventDefault();
  lastInputAt = Date.now();
  
  // Middle-button pan when zoomed
  if (SCViewer.zoom > 1 && event.button === 1) {
    SCViewer.isPanning = true;
    SCViewer.panStartX = event.clientX - SCViewer.panX;
    SCViewer.panStartY = event.clientY - SCViewer.panY;
    return;
  }
  
  try { remoteScreen.setPointerCapture?.(event.pointerId); } catch {}
  remoteScreen.focus();
  
  const point = getRemotePoint(event);
  send('input', {
    kind: 'pointerdown',
    x: point.x,
    y: point.y,
    button: event.button >= 0 ? event.button : 0,
    buttons: event.buttons || 0,
    pointerType: event.pointerType || 'mouse',
    seq: nextInputSeq()
  });
}

function handlePointerMove(event) {
  if (!inputEnabled || !isRemoteScreenInteractive() || !connected) return;
  event.preventDefault();
  
  // Handle pan when zoomed
  if (SCViewer.isPanning && SCViewer.zoom > 1) {
    SCViewer.panX = event.clientX - SCViewer.panStartX;
    SCViewer.panY = event.clientY - SCViewer.panStartY;
    SCViewer.constrainPan();
    SCViewer.render();
    return;
  }
  
  const point = getRemotePoint(event);
  if (!point) return;
  
  latestMovePayload = {
    kind: 'pointermove',
    x: point.x,
    y: point.y,
    button: event.button >= 0 ? event.button : 0,
    buttons: event.buttons || 0,
    pointerType: event.pointerType || 'mouse',
    seq: nextInputSeq()
  };
  scheduleSendMove();
}

function handlePointerUp(event) {
  if (SCViewer.isPanning) {
    SCViewer.isPanning = false;
    return;
  }
  
  if (!inputEnabled || !isRemoteScreenInteractive() || !connected) return;
  event.preventDefault();
  lastInputAt = Date.now();
  
  try { remoteScreen.releasePointerCapture?.(event.pointerId); } catch {}
  
  const point = getRemotePoint(event);
  send('input', {
    kind: event.type === 'pointercancel' ? 'pointerup' : 'pointerup',
    x: point.x,
    y: point.y,
    button: event.button >= 0 ? event.button : 0,
    pointerType: event.pointerType || 'mouse',
    seq: nextInputSeq()
  });
}

function handleDoubleClick(event) {
  if (!inputEnabled || !isRemoteScreenInteractive() || !connected) return;
  event.preventDefault();
  const point = getRemotePoint(event);
  send('input', {
    kind: 'pointerdblclick',
    x: point.x,
    y: point.y,
    button: event.button >= 0 ? event.button : 0,
    pointerType: event.pointerType || 'mouse',
    seq: nextInputSeq()
  });
}

function handleContextMenu(event) {
  if (!inputEnabled || !isRemoteScreenInteractive() || !connected) return;
  event.preventDefault();
  // Right-click is handled via pointerdown with button=2
}

function handleWheel(event) {
  // Ctrl+Scroll = zoom the viewer itself
  if (event.ctrlKey || event.metaKey) return; // Handled by SCViewer
  
  if (!inputEnabled || !isRemoteScreenInteractive() || !connected) return;
  event.preventDefault();
  lastInputAt = Date.now();
  
  const point = getRemotePoint(event);
  send('input', {
    kind: 'wheel',
    x: point.x,
    y: point.y,
    deltaX: Math.max(-1200, Math.min(1200, Math.round(event.deltaX || 0))),
    deltaY: Math.max(-1200, Math.min(1200, Math.round(event.deltaY))),
    deltaMode: Number.isFinite(event.deltaMode) ? event.deltaMode : 0,
    seq: nextInputSeq()
  });
}

function sendKey(event) {
  if (!inputEnabled || !connected || !isRemoteScreenInteractive()) return;
  event.preventDefault();
  lastInputAt = Date.now();
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
}

// ═══════════════════════════════════════════════════════════════════════════════
// Control Actions
// ═══════════════════════════════════════════════════════════════════════════════

async function setServerInputPermission(value) {
  try {
    await fetch(`/api/session/${encodeURIComponent(sessionId)}/permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-token': token },
      body: JSON.stringify({ input: Boolean(value) })
    });
  } catch {}
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
  if (blankTile) blankTile.classList.toggle('enabled', blankScreenEnabled);
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
  send('block-input', { enabled: blockInputEnabled });
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

function captureScreenshot() {
  if (!SCViewer.currentImage) return;
  const link = document.createElement('a');
  link.download = `screenshot-${sessionId}-${Date.now()}.png`;
  
  const c = document.createElement('canvas');
  c.width = SCViewer.currentImage.naturalWidth;
  c.height = SCViewer.currentImage.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(SCViewer.currentImage, 0, 0);
  link.href = c.toDataURL('image/png');
  link.click();
  setStatus('Screenshot saved', 'The screenshot was saved to your downloads.');
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    const el = document.querySelector('.remote-window') || document.documentElement;
    el.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Event Bindings
// ═══════════════════════════════════════════════════════════════════════════════

// Bind to both the canvas and the remote screen container
remoteScreen.addEventListener('pointerdown', handlePointerDown);
remoteScreen.addEventListener('pointermove', handlePointerMove);
remoteScreen.addEventListener('pointerup', handlePointerUp);
remoteScreen.addEventListener('pointercancel', handlePointerUp);
remoteScreen.addEventListener('dblclick', handleDoubleClick);
remoteScreen.addEventListener('contextmenu', handleContextMenu);
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

// Window resize handler for canvas
window.addEventListener('resize', () => {
  if (SCViewer.currentImage) {
    requestAnimationFrame(() => SCViewer.render());
  }
});

inputToggle.classList.add('active');
inputToggle.addEventListener('click', toggleInput);
blankToggle.addEventListener('click', toggleBlankScreen);
if (blankTile) blankTile.addEventListener('click', toggleBlankScreen);
blockInputToggle?.addEventListener('click', () => toggleBlockInput());
if (blockGuest) blockGuest.addEventListener('click', () => toggleBlockInput());
fileQueue.addEventListener('click', () => queueFile().catch(() => setStatus('File queue failed', 'Could not queue the file transfer.')));

// Screenshot button
document.getElementById('snapshot')?.addEventListener('click', captureScreenshot);

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

// Start connection
connect();
