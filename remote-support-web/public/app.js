const els = {
  create: document.querySelector('#createSession'),
  sessions: document.querySelector('#sessions'),
  devices: document.querySelector('#devices'),
  count: document.querySelector('#sessionCount'),
  deviceCount: document.querySelector('#deviceCount'),
  title: document.querySelector('#viewerTitle'),
  meta: document.querySelector('#viewerMeta'),
  connectionIcon: document.querySelector('#connectionIcon'),
  pill: document.querySelector('#statusPill'),
  video: document.querySelector('#remoteVideo'),
  nativeFrame: document.querySelector('#nativeFrame'),
  viewerPanel: document.querySelector('.viewer-panel'),
  empty: document.querySelector('#viewerEmpty'),
  code: document.querySelector('#joinCode'),
  link: document.querySelector('#customerLink'),
  linkText: document.querySelector('#customerLinkText'),
  email: document.querySelector('#customerEmail'),
  sendInviteEmail: document.querySelector('#sendInviteEmail'),
  customerName: document.querySelector('#customerName'),
  copyCode: document.querySelector('#copyCode'),
  copyLink: document.querySelector('#copyLink'),
  audit: document.querySelector('#auditLog'),
  terminalForm: document.querySelector('#terminalForm'),
  terminalInput: document.querySelector('#terminalInput'),
  terminalOutput: document.querySelector('#terminalOutput'),
  fileButton: document.querySelector('#queueFile'),
  recording: document.querySelector('#toggleRecording'),
  endSession: document.querySelector('#endSession'),
  connectSession: document.querySelector('#connectSession'),
  renameSession: document.querySelector('#renameSession'),
  renameSessionName: document.querySelector('#renameSessionName'),
  moreSessionTools: document.querySelector('#moreSessionTools'),
  deleteAllSessions: document.querySelector('#deleteAllSessions'),
  sessionMenu: document.querySelector('#sessionMenu'),
  selectAllSessions: document.querySelector('#selectAllSessions'),
  sessionSearch: document.querySelector('#sessionSearch'),
  blankScreen: document.querySelector('#toggleBlankScreen'),
  blockInput: document.querySelector('#toggleBlockInput'),
  toggleFullscreen: document.querySelector('#toggleFullscreen'),
  sendCAD: document.querySelector('#sendCtrlAltDel'),
  hostJoin: document.querySelector('#hostJoin'),
  hostLaunchOverlay: document.querySelector('#hostLaunchOverlay'),
  hostLaunchClose: document.querySelector('#hostLaunchClose'),
  hostLaunchRetry: document.querySelector('#hostLaunchRetry'),
  hostJoinBrowser: document.querySelector('#hostJoinBrowser'),
  hostLaunchStatus: document.querySelector('#hostLaunchStatus'),
  hostLaunchDetail: document.querySelector('#hostLaunchDetail'),
  hostViewerDownload: document.querySelector('#hostViewerDownload'),
  permissionSummary: document.querySelector('#permissionSummary'),
  showSessions: document.querySelector('#showSessions'),
  showDevices: document.querySelector('#showDevices'),
  showReport: document.querySelector('#showReport'),
  reportPane: document.querySelector('#reportPane'),
  reportText: document.querySelector('#screenconnectReportText'),
  sessionPane: document.querySelector('.session-pane'),
  createSessionMenu: document.querySelector('#createSessionMenu'),
  joinByCode: document.querySelector('#joinByCode'),
  joinByCodeButton: document.querySelector('#joinByCodeButton'),
  joinByCodeStatus: document.querySelector('#joinByCodeStatus'),
  sessionTypeTabs: document.querySelectorAll('.session-type-tab'),
  infoHostname: document.querySelector('#infoHostname'),
  infoOs: document.querySelector('#infoOs'),
  infoIp: document.querySelector('#infoIp'),
  infoAgent: document.querySelector('#infoAgent'),
  infoDeviceId: document.querySelector('#infoDeviceId'),
  infoLastSeen: document.querySelector('#infoLastSeen'),
  historyList: document.querySelector('#historyList'),
  viewerPane: document.querySelector('#viewerPane'),
  viewerActiveTitle: document.querySelector('#viewerActiveTitle'),
  hostJoinLarge: document.querySelector('#hostJoinLarge'),
  toggleFullscreenLarge: document.querySelector('#toggleFullscreenLarge'),
  waitingStateLarge: document.querySelector('#waitingStateLarge'),
  connectionIconLarge: document.querySelector('#connectionIconLarge'),
  viewerMetaLarge: document.querySelector('#viewerMetaLarge'),
  remoteVideoLarge: document.querySelector('#remoteVideoLarge'),
  nativeFrameLarge: document.querySelector('#nativeFrameLarge'),
  nativeFrameLargeCanvas: document.querySelector('#nativeFrameLargeCanvas'),
  nativeFrameCanvas: document.querySelector('#nativeFrameCanvas'),
  remoteFrameCanvas: document.querySelector('#remoteFrameCanvas'),
  renderModeToggle: document.querySelector('#renderModeToggle'),
  renderModeToggleLarge: document.querySelector('#renderModeToggleLarge'),
  requestCaptureQuality: document.querySelector('#requestCaptureQuality'),
  requestCaptureQualityLarge: document.querySelector('#requestCaptureQualityLarge'),
  sendCADLarge: document.querySelector('#sendCtrlAltDelLarge'),
  toggleBlankScreenLarge: document.querySelector('#toggleBlankScreenLarge'),
  toggleBlockInputLarge: document.querySelector('#toggleBlockInputLarge'),
  queueFileLarge: document.querySelector('#queueFileLarge'),
  toggleRecordingLarge: document.querySelector('#toggleRecordingLarge'),
  sessionListPane: document.querySelector('#sessionListPane'),
};

let devices = [];
let sessions = [];
let audit = [];
let active = null;
let activeDevice = null;
let ws = null;
let technicianWsRejected = false;
let autoJoiningSessionId = null;
let pc = null;
let inputEnabled = false;
let blankScreenEnabled = false;
let publicBaseUrl = location.origin;
let newestPortalFrame = null;
let portalFrameRenderScheduled = false;
let useCanvasRendering = true;
let highQualityRequested = false;
let lastHostClientUrl = '';
let lastHostViewerUrl = '';
let pendingHostDeepLink = null;
let applyingHostDeepLink = false;

function renderNewestPortalFrame() {
  portalFrameRenderScheduled = false;
  const frame = newestPortalFrame;
  newestPortalFrame = null;
  if (!frame) return;
  // Prefer canvas rendering when enabled. Keep <img> as fallback and for natural size info.
  if (useCanvasRendering) {
    drawPortalFrameToCanvases(frame.src);
    if (els.nativeFrame) els.nativeFrame.hidden = true;
  } else {
    if (els.nativeFrame) {
      els.nativeFrame.src = frame.src;
      els.nativeFrame.hidden = false;
    }
    if (els.nativeFrameLarge) {
      els.nativeFrameLarge.src = frame.src;
      els.nativeFrameLarge.hidden = false;
    }
  }
  els.empty.hidden = true;
  if (els.waitingStateLarge) els.waitingStateLarge.hidden = true;
  frame.session.status = 'active';
  frame.session.nativeConnected = true;
  applySessionConnectionStatus(frame.session, true);
}

function drawPortalFrameToCanvases(src) {
  const img = new Image();
  img.onload = () => {
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
      const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
      const dw = Math.round(img.naturalWidth * scale);
      const dh = Math.round(img.naturalHeight * scale);
      const dx = Math.round((canvas.width - dw) / 2);
      const dy = Math.round((canvas.height - dh) / 2);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, dx, dy, dw, dh);
    };

    draw(els.nativeFrameCanvas);
    draw(els.nativeFrameLargeCanvas);
    draw(els.remoteFrameCanvas);
  };
  img.src = src;
}

function schedulePortalFrameRender(session, payload) {
  newestPortalFrame = {
    session,
    src: `data:image/${payload.format || 'jpeg'};base64,${payload.data}`
  };

  if (portalFrameRenderScheduled) return;
  portalFrameRenderScheduled = true;
  requestAnimationFrame(renderNewestPortalFrame);
}

// Render mode toggle handling
function setUseCanvasRendering(value) {
  useCanvasRendering = Boolean(value);
  if (els.renderModeToggle) els.renderModeToggle.textContent = useCanvasRendering ? 'Canvas' : 'Image';
  if (els.renderModeToggleLarge) els.renderModeToggleLarge.textContent = useCanvasRendering ? 'Canvas' : 'Image';
  // Show/hide canvases accordingly
  if (!useCanvasRendering) {
    if (els.nativeFrame) els.nativeFrame.hidden = false;
    if (els.nativeFrameCanvas) els.nativeFrameCanvas.hidden = true;
    if (els.remoteFrameCanvas) els.remoteFrameCanvas.hidden = true;
    if (els.nativeFrameLargeCanvas) els.nativeFrameLargeCanvas.hidden = true;
  } else {
    if (els.nativeFrame) els.nativeFrame.hidden = true;
    if (els.nativeFrameCanvas) els.nativeFrameCanvas.hidden = false;
    if (els.remoteFrameCanvas) els.remoteFrameCanvas.hidden = false;
    if (els.nativeFrameLargeCanvas) els.nativeFrameLargeCanvas.hidden = false;
  }
}

if (els.renderModeToggle) els.renderModeToggle.addEventListener('click', () => setUseCanvasRendering(!useCanvasRendering));
if (els.renderModeToggleLarge) els.renderModeToggleLarge.addEventListener('click', () => setUseCanvasRendering(!useCanvasRendering));
// Initialize default
setUseCanvasRendering(true);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function timeAgo(value) {
  if (!value) return 'never';
  const seconds = Math.max(1, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function writeAudit(text) {
  audit.unshift({
    at: Date.now(),
    message: text
  });

  // Quality request buttons
  if (els.requestCaptureQuality) {
    els.requestCaptureQuality.addEventListener('click', () => {
      highQualityRequested = !highQualityRequested;
      els.requestCaptureQuality.textContent = highQualityRequested ? 'HQ✓' : 'HQ';
      const settings = highQualityRequested ? { format: 'webp', quality: 0.9, maxDimension: 1920, fps: 15 } : { format: 'jpeg', quality: 0.6, maxDimension: 1280, fps: 10 };
      try {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'screen.capture.settings', payload: settings }));
        writeAudit(`Requested ${highQualityRequested ? 'high' : 'standard'} quality frames`);
      } catch (e) { console.warn('Could not send capture settings request', e); }
    });
  }

  if (els.requestCaptureQualityLarge) {
    els.requestCaptureQualityLarge.addEventListener('click', () => {
      highQualityRequested = !highQualityRequested;
      els.requestCaptureQualityLarge.textContent = highQualityRequested ? 'HQ✓' : 'HQ';
      const settings = highQualityRequested ? { format: 'webp', quality: 0.9, maxDimension: 1920, fps: 15 } : { format: 'jpeg', quality: 0.6, maxDimension: 1280, fps: 10 };
      try {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'screen.capture.settings', payload: settings }));
        writeAudit(`Requested ${highQualityRequested ? 'high' : 'standard'} quality frames`);
      } catch (e) { console.warn('Could not send capture settings request', e); }
    });
  }
  audit = audit.slice(0, 10);
  renderAudit();
}

function setStatus(label) {
  els.pill.textContent = label;
  els.pill.dataset.status = label.toLowerCase().replaceAll(' ', '-');
  els.pill.hidden = false;
}

function sessionIsCustomerLive(session) {
  return Boolean(session?.nativeConnected || session?.screenStreaming || session?.status === 'active' || session?.status === 'customer_joined');
}

function sessionInstallerStarted(session) {
  return Boolean(session?.nativeClaimed) && !sessionIsCustomerLive(session);
}

function sessionWaitingForScreenShare(session) {
  return Boolean(session?.browserConnected) && !sessionIsCustomerLive(session);
}

function sessionStreamStale(session) {
  return ['stream_stale', 'reconnect_required'].includes(String(session?.customerScreenStatus || '').toLowerCase());
}

function isIosPlatformValue(platform) {
  const value = String(platform || '').toLowerCase();
  return value === 'ios' || value === 'iphone' || value === 'ipad';
}

function sessionRequiresMobileApp(session) {
  return isIosPlatformValue(session?.customerPlatform) &&
    session?.customerCapabilities?.screenCapture === false &&
    !sessionIsCustomerLive(session);
}

function sessionActivityTime(session) {
  return Math.max(
    Number(session?.lastSeen?.endpoint || 0),
    Number(session?.lastSeen?.technician || 0),
    Number(session?.createdAt || 0)
  );
}

function newestLiveSession() {
  return sessions
    .filter(sessionIsCustomerLive)
    .sort((a, b) => sessionActivityTime(b) - sessionActivityTime(a))[0] || null;
}

function customerStatusLabel(session) {
  if (!session) return 'Created';
  if (session.permanentAccess && session.status === 'online') return 'Online';
  if (session.permanentAccess && session.status === 'offline') return 'Offline';
  if (session.status === 'active') return 'Remote support session live';
  if (sessionRequiresMobileApp(session)) return 'iOS app required';
  if (sessionWaitingForScreenShare(session)) return 'Waiting for screen broadcast';
  if (sessionIsCustomerLive(session)) return 'Customer support app connected';
  if (sessionInstallerStarted(session)) return 'Client stuck on connecting';
  return session.status || 'Created';
}

function sessionKindLabel(session) {
  const kind = String(session?.sessionType || (session?.permanentAccess ? 'access' : 'support')).toLowerCase();
  if (kind === 'meeting') return 'Meeting';
  if (kind === 'access') return 'Access';
  return 'Support';
}

const SESSION_TYPE_FILTER = { value: 'all' };

function sessionMatchesFilter(session) {
  if (SESSION_TYPE_FILTER.value === 'all') return true;
  return (session?.sessionType || (session?.permanentAccess ? 'access' : 'support')) === SESSION_TYPE_FILTER.value;
}

function applySessionConnectionStatus(session, hasFrame = false) {
  const updateLarge = (icon, meta, status) => {
    if (els.connectionIconLarge) els.connectionIconLarge.textContent = icon;
    if (els.viewerMetaLarge) els.viewerMetaLarge.textContent = meta;
    if (els.waitingStateLarge) els.waitingStateLarge.hidden = hasFrame || session?.status === 'active';
    if (els.viewerActiveTitle) els.viewerActiveTitle.textContent = session ? displayNameForSession(session) : 'No client selected';
  };

  if (!session) {
    els.connectionIcon.textContent = '\u231b';
    els.connectionIcon.classList.remove('connected');
    els.meta.textContent = 'Invite customer to session or generate support code.';
    setStatus('No Session');
    updateLarge('\u231b', 'Invite customer to session or generate support code.', 'No Session');
    return;
  }

  if (hasFrame || session.status === 'active') {
    els.connectionIcon.textContent = '\u2713';
    els.connectionIcon.classList.add('connected');
    let metaText = 'Client is live. You can connect with admin tools.';
    if (session.lastFrameDropReason) {
      metaText = `Live (Latency warning: ${session.lastFrameDropReason})`;
      els.connectionIcon.textContent = '!';
    }
    els.meta.textContent = metaText;
    setStatus('Client Live');
    updateLarge('\u2713', metaText, 'Client Live');
    return;
  }

  if (sessionIsCustomerLive(session)) {
    els.connectionIcon.textContent = '\u2713';
    els.connectionIcon.classList.add('connected');
    els.meta.textContent = 'Client connected. Host can join now.';
    setStatus('Client Online');
    updateLarge('\u2713', 'Client connected. Host can join now.', 'Client Online');
    return;
  }

  if (sessionWaitingForScreenShare(session) || sessionStreamStale(session)) {
    els.connectionIcon.textContent = '\u231b';
    els.connectionIcon.classList.remove('connected');
    const isIos = isIosPlatformValue(session.customerPlatform);
    const isAndroid = session.customerPlatform === 'android';
    const streamStale = sessionStreamStale(session);

    if (streamStale) {
      els.meta.textContent = 'Mobile broadcast interrupted or stale. Ask customer to reopen app and restart screen broadcast.';
      setStatus('Reconnect Required');
      updateLarge('\u231b', els.meta.textContent, 'Reconnect Required');
      return;
    }

    if (isIos) {
      els.meta.textContent = 'Customer joined from iPhone/iPad. Ask them to open the iOS support app: Visit Host URL, Enter Code, Initiate ScreenShare, then Start Broadcast.';
    } else if (isAndroid) {
      els.meta.textContent = 'Customer joined from Android. Ask them to open the mobile support app, grant Accessibility/Screen Capture, then Start Broadcast.';
    } else {
      els.meta.textContent = 'Customer joined. Ask them to tap Start Broadcast / Share Screen.';
    }
    setStatus(isIos ? 'iOS App Required' : (isAndroid ? 'Android App Required' : 'Waiting For Screen'));
    updateLarge('\u231b', els.meta.textContent, isIos ? 'iOS App Required' : (isAndroid ? 'Android App Required' : 'Waiting For Screen'));
    return;
  }

  if (sessionInstallerStarted(session)) {
    els.connectionIcon.textContent = '\u231b';
    els.connectionIcon.classList.remove('connected');
    els.meta.textContent = 'Support client installer started. Remote support session not connecting yet.';
    setStatus('Client Connecting');
    updateLarge('\u231b', els.meta.textContent, 'Client Connecting');
    return;
  }

  els.connectionIcon.textContent = '\u231b';
  els.connectionIcon.classList.remove('connected');
  els.meta.textContent = 'Waiting for customer to run the support client installer.';
  setStatus(session.status || 'Created');
  updateLarge('\u231b', els.meta.textContent, session.status || 'Created');
}

function customerUrl(session) {
  const url = new URL('/', publicBaseUrl);
  url.searchParams.set('code', session.joinCode || session.sessionId);
  return url.toString();
}

function hostSessionHash(session, action = '') {
  if (!session?.sessionId) return '#Support/My%20Sessions';
  return `#Support/My%20Sessions//${encodeURIComponent(session.sessionId)}${action ? `/${action}` : ''}`;
}

function parseHostDeepLink() {
  const hash = decodeURIComponent(location.hash || '').replace(/^#/, '');
  const match = hash.match(/^Support\/My Sessions\/\/([^/]+)(?:\/([^/]+))?/i);
  if (!match) return null;
  return {
    sessionId: match[1],
    action: (match[2] || '').toLowerCase()
  };
}

function updateHostDeepLink(session, action = '') {
  if (!session?.sessionId) return;
  if (!/^\/host\/?$/i.test(location.pathname)) return;
  const next = hostSessionHash(session, action);
  if (location.hash === next) return;
  history.replaceState(null, '', `${location.pathname}${next}`);
}

function publicWebSocketUrl(params) {
  const url = new URL(publicBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/';
  url.search = params.toString();
  return url.toString();
}

let globalWs = null;

function connectGlobalUpdates() {
  if (globalWs) globalWs.close();
  const params = new URLSearchParams({
    role: 'agent',
    sessionId: 'global'
  });
  globalWs = new WebSocket(publicWebSocketUrl(params));
  globalWs.onmessage = (event) => {
    const { type, payload } = JSON.parse(event.data);
    if (type === 'session.update') {
      handleSessionUpdate(payload?.sessionId).catch((err) => console.warn('Could not follow customer session update:', err));
    }
    if (type === 'device.update') {
      refreshDevices().catch(() => {});
    }
  };
  globalWs.onclose = () => {
    setTimeout(connectGlobalUpdates, 5000);
  };
}

async function handleSessionUpdate(sessionId) {
  if (!sessionId) return;
  await refreshSessions();

  if (active?.sessionId === sessionId) {
    await refreshActiveSession();
    return;
  }

  const updatedSession = sessions.find((session) => session.sessionId === sessionId);
  // Never replace a session the technician deliberately selected. Auto-join is
  // only for an otherwise empty console.
  if (!sessionIsCustomerLive(updatedSession) || active || autoJoiningSessionId === sessionId) return;

  autoJoiningSessionId = sessionId;
  try {
    await selectSession(updatedSession);
    writeAudit(`Customer joined session ${updatedSession.joinCode || updatedSession.sessionId}; technician channel opened`);
  } finally {
    autoJoiningSessionId = null;
  }
}

async function loadConfig() {
  const response = await fetch('/api/config');
  if (!response.ok) return;
  const config = await response.json();
  if (config.publicBaseUrl) publicBaseUrl = config.publicBaseUrl;
}

async function loadScreenConnectReport() {
  if (!els.reportText) return;
  try {
    const response = await fetch('/SCREENCONNECT_ANALYSIS_REPORT.md', { cache: 'no-store' });
    if (!response.ok) {
      els.reportText.textContent = 'Could not load SCREENCONNECT_ANALYSIS_REPORT.md';
      return;
    }
    const text = await response.text();
    els.reportText.textContent = text;
  } catch (err) {
    els.reportText.textContent = `Could not load report: ${err.message}`;
  }
}

function displayNameForSession(session) {
  return session.displayName || session.deviceName || session.sessionId;
}

async function ensureActiveSession() {
  if (active) return active;
  if (!sessions.length) return null;
  await selectSession(sessions[0]);
  return active;
}

function renderDevices() {
  const search = els.sessionSearch?.value.trim().toLowerCase() || '';
  const filteredDevices = devices
    .filter((device) => {
      if (!search) return true;
      return [
        device.name,
        device.hostname,
        device.os,
        device.id,
        device.ip
      ].some((value) => String(value || '').toLowerCase().includes(search));
    })
    .sort((a, b) => {
      // Prioritize online status
      const aOnline = a.status === 'online' ? 1 : 0;
      const bOnline = b.status === 'online' ? 1 : 0;
      if (aOnline !== bOnline) return bOnline - aOnline;
      // Then sort by last seen (most recent first)
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });

  const visibleCount = filteredDevices.length;
  els.deviceCount.textContent = visibleCount;
  els.devices.innerHTML = '';
  els.devices.hidden = false;

  for (const device of filteredDevices) {
    const button = document.createElement('button');
    const online = device.status === 'online';
    button.className = `session-card ${activeDevice?.id === device.id ? 'selected' : ''} ${online ? 'customer-joined' : ''}`;
    button.type = 'button';
    button.innerHTML = `
      <span class="row-check ${activeDevice?.id === device.id ? 'checked' : ''}" aria-hidden="true"></span>
      <span class="session-copy">
        <strong>${escapeHtml(device.name || device.hostname)}</strong>
        <small>${escapeHtml(device.os)} • IP: ${escapeHtml(device.ip)}</small>
        <small>Agent: ${escapeHtml(device.agentVersion)} • ID: ${escapeHtml(device.id)}</small>
        <small>Last seen: ${escapeHtml(timeAgo(device.lastSeen))}</small>
      </span>
      <div class="session-actions">
        <button class="action-btn join-action" type="button" title="Connect to device">Connect</button>
      </div>
      <span class="session-agents" aria-hidden="true">
        <span class="agent-head"></span>
        <span class="agent-lines"></span>
        <span class="agent-status">${escapeHtml(device.status)}</span>
        <span class="agent-user"></span>
      </span>
    `;
    button.addEventListener('click', (e) => {
      if (e.target.closest('.action-btn')) return;
      selectDevice(device);
    });
    button.querySelector('.join-action').addEventListener('click', (e) => {
      e.stopPropagation();
      selectDevice(device).then(() => launchHostClient());
    });
    els.devices.append(button);
  }
}

function renderSessions() {
  const search = els.sessionSearch?.value.trim().toLowerCase() || '';
  const filteredSessions = sessions.filter((session) => {
    if (!sessionMatchesFilter(session)) return false;
    if (!search) return true;
    return [
      displayNameForSession(session),
      session.sessionId,
      session.status,
      session.deviceName,
      session.sessionType
    ].some((value) => String(value || '').toLowerCase().includes(search));
  });
  const visibleCount = filteredSessions.length;
  els.count.textContent = visibleCount;
  els.sessions.className = visibleCount ? 'session-stack' : 'empty';
  const filterLabel = SESSION_TYPE_FILTER.value === 'all' ? '' : ` ${SESSION_TYPE_FILTER.value}`;
  els.sessions.innerHTML = visibleCount ? '' : `No active${filterLabel} sessions. Click + Create Session to start a new one.`;

  for (const session of filteredSessions) {
    const button = document.createElement('button');
    const customerLive = sessionIsCustomerLive(session);
    button.className = `session-card ${active === session ? 'selected' : ''} ${customerLive ? 'customer-joined' : ''}`;
    button.type = 'button';
    const displayName = displayNameForSession(session);
    const statusLabel = customerStatusLabel(session);
    const kindLabel = sessionKindLabel(session);
    button.innerHTML = `
      <span class="row-check ${active === session ? 'checked' : ''}" aria-hidden="true"></span>
      <span class="session-copy">
        <strong>${escapeHtml(displayName)}</strong>
        <small>Client: ${escapeHtml(session.deviceName || 'ad-hoc')} • ${escapeHtml(session.customerPlatform || 'Unknown OS')}</small>
        <small><span class="session-kind" data-kind="${escapeHtml(String(session.sessionType || (session.permanentAccess ? 'access' : 'support')).toLowerCase())}">${escapeHtml(kindLabel)}</span> ${escapeHtml(session.joinCode)} &mdash; ${escapeHtml(statusLabel)}</small>
      </span>
      <span class="session-agents" aria-hidden="true">
        <span class="agent-head"></span>
        <span class="agent-lines"></span>
        <span class="agent-status">${escapeHtml(statusLabel)}</span>
        <span class="agent-user"></span>
      </span>
    `;
    button.addEventListener('click', () => selectSession(session));
    button.addEventListener('dblclick', () => {
      selectSession(session).then(() => launchHostClient()).catch((err) => writeAudit(err.message));
    });
    els.sessions.append(button);
  }

}

function renderAudit() {
  els.audit.innerHTML = '';
  for (const entry of audit.slice(0, 10)) {
    const item = document.createElement('li');
    const at = entry.at ? new Date(entry.at).toLocaleTimeString() : '';
    item.textContent = `${at} ${entry.message}`;
    els.audit.append(item);
  }
}

function renderPermissions(session) {
  if (!session?.permissions) {
    els.permissionSummary.textContent = 'Screen, input, files, terminal, recording';
    return;
  }
  const enabled = Object.entries(session.permissions)
    .filter(([, allowed]) => allowed)
    .map(([name]) => name);
  els.permissionSummary.textContent = enabled.join(', ');
}

async function selectDevice(device) {
  activeDevice = device;
  active = null;
  populateDeviceInfo(device);
  const response = await fetch('/api/session/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: device.id, permanentAccess: true, sessionType: 'access' })
  });
  if (response.ok) {
    const session = await response.json();
    await refreshSessions();
    const fullSession = sessions.find(s => s.sessionId === session.sessionId);
    if (fullSession) {
      await selectSession(fullSession);
    }
  }
  renderDevices();
}

async function refreshDevices() {
  const response = await fetch('/api/devices');
  if (!response.ok) return;
  devices = await response.json();
  renderDevices();
}

async function refreshSessions() {
  const response = await fetch('/api/sessions');
  if (!response.ok) return;
  const activeId = active?.sessionId;
  sessions = await response.json();
  if (activeId) {
    active = sessions.find((session) => session.sessionId === activeId) || null;
    if (!active && els.selectAllSessions) els.selectAllSessions.checked = false;
  }
  renderSessions();
}

async function refreshAudit() {
  const response = await fetch('/api/audit');
  if (response.ok) {
    audit = await response.json();
    renderAudit();
  }
}

function populateDeviceInfo(device) {
  if (!device) return;
  els.infoHostname.textContent = device.name || device.hostname || '-';
  els.infoOs.textContent = device.os || '-';
  els.infoIp.textContent = device.ip || '-';
  els.infoAgent.textContent = device.agentVersion || '-';
  els.infoDeviceId.textContent = device.id || '-';
  els.infoLastSeen.textContent = timeAgo(device.lastSeen);
}

async function selectSession(session) {
  active = session;
  updateHostDeepLink(session);
  const statusResponse = await fetch(`/api/session/${encodeURIComponent(session.sessionId)}/status`);
  if (statusResponse.ok) {
    Object.assign(session, await statusResponse.json());
  }

  const device = session.deviceId ? devices.find(d => d.id === session.deviceId) : null;
  populateDeviceInfo(device || {
    name: session.deviceName,
    hostname: session.deviceName,
    os: session.customerPlatform,
    ip: 'Unknown',
    agentVersion: 'Browser',
    id: session.deviceId || 'N/A',
    lastSeen: session.lastSeen?.endpoint
  });

  const displayName = displayNameForSession(session);
  els.title.textContent = displayName;
  if (els.customerName) els.customerName.value = displayName;
  els.code.value = session.joinCode;
  els.link.value = customerUrl(session);
  els.linkText.textContent = customerUrl(session);
  renderPermissions(session);
  if (session.permanentAccess) {
    els.permissionSummary.textContent = 'Support client installer. Customer authorization and Windows UAC approval are required before remote keyboard input, remote mouse input, and file tools are enabled.';
  }
  renderSessionJobs(session);
  applySessionConnectionStatus(session);
  if (els.selectAllSessions) els.selectAllSessions.checked = true;
  renderSessions();
  
  if (sessionIsCustomerLive(session)) {
    els.viewerPane.hidden = false;
    els.sessionListPane.hidden = true;
  } else {
    els.viewerPane.hidden = true;
    els.sessionListPane.hidden = false;
  }

  connectTechnician(session);
}

async function createSession(sessionType = 'support') {
  const normalizedType = String(sessionType || 'support').toLowerCase();
  const permanentAccess = normalizedType === 'access';
  const response = await fetch('/api/session/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: null, permanentAccess, sessionType: normalizedType })
  });
  if (!response.ok) throw new Error('Could not create session');
  const session = await response.json();
  session.createdAt = Date.now();
  session.status = 'created';
  session.permanentAccess = Boolean(session.permanentAccess);
  session.sessionType = session.sessionType || normalizedType;
  session.deviceName = session.deviceName || (
    normalizedType === 'meeting' ? 'Meeting session'
      : normalizedType === 'access' ? 'Unattended access'
        : 'Ad-hoc browser guest'
  );
  session.displayName = session.displayName || session.deviceName;
  sessions.unshift(session);
  writeAudit(`Created ${sessionKindLabel(session)} session ${session.sessionId}`);
  await refreshAudit();
  await selectSession(session);
}

function toggleCreateSessionMenu(force) {
  const menu = els.createSessionMenu;
  if (!menu) return;
  const shouldShow = typeof force === 'boolean' ? force : menu.hidden;
  menu.hidden = !shouldShow;
  els.createSession?.setAttribute('aria-expanded', String(shouldShow));
}

function joinSessionByCode() {
  const input = els.joinByCode;
  const status = els.joinByCodeStatus;
  const button = els.joinByCodeButton;
  if (!input) return;
  const raw = String(input.value || '').trim();
  if (!raw) {
    if (status) {
      status.textContent = 'Enter a join code first.';
      status.classList.add('error');
      status.hidden = false;
    }
    return;
  }
  const stripped = raw.replace(/[^a-zA-Z0-9-]/g, '').toUpperCase();
  const customerUrl = new URL('/', publicBaseUrl || location.origin);
  customerUrl.searchParams.set('code', stripped);
  writeAudit(`Host joining session ${stripped} via customer URL`);
  if (status) {
    status.textContent = `Opening ${customerUrl.toString()} in a new tab…`;
    status.classList.remove('error');
    status.classList.add('success');
    status.hidden = false;
  }
  if (button) button.disabled = true;
  try {
    const win = window.open(customerUrl.toString(), '_blank', 'noopener');
    if (!win && status) {
      status.textContent = 'Popup blocked. Allow popups or paste the URL into the Join page.';
      status.classList.add('error');
      status.classList.remove('success');
    }
  } finally {
    setTimeout(() => {
      if (button) button.disabled = false;
    }, 1500);
  }
}

let reconnectTimeout = null;

function connectTechnician(session) {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  technicianWsRejected = false;
  let technicianWsReady = false;
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
  }
  if (pc) pc.close();

  pc = new RTCPeerConnection();
  pc.ontrack = (event) => {
    els.video.srcObject = event.streams[0];
    if (els.remoteVideoLarge) els.remoteVideoLarge.srcObject = event.streams[0];
    els.nativeFrame.hidden = true;
    if (els.nativeFrameLarge) els.nativeFrameLarge.hidden = true;
    els.empty.hidden = true;
    if (els.waitingStateLarge) els.waitingStateLarge.hidden = true;
    els.viewerPane.hidden = false;
    els.sessionListPane.hidden = true;
    applySessionConnectionStatus(session, true);
    writeAudit('Screen stream connected');
  };
  pc.onicecandidate = (event) => {
    if (event.candidate) send('ice', event.candidate);
  };

  const params = new URLSearchParams({
    role: 'agent',
    client: 'portal',
    sessionId: session.sessionId,
    token: session.agentPortalToken
  });
  ws = new WebSocket(publicWebSocketUrl(params));

  ws.onclose = () => {
    if (technicianWsRejected) return;
    writeAudit('Technician signaling channel closed. Retrying in 5s...');
    reconnectTimeout = setTimeout(() => connectTechnician(session), 5000);
  };

  ws.onerror = (err) => {
    writeAudit('Signaling error occurred.');
    console.error('WS error:', err);
  };

  ws.addEventListener('open', () => {
    writeAudit('Technician WebSocket transport opened; waiting for session authorization');
  });

  ws.addEventListener('message', async (event) => {
    const { type, payload } = JSON.parse(event.data);
    if (type === 'session.rejected') {
      technicianWsRejected = true;
      setStatus('Technician connection rejected');
      writeAudit(`Technician WebSocket rejected: ${payload?.message || 'The server rejected this session connection.'}`);
      ws?.close();
      return;
    }
    if (type === 'error') {
      writeAudit(`Technician session warning: ${payload?.message || 'The server reported an error.'}`);
      return;
    }
    if (type === 'session.ready') {
      if (payload?.role !== 'agent') return;
      technicianWsReady = true;
      try {
        const statusResponse = await fetch(`/api/session/${encodeURIComponent(session.sessionId)}/status`);
        if (statusResponse.ok) Object.assign(session, await statusResponse.json());
      } catch {}
      applySessionConnectionStatus(session);
      writeAudit('Technician secure session channel connected');
      renderSessions();
      return;
    }
    if (type === 'offer') {
      await pc.setRemoteDescription(payload);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send('answer', answer);
      setStatus('Connecting');
    }
    if (type === 'ice') await pc.addIceCandidate(payload);
    if (type === 'screen.frame') {
      session.screenStreaming = true;
      schedulePortalFrameRender(session, payload);
    }
    if (type === 'screen.broadcast.status') {
      session.customerPlatform = payload?.platform || session.customerPlatform;
      session.customerCapabilities = {
        ...(session.customerCapabilities || {}),
        screenCapture: Boolean(payload?.screenCapture),
        remoteControl: !payload?.requiresNativeApp
      };
      session.customerScreenStatus = payload?.status || session.customerScreenStatus;

      if (payload?.status === 'unavailable') {
        writeAudit(payload?.requiresNativeApp ? 'iPhone/iPad app required for screen broadcast' : 'Customer browser cannot share screen');
      } else if (payload?.status === 'stream_stale') {
        writeAudit('Mobile stream stale: waiting for customer to restart broadcast');
      } else if (payload?.status === 'reconnect_required') {
        writeAudit('Mobile reconnect required: heartbeat timeout');
      } else if (payload?.status === 'starting') {
        writeAudit('Customer connected; waiting for first screen frame');
      } else if (payload?.status === 'ios_broadcast_connected_waiting_first_frame') {
        writeAudit('iOS broadcast connected; waiting for first ReplayKit frame');
      } else if (payload?.status === 'android_broadcast_connected_waiting_first_frame') {
        writeAudit('Android broadcast connected; waiting for first MediaProjection frame');
      }

      applySessionConnectionStatus(session);
      renderSessions();
    }
    if (type === 'peer.connected' && payload?.role === 'customer') {
      session.status = 'customer_joined';
      const kind = String(payload?.clientKind || '').toLowerCase();
      const mobileBroadcastKinds = new Set(['ios-mobile-broadcast', 'android-mobile-broadcast', 'mobile-broadcast']);
      session.browserConnected = kind === 'browser-share' || mobileBroadcastKinds.has(kind);
      session.nativeConnected = kind !== 'browser-share' && !mobileBroadcastKinds.has(kind);
      applySessionConnectionStatus(session);
      writeAudit(
        session.browserConnected
          ? (mobileBroadcastKinds.has(kind)
              ? 'Customer mobile broadcast connected; waiting for first screen frame'
              : 'Customer browser connected; waiting for screen broadcast')
          : 'Customer support app connected'
      );
      renderSessions();
    }
    if (type === 'peer.disconnected' && payload?.role === 'customer') {
      session.nativeConnected = false;
      session.browserConnected = false;
      session.screenStreaming = false;
      if (session.status === 'active' || session.status === 'customer_joined') session.status = 'waiting';
      applySessionConnectionStatus(session);
      writeAudit('Customer support app disconnected');
      renderSessions();
    }
    if (type === 'input.applied' && payload?.ok === false) {
      writeAudit(`Input not applied: ${payload.error || 'Windows rejected the remote input event'}`);
    }
    if (type === 'input.relayed' && payload?.ok === false) {
      writeAudit(`Input not relayed: ${payload.error || 'No live customer agent received the input'}`);
    }
    if (type === 'chat') writeAudit(`Endpoint: ${payload.message}`);
    if (type === 'session.end') {
      setStatus('Ended');
      writeAudit('Session ended');
      ws?.close();
      pc?.close();
    }
  });
}

function renderSessionJobs(session) {
  const latestCommand = session.commands?.[0];
  if (latestCommand) {
    els.terminalOutput.textContent = latestCommand.output || latestCommand.status || 'Command queued';
  }
}

function send(type, payload) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function showHostLaunch() {
  els.hostLaunchOverlay.hidden = false;
}

function hideHostLaunch() {
  els.hostLaunchOverlay.hidden = true;
}

async function launchHostClient(event, options = {}) {
  event?.preventDefault();
  await refreshSessions();
  const liveSession = newestLiveSession();
  if (!active && liveSession) {
    await selectSession(liveSession);
  } else if (!options.preserveActive && active && !sessionIsCustomerLive(active) && liveSession && active.sessionId !== liveSession.sessionId) {
    await selectSession(liveSession);
    writeAudit(`Joining live customer session ${liveSession.joinCode || liveSession.sessionId}`);
  }
  await ensureActiveSession();
  if (!active) {
    writeAudit('Create or select a session first');
    return;
  }
  updateHostDeepLink(active, 'Start');
  if (!['customer_joined', 'active', 'waiting'].includes(active.status)) {
    writeAudit('Customer has not joined this session yet');
    return;
  }

  inputEnabled = true;
  showHostLaunch();
  if (els.hostLaunchStatus) els.hostLaunchStatus.textContent = 'Opening the supportdesk host client...';
  if (els.hostLaunchDetail) els.hostLaunchDetail.textContent = 'If the host client is already installed, the session opens automatically.';
  if (els.hostViewerDownload) {
    els.hostViewerDownload.hidden = true;
    els.hostViewerDownload.href = '#';
    els.hostViewerDownload.textContent = 'Download host client';
  }
  setStatus('Joining');
  writeAudit('Launching host client');

  const response = await fetch(`/api/session/${encodeURIComponent(active.sessionId)}/host-launch`, { method: 'POST' });
  if (!response.ok) {
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    const message = data.message || data.error || 'Could not open host client';
    if (els.hostLaunchStatus) els.hostLaunchStatus.textContent = data.error || 'Could not open host client';
    if (els.hostLaunchDetail) els.hostLaunchDetail.textContent = message;
    writeAudit('Could not open host client');
    if (message !== 'Could not open host client') writeAudit(message);
    return;
  }

  const data = await response.json();
  if (!data.hostUrl && !data.hostViewerUrl) {
    writeAudit('Host viewer launch details were not returned');
    return;
  }

  const hostClientUrl = data.hostUrl || '';
  lastHostClientUrl = hostClientUrl;
  lastHostViewerUrl = data.hostViewerUrl || '';
  if (els.hostViewerDownload && data.hostViewerUrl) {
    els.hostViewerDownload.hidden = false;
    els.hostViewerDownload.href = data.hostViewerUrl;
    els.hostViewerDownload.textContent = `Download ${data.hostViewerFileName || 'supportdesk.HostViewer.exe'}`;
  }

  if (data.launched) {
    if (els.hostLaunchStatus) els.hostLaunchStatus.textContent = 'Desktop host viewer opened';
    if (els.hostLaunchDetail) els.hostLaunchDetail.textContent = 'The native viewer window should appear outside the browser.';
    window.setTimeout(hideHostLaunch, 1600);
    writeAudit('Desktop host viewer opened');
    return;
  }

  if (data.hostViewerUrl) {
    if (els.hostLaunchStatus) els.hostLaunchStatus.textContent = 'Downloading desktop host viewer';
    if (els.hostLaunchDetail) els.hostLaunchDetail.textContent = 'Open the downloaded HostViewer EXE to show the customer screen in a separate desktop window.';
    els.hostViewerDownload?.click();
    writeAudit(data.launchError || 'Desktop host viewer download started');
    return;
  }

  if (hostClientUrl) {
    if (els.hostLaunchStatus) els.hostLaunchStatus.textContent = 'Desktop viewer is unavailable';
    if (els.hostLaunchDetail) els.hostLaunchDetail.textContent = 'The native host viewer was not published on this server.';
    writeAudit(data.launchError || 'Desktop host viewer unavailable');
  }
}

async function applyHostDeepLink() {
  const link = parseHostDeepLink();
  pendingHostDeepLink = link;
  if (!link || applyingHostDeepLink) return;
  applyingHostDeepLink = true;
  try {
    await refreshSessions();
    const linkedSession = sessions.find((session) =>
      session.sessionId === link.sessionId ||
      session.joinCode === link.sessionId
    );
    if (!linkedSession) {
      writeAudit(`Host link session not found: ${link.sessionId}`);
      return;
    }
    await selectSession(linkedSession);
    if (link.action === 'start') {
      await launchHostClient(null, { preserveActive: true });
    }
  } finally {
    applyingHostDeepLink = false;
  }
}

async function copy(value, label) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
  writeAudit(`${label} copied`);
}

async function queueTerminal(event) {
  event.preventDefault();
  await ensureActiveSession();
  if (!active) return writeAudit('Create or select a session first');
  const command = els.terminalInput.value.trim();
  if (!command) return;

  const response = await fetch(`/api/session/${encodeURIComponent(active.sessionId)}/terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command })
  });
  const data = await response.json();
  els.terminalOutput.textContent = data.command?.output || data.error || 'Command queued';
  els.terminalInput.value = '';
  await refreshAudit();
}

async function refreshActiveSession() {
  if (!active) return;
  const statusResponse = await fetch(`/api/session/${encodeURIComponent(active.sessionId)}/status`);
  if (!statusResponse.ok) return;
  Object.assign(active, await statusResponse.json());
  applySessionConnectionStatus(active);
  renderSessionJobs(active);
  renderSessions();
}

async function queueFileTransfer() {
  await ensureActiveSession();
  if (!active) return writeAudit('Create or select a session first');
  const path = prompt('Remote file path to download from the client', 'C:\\Windows\\System32\\drivers\\etc\\hosts')?.trim();
  if (!path) return;
  const response = await fetch(`/api/session/${encodeURIComponent(active.sessionId)}/file-transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: path.split(/[\\/]/).pop() || 'remote-file', path, direction: 'download' })
  });
  const data = await response.json();
  if (!response.ok) return writeAudit(data.error || 'Could not queue file download');
  writeAudit(`File download queued: ${data.file.name}`);
  await refreshAudit();
}

async function toggleRecording() {
  await ensureActiveSession();
  if (!active) return writeAudit('Create or select a session first');
  const recording = els.recording.getAttribute('aria-pressed') !== 'true';
  const response = await fetch(`/api/session/${encodeURIComponent(active.sessionId)}/recording`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recording })
  });
  const data = await response.json();
  els.recording.setAttribute('aria-pressed', String(data.recording));
  els.recording.textContent = data.recording ? 'Stop recording' : 'Record session';
  await refreshAudit();
}

async function deleteSession() {
  await ensureActiveSession();
  if (!active) return writeAudit('Create or select a session first');
  const sessionId = active.sessionId;
  const response = await fetch(`/api/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  if (!response.ok) return writeAudit('Could not delete session');
  sessions = sessions.filter((session) => session.sessionId !== sessionId);
  active = null;
  ws?.close();
  pc?.close();
  writeAudit('Session deleted');
  setStatus('No Session');
  renderSessions();
  await refreshAudit();
}

async function deleteAllSessions() {
  const count = sessions.length;
  if (!count) return writeAudit('No sessions to delete');
  if (!confirm(`Delete all ${count} session${count === 1 ? '' : 's'}? This cannot be undone.`)) return;
  const response = await fetch('/api/sessions', { method: 'DELETE' });
  if (!response.ok) return writeAudit('Could not delete sessions');
  const data = await response.json().catch(() => ({}));
  sessions = [];
  active = null;
  activeDevice = null;
  ws?.close();
  pc?.close();
  setStatus('No Session');
  renderSessions();
  renderDevices();
  writeAudit(`Deleted ${data.deleted ?? count} session${count === 1 ? '' : 's'}`);
  await refreshAudit();
}

async function renameActiveSession() {
  await ensureActiveSession();
  if (!active) return writeAudit('Select a session first');
  const currentName = displayNameForSession(active);
  const displayName = prompt('Rename customer session', currentName)?.trim();
  if (!displayName || displayName === currentName) return;

  const response = await fetch(`/api/session/${encodeURIComponent(active.sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
  const data = await response.json();
  if (!response.ok) return writeAudit(data.error || 'Could not rename session');
  Object.assign(active, data.session);
  els.title.textContent = displayNameForSession(active);
  if (els.customerName) els.customerName.value = displayNameForSession(active);
  renderSessions();
  await refreshAudit();
}

async function saveSessionNameFromInput() {
  await ensureActiveSession();
  if (!active) return writeAudit('Select a session first');
  const displayName = els.customerName.value.trim();
  if (!displayName || displayName === displayNameForSession(active)) return;

  const response = await fetch(`/api/session/${encodeURIComponent(active.sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
  const data = await response.json();
  if (!response.ok) return writeAudit(data.error || 'Could not rename session');
  Object.assign(active, data.session);
  els.title.textContent = displayNameForSession(active);
  els.customerName.value = displayNameForSession(active);
  renderSessions();
  await refreshAudit();
}

async function saveJoinCode() {
  await ensureActiveSession();
  if (!active) return writeAudit('Select a session first');
  els.code.value = active.joinCode;
  els.link.value = customerUrl(active);
  els.linkText.textContent = customerUrl(active);
}

async function copyJoinCode() {
  await ensureActiveSession();
  if (active) await copy(active.joinCode, 'Customer code');
}

async function sendInviteEmail() {
  await ensureActiveSession();
  if (!active) return writeAudit('Create or select a session first');
  const email = els.email.value.trim();
  if (!email) return writeAudit('Enter customer email first');
  const link = customerUrl(active);
  const subject = encodeURIComponent(`Remote Support Session - ${active.joinCode}`);
  const body = encodeURIComponent(
    `Hello,\n\nYour technician has invited you to a remote support session.\n\n` +
    `To join the session, please click the link below:\n${link}\n\n` +
    `If you are already on the guest page, you can enter the join code: ${active.joinCode}\n\n` +
    `Thank you.`
  );
  window.location.href = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`;
  writeAudit(`Email invite prepared for ${email}`);
}

let blockInputEnabled = false;

function sendCtrlAltDel() {
  if (!active) return;
  send('input', { kind: 'cad' });
  writeAudit('Sent Ctrl+Alt+Del');
}

function toggleBlockInput() {
  if (!active) return;
  blockInputEnabled = !blockInputEnabled;
  send('block-input', { enabled: blockInputEnabled });
  els.blockInput.setAttribute('aria-pressed', blockInputEnabled);
  if (els.toggleBlockInputLarge) els.toggleBlockInputLarge.setAttribute('aria-pressed', blockInputEnabled);
  writeAudit(blockInputEnabled ? 'Guest input blocked' : 'Guest input restored');
}

function toggleBlankScreen() {
  if (!active) return writeAudit('Create or select a session first');
  blankScreenEnabled = !blankScreenEnabled;
  els.blankScreen.setAttribute('aria-pressed', String(blankScreenEnabled));
  els.blankScreen.textContent = blankScreenEnabled ? 'Restore screen' : 'Blank screen';
  if (els.toggleBlankScreenLarge) els.toggleBlankScreenLarge.setAttribute('aria-pressed', String(blankScreenEnabled));
  send('blank-screen', {
    enabled: blankScreenEnabled,
    title: 'System is updating',
    message: 'Please do not turn off your computer',
    progress: 55
  });
  writeAudit(blankScreenEnabled ? 'Customer blank screen enabled' : 'Customer screen restored');
}

function activateButton(button, groupSelector) {
  for (const item of document.querySelectorAll(groupSelector)) {
    item.classList.toggle('active', item === button);
  }
}

function handleDetailsTab(event) {
  const button = event.currentTarget;
  activateButton(button, '.details-tabs button');
  const panelId = button.dataset.panel;
  document.querySelectorAll('.panel-container section').forEach((panel) => {
    panel.hidden = panel.id !== panelId;
  });
  writeAudit(`${button.title || 'Details'} panel selected`);
}

async function handleInviteTab(event) {
  const button = event.currentTarget;
  activateButton(button, '.invite-tabs button');
  const mode = button.textContent.trim();
  if (mode === 'Code') {
    await copyJoinCode();
    return;
  }
  if (mode === 'Link') {
    await copy(els.link.value, 'Customer link');
    return;
  }
  if (mode === 'Email') {
    els.email.focus();
    writeAudit('Enter customer email and press the email button');
    return;
  }
  writeAudit(`${mode} invite selected`);
}

async function showMoreSessionTools() {
  await refreshSessions();
  await refreshAudit();
  writeAudit('Session list refreshed');
}

function sendPointer(event) {
  if (!inputEnabled || !active) return;
  event.preventDefault();
  const point = remoteElementPoint(event.currentTarget, event);
  if (!point) return;
  const kind = event.type === 'pointercancel' ? 'pointerup' : event.type;
  send('input', {
    kind,
    x: point.x,
    y: point.y,
    button: event.button >= 0 ? event.button : 0,
    pointerType: event.pointerType || 'mouse'
  });
}

function sendWheel(event) {
  if (!inputEnabled || !active) return;
  event.preventDefault();
  const point = remoteElementPoint(event.currentTarget, event);
  if (!point) return;
  send('input', {
    kind: 'wheel',
    x: point.x,
    y: point.y,
    deltaY: Math.max(-1200, Math.min(1200, Math.round(event.deltaY)))
  });
}

function remoteElementPoint(element, event) {
  const box = element.getBoundingClientRect();
  let left = box.left;
  let top = box.top;
  let width = box.width;
  let height = box.height;
  const naturalWidth = element.videoWidth || element.naturalWidth || 0;
  const naturalHeight = element.videoHeight || element.naturalHeight || 0;

  if (naturalWidth && naturalHeight) {
    const frameRatio = naturalWidth / naturalHeight;
    const boxRatio = box.width / Math.max(1, box.height);
    if (boxRatio > frameRatio) {
      width = box.height * frameRatio;
      left += (box.width - width) / 2;
    } else {
      height = box.width / frameRatio;
      top += (box.height - height) / 2;
    }
  }

  if (event.clientX < left || event.clientX > left + width || event.clientY < top || event.clientY > top + height) {
    return null;
  }

  return {
    x: Number(Math.min(1, Math.max(0, (event.clientX - left) / width)).toFixed(4)),
    y: Number(Math.min(1, Math.max(0, (event.clientY - top) / height)).toFixed(4))
  };
}

function sendKey(event) {
  if (!inputEnabled || !active) return;
  event.preventDefault();
  send('input', {
    kind: event.type,
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey
  });
}

els.create?.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleCreateSessionMenu();
});
document.addEventListener('click', (event) => {
  const menu = els.createSessionMenu;
  if (!menu || menu.hidden) return;
  if (menu.contains(event.target) || els.create?.contains(event.target)) return;
  toggleCreateSessionMenu(false);
});
els.createSessionMenu?.querySelectorAll('.create-menu-item').forEach((button) => {
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const type = button.getAttribute('data-session-type') || 'support';
    toggleCreateSessionMenu(false);
    SESSION_TYPE_FILTER.value = 'all';
    document.querySelectorAll('.session-type-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.getAttribute('data-filter') === 'all');
    });
    try {
      await createSession(type);
    } catch (err) {
      writeAudit(err.message);
    }
  });
});
els.joinByCodeButton?.addEventListener('click', joinSessionByCode);
els.joinByCode?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    joinSessionByCode();
  }
});
els.sessionTypeTabs?.forEach((tab) => {
  tab.addEventListener('click', () => {
    SESSION_TYPE_FILTER.value = tab.getAttribute('data-filter') || 'all';
    document.querySelectorAll('.session-type-tab').forEach((other) => {
      other.classList.toggle('active', other === tab);
    });
    renderSessions();
  });
});
document.querySelectorAll('.rail-item').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.rail-item').forEach((item) => item.classList.toggle('active', item === button));
  });
});
els.copyCode.addEventListener('click', () => copyJoinCode().catch((err) => writeAudit(err.message)));
els.copyLink.addEventListener('click', () => copy(els.link.value, 'Customer link'));
els.sendInviteEmail.addEventListener('click', () => sendInviteEmail().catch((err) => writeAudit(err.message)));
els.terminalForm.addEventListener('submit', queueTerminal);
els.fileButton.addEventListener('click', queueFileTransfer);
els.recording.addEventListener('click', toggleRecording);
els.endSession.addEventListener('click', deleteSession);
els.connectSession.addEventListener('click', launchHostClient);
els.renameSession.addEventListener('click', renameActiveSession);
els.renameSessionName.addEventListener('click', saveSessionNameFromInput);
els.moreSessionTools.addEventListener('click', showMoreSessionTools);
els.deleteAllSessions?.addEventListener('click', () => {
  deleteAllSessions().catch((err) => writeAudit(err.message));
});
els.sessionMenu.addEventListener('click', () => {
  els.sessionSearch.value = '';
  renderSessions();
  writeAudit('Session filter cleared');
});
els.customerName.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  saveSessionNameFromInput().catch((err) => writeAudit(err.message));
});
els.customerName.addEventListener('blur', () => saveSessionNameFromInput().catch((err) => writeAudit(err.message)));
els.sessionSearch.addEventListener('input', () => {
  renderSessions();
  renderDevices();
});
els.selectAllSessions.addEventListener('change', () => {
  if (els.selectAllSessions.checked && sessions[0]) {
    selectSession(sessions[0]).catch((err) => writeAudit(err.message));
  }
  els.selectAllSessions.checked = Boolean(active);
});
els.blankScreen.addEventListener('click', toggleBlankScreen);
els.blockInput.addEventListener('click', toggleBlockInput);
els.toggleFullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    els.viewerPanel.requestFullscreen().catch((err) => writeAudit(`Error entering fullscreen: ${err.message}`));
  } else {
    document.exitFullscreen();
  }
});
els.sendCAD.addEventListener('click', sendCtrlAltDel);
els.hostJoin.addEventListener('click', launchHostClient);
els.hostLaunchClose.addEventListener('click', hideHostLaunch);
els.hostLaunchRetry.addEventListener('click', (event) => {
  event.preventDefault();
  if (lastHostViewerUrl) {
    if (els.hostViewerDownload) {
      els.hostViewerDownload.href = lastHostViewerUrl;
      els.hostViewerDownload.hidden = false;
      els.hostViewerDownload.click();
    } else {
      window.location.href = lastHostViewerUrl;
    }
    return;
  }
  launchHostClient(event).catch((err) => writeAudit(err.message));
});
els.hostJoinBrowser.addEventListener('click', (event) => {
  event.preventDefault();
  if (!active?.sessionId) return;
  const browserHostUrl = new URL('/host-client.html', location.origin);
  browserHostUrl.searchParams.set('sessionId', active.sessionId);
  browserHostUrl.searchParams.set('token', active.agentPortalToken || '');
  browserHostUrl.searchParams.set('baseUrl', publicBaseUrl);
  browserHostUrl.searchParams.set('displayName', displayNameForSession(active));
  window.open(browserHostUrl.toString(), '_blank', 'noopener');
  hideHostLaunch();
});
els.video.addEventListener('pointerdown', sendPointer);
els.video.addEventListener('pointermove', sendPointer);
els.video.addEventListener('pointerup', sendPointer);
els.video.addEventListener('pointercancel', sendPointer);
els.video.addEventListener('wheel', sendWheel, { passive: false });
els.nativeFrame.addEventListener('pointerdown', sendPointer);
els.nativeFrame.addEventListener('pointermove', sendPointer);
els.nativeFrame.addEventListener('pointerup', sendPointer);
els.nativeFrame.addEventListener('pointercancel', sendPointer);
els.nativeFrame.addEventListener('wheel', sendWheel, { passive: false });
els.viewerPanel.addEventListener('keydown', sendKey);
els.viewerPanel.addEventListener('keyup', sendKey);
els.viewerPanel.tabIndex = 0;
for (const button of document.querySelectorAll('.details-tabs button')) {
  button.addEventListener('click', handleDetailsTab);
}
for (const button of document.querySelectorAll('.invite-tabs button')) {
  button.addEventListener('click', (event) => handleInviteTab(event).catch((err) => writeAudit(err.message)));
}
document.querySelector('.card-menu')?.addEventListener('click', () => {
  copy(els.link.value || els.code.value, els.link.value ? 'Customer link' : 'Join code').catch((err) => writeAudit(err.message));
});

await loadConfig().catch((err) => writeAudit(err.message));
await loadScreenConnectReport();
connectGlobalUpdates();
await refreshDevices();
await refreshSessions();
await refreshAudit();
renderSessions();
setStatus('No Session');
await applyHostDeepLink().catch((err) => writeAudit(err.message));
if (!active) {
  const liveSession = newestLiveSession();
  if (liveSession) await selectSession(liveSession);
}
window.addEventListener('hashchange', () => applyHostDeepLink().catch((err) => writeAudit(err.message)));
els.showSessions.addEventListener('click', () => {
  els.showSessions.classList.add('active');
  els.showDevices.classList.remove('active');
  els.showReport?.classList.remove('active');
  els.sessions.hidden = false;
  els.devices.hidden = true;
  if (els.reportPane) els.reportPane.hidden = true;
  els.viewerPane.hidden = true;
  els.sessionListPane.hidden = false;
  els.sessionListPane.querySelector('h2').textContent = 'Client Sessions';
});

els.showDevices.addEventListener('click', () => {
  els.showDevices.classList.add('active');
  els.showSessions.classList.remove('active');
  els.showReport?.classList.remove('active');
  els.sessions.hidden = true;
  els.devices.hidden = false;
  if (els.reportPane) els.reportPane.hidden = true;
  els.viewerPane.hidden = true;
  els.sessionListPane.hidden = false;
  els.sessionListPane.querySelector('h2').textContent = 'Managed Devices';
  refreshDevices();
});

els.showReport?.addEventListener('click', async () => {
  els.showReport.classList.add('active');
  els.showSessions.classList.remove('active');
  els.showDevices.classList.remove('active');
  els.sessions.hidden = true;
  els.devices.hidden = true;
  els.viewerPane.hidden = true;
  els.sessionListPane.hidden = true;
  if (els.reportPane) els.reportPane.hidden = false;
  await loadScreenConnectReport();
});

els.hostJoinLarge?.addEventListener('click', (e) => launchHostClient(e));
els.toggleFullscreenLarge?.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    els.viewerPane.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen();
  }
});

els.sendCADLarge?.addEventListener('click', sendCtrlAltDel);
els.toggleBlankScreenLarge?.addEventListener('click', toggleBlankScreen);
els.toggleBlockInputLarge?.addEventListener('click', toggleBlockInput);
els.queueFileLarge?.addEventListener('click', () => els.fileButton?.click());
els.toggleRecordingLarge?.addEventListener('click', () => els.recording?.click());

els.remoteVideoLarge?.addEventListener('pointerdown', sendPointer);
els.remoteVideoLarge?.addEventListener('pointermove', sendPointer);
els.remoteVideoLarge?.addEventListener('pointerup', sendPointer);
els.remoteVideoLarge?.addEventListener('pointercancel', sendPointer);
els.remoteVideoLarge?.addEventListener('wheel', sendWheel, { passive: false });
els.nativeFrameLarge?.addEventListener('pointerdown', sendPointer);
els.nativeFrameLarge?.addEventListener('pointermove', sendPointer);
els.nativeFrameLarge?.addEventListener('pointerup', sendPointer);
els.nativeFrameLarge?.addEventListener('pointercancel', sendPointer);
els.nativeFrameLarge?.addEventListener('wheel', sendWheel, { passive: false });

setInterval(() => {
  refreshSessions().catch(() => {});
  refreshDevices().catch(() => {});
  refreshActiveSession().catch(() => {});
}, 3000);
setInterval(refreshActiveSession, 2500);
