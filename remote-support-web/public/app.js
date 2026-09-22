/**
 * Remote Support — Host Page Application
 * ScreenConnect-like interface for managing sessions
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let sessions = [];
let selectedSessionId = null;
let currentType = 'support'; // support | meeting | access
let currentGroup = 'all';    // all | online | waiting | offline
let searchQuery = '';
let selectedSessionIds = new Set();
let ws = null;
let wsReconnectTimer = null;
let liveDataInterval = null;
let currentUser = null;

// Session type numbers (matching ScreenConnect)
const SESSION_TYPE = { support: 0, meeting: 1, access: 2 };
const SESSION_TYPE_NAME = { 0: 'Support', 1: 'Meeting', 2: 'Access' };

// ── Utility ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>').replace(/"/g,'"');
}
function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleString();
}
function fmtRelTime(ts) {
  if (!ts) return '-';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return `${Math.floor(diff/86400000)}d ago`;
}
function fmtBytes(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(1)} MB`;
}
function showToast(msg, type = 'info') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `sc-toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// Global helpers used in HTML onclick
window.closeModal = (id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
window.showModal  = (id) => { const el = document.getElementById(id); if (el) el.style.display = 'flex'; };
window.copyField  = (id) => {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.value).then(() => showToast('Copied to clipboard', 'success')).catch(() => {
    el.select(); document.execCommand('copy'); showToast('Copied', 'success');
  });
};
window.promptRename = () => {
  if (!selectedSessionId) return;
  const s = sessions.find(x => x.id === selectedSessionId);
  if (!s) return;
  document.getElementById('renameInput').value = s.name || '';
  showModal('modalRename');
};

// ── API helpers ────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = '/login?Reason=NotAuthenticated'; throw new Error('Unauthorized'); }
  return res;
}
async function apiJson(method, path, body) {
  const res = await api(method, path, body);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || `HTTP ${res.status}`); }
  return res.json();
}

// ── Session Status ─────────────────────────────────────────────────────────
function getSessionStatus(s) {
  // A session is only "online" (live) once real frame data has arrived
  // (isLive, backed by nativeConnected or a recent screen.frame) — never
  // purely because a customer browser socket connected. `s.status ===
  // 'active'` alone used to be treated as sufficient here, but the server
  // can mark a session 'active' as soon as a technician + a customer
  // signaling socket are both present, before any frame has been received;
  // `s.isLive` is the authoritative "really connected and streaming" flag.
  if (s.isLive) return 'online';
  if (s.status === 'waiting' || s.status === 'customer_joined') return 'waiting';
  return 'offline';
}

function getStatusDot(status) {
  const cls = { online: 'online', waiting: 'waiting', offline: 'offline' };
  return `<span class="sc-status-dot ${cls[status] || 'offline'}"></span>`;
}

// ── Filter Sessions ────────────────────────────────────────────────────────
function filteredSessions() {
  return sessions.filter(s => {
    // Type filter
    const typeMatch =
      currentType === 'support' ? (s.type === 0 || s.sessionType === 0 || s.type === 'Support') :
      currentType === 'meeting' ? (s.type === 1 || s.sessionType === 1 || s.type === 'Meeting') :
      currentType === 'access'  ? (s.type === 2 || s.sessionType === 2 || s.type === 'Access') :
      true;
    if (!typeMatch) return false;

    // Group filter
    const status = getSessionStatus(s);
    if (currentGroup === 'online'  && status !== 'online')  return false;
    if (currentGroup === 'waiting' && status !== 'waiting') return false;
    if (currentGroup === 'offline' && status !== 'offline') return false;

    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (s.name || '').toLowerCase().includes(q) ||
             (s.guestMachineName || '').toLowerCase().includes(q) ||
             (s.guestOperatingSystemName || '').toLowerCase().includes(q) ||
             (s.customProperty1 || '').toLowerCase().includes(q) ||
             (s.code || '').toLowerCase().includes(q);
    }
    return true;
  });
}

// ── Render Session List ────────────────────────────────────────────────────
function renderSessionList() {
  const list = document.getElementById('sessionList');
  const empty = document.getElementById('sessionListEmpty');
  const items = filteredSessions();

  updateGroupCounts();

  if (items.length === 0) {
    empty.style.display = 'flex';
    // Remove existing cards
    list.querySelectorAll('.session-card').forEach(el => el.remove());
    return;
  }
  empty.style.display = 'none';

  // Build map of existing cards
  const existing = new Map();
  list.querySelectorAll('.session-card').forEach(el => existing.set(el.dataset.id, el));

  // Remove cards no longer in list
  const itemIds = new Set(items.map(s => s.id));
  existing.forEach((el, id) => { if (!itemIds.has(id)) el.remove(); });

  // Update/add cards
  items.forEach((s, idx) => {
    const status = getSessionStatus(s);
    const selected = selectedSessionIds.has(s.id) || s.id === selectedSessionId;
    let card = existing.get(s.id);

    if (!card) {
      card = document.createElement('div');
      card.className = 'session-card';
      card.dataset.id = s.id;
      card.addEventListener('click', () => selectSession(s.id));
      card.addEventListener('dblclick', () => joinSession(s.id));
    }

    card.className = `session-card${selected ? ' selected' : ''}`;
    const machineName = s.guestMachineName || s.deviceId || '';
    const osName = s.guestOperatingSystemName || s.customerPlatform || '';
    const metaParts = [machineName, osName, s.customProperty1].filter(Boolean);
    const meta = metaParts.join(' · ') || (s.code ? `Code: ${s.code}` : '');
    const lastSeen = fmtRelTime(s.lastActivityAt || s.updatedAt || s.createdAt);

    card.innerHTML = `
      <input type="checkbox" style="flex-shrink:0;" ${selectedSessionIds.has(s.id) ? 'checked' : ''} onclick="event.stopPropagation();toggleSelectSession('${s.id}', this.checked)">
      ${getStatusDot(status)}
      <div class="sc-info">
        <div class="sc-name">${esc(s.name || 'Untitled Session')}</div>
        <div class="sc-meta">${esc(meta) || esc(lastSeen)}</div>
      </div>
      <div class="sc-actions">
        <button class="sc-icon-btn" title="Join" onclick="event.stopPropagation();joinSession('${s.id}')">▶</button>
        <button class="sc-icon-btn" title="Rename" onclick="event.stopPropagation();renameSessionDirect('${s.id}')">✏</button>
        <button class="sc-icon-btn" title="Delete" onclick="event.stopPropagation();deleteSessionPrompt('${s.id}')">🗑</button>
      </div>
    `;

    if (!existing.has(s.id)) {
      // Insert at correct position
      const after = list.querySelectorAll('.session-card')[idx];
      if (after) list.insertBefore(card, after);
      else list.appendChild(card);
    }
  });
}

function updateGroupCounts() {
  const all     = sessions.filter(s => typeMatches(s, currentType));
  const online  = all.filter(s => getSessionStatus(s) === 'online');
  const waiting = all.filter(s => getSessionStatus(s) === 'waiting');
  const offline = all.filter(s => getSessionStatus(s) === 'offline');
  document.getElementById('groupCountAll').textContent    = all.length;
  document.getElementById('groupCountOnline').textContent  = online.length;
  document.getElementById('groupCountWaiting').textContent = waiting.length;
  document.getElementById('groupCountOffline').textContent = offline.length;
}

function typeMatches(s, type) {
  if (type === 'support') return s.type === 0 || s.sessionType === 0 || s.type === 'Support';
  if (type === 'meeting') return s.type === 1 || s.sessionType === 1 || s.type === 'Meeting';
  if (type === 'access')  return s.type === 2 || s.sessionType === 2 || s.type === 'Access';
  return true;
}

// ── Select Session ─────────────────────────────────────────────────────────
function selectSession(id) {
  selectedSessionId = id;
  renderSessionList();
  showSessionDetails(id);
}

window.toggleSelectSession = function(id, checked) {
  if (checked) selectedSessionIds.add(id);
  else selectedSessionIds.delete(id);
  const bar = document.getElementById('multiselectBar');
  const count = document.getElementById('multiselectCount');
  bar.classList.toggle('visible', selectedSessionIds.size > 0);
  count.textContent = selectedSessionIds.size;
};

// ── Show Session Details ───────────────────────────────────────────────────
function showSessionDetails(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) {
    document.getElementById('detailsEmpty').style.display = 'flex';
    document.getElementById('detailsContent').style.display = 'none';
    return;
  }

  document.getElementById('detailsEmpty').style.display = 'none';
  document.getElementById('detailsContent').style.display = 'flex';

  const status = getSessionStatus(s);
  document.getElementById('dpSessionName').textContent = s.name || 'Untitled Session';
  document.getElementById('dpSessionType').textContent = SESSION_TYPE_NAME[s.type ?? s.sessionType] || 'Support';
  document.getElementById('dpSessionId').textContent = id.slice(0, 8) + '...';

  const pill = document.getElementById('dpStatusPill');
  pill.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  pill.className = `dp-pill ${status}`;

  // Session Code display
  const code = s.code || generateDisplayCode(id);
  document.getElementById('sessionCode').textContent = formatCode(code);

  // Guest URL
  const guestOrigin = window.location.origin;
  const sessionCode = s.code || s.joinCode || id;
  document.getElementById('guestUrl').textContent = guestOrigin.replace('http://', '').replace('https://', '');
  // Use the join code in the invite URL - works on all platforms, easier to share
  document.getElementById('inviteLink').value = `${guestOrigin}/customer?code=${sessionCode}`;

  // Viewer status
  const viewerPlaceholder = document.getElementById('viewerPlaceholder');
  const viewerStatus = document.getElementById('viewerStatus');
  const viewerSub = document.getElementById('viewerSubStatus');
  const remoteVideo = document.getElementById('remoteVideo');
  const nativeFrame = document.getElementById('nativeFrame');

  if (status === 'online' || status === 'active') {
    viewerStatus.textContent = 'Your guest has connected';
    viewerSub.textContent = 'Click Join to launch the host client and start the session.';
    viewerPlaceholder.querySelector('.vp-icon').textContent = '✅';
  } else if (status === 'waiting') {
    viewerStatus.textContent = 'Your guest is downloading the app...';
    viewerSub.textContent = 'Waiting for the guest to run the application.';
    viewerPlaceholder.querySelector('.vp-icon').textContent = '⏬';
  } else {
    viewerStatus.textContent = 'Your guest has not joined yet...';
    viewerSub.textContent = 'Share the code or invite link with your customer to get started.';
    viewerPlaceholder.querySelector('.vp-icon').textContent = '⏳';
  }

  // General tab info
  document.getElementById('infoName').textContent = s.name || '-';
  document.getElementById('infoSessionId').textContent = id;
  document.getElementById('infoType').textContent = SESSION_TYPE_NAME[s.type ?? s.sessionType] || 'Support';
  document.getElementById('infoStatus').textContent = status;
  document.getElementById('infoHost').textContent = s.host || currentUser?.username || '-';
  document.getElementById('infoCreated').textContent = fmtTime(s.createdAt);
  document.getElementById('infoCode').textContent = code;

  // Device info
  document.getElementById('infoMachine').textContent    = s.guestMachineName || s.deviceId || '-';
  document.getElementById('infoOS').textContent          = s.guestOperatingSystemName || s.customerPlatform || '-';
  document.getElementById('infoOSVersion').textContent   = s.guestOperatingSystemVersion || '-';
  document.getElementById('infoProcessor').textContent   = s.guestProcessorName || '-';
  document.getElementById('infoMemory').textContent      = s.guestSystemMemoryTotalMegabytes ? `${s.guestSystemMemoryTotalMegabytes} MB` : '-';
  document.getElementById('infoIP').textContent          = s.guestNetworkAddress || '-';
  document.getElementById('infoMAC').textContent         = s.guestHardwareNetworkAddress || '-';
  document.getElementById('infoClientVer').textContent   = s.guestClientVersion || '-';
  document.getElementById('infoUser').textContent        = s.guestLoggedOnUserName || '-';
  document.getElementById('infoLastActivity').textContent = fmtRelTime(s.lastActivityAt);

  // Custom properties
  const props = ['company','site','department','deviceType'];
  props.forEach((p, i) => {
    const el = document.getElementById(`cprop${i}`);
    if (el) el.textContent = s.customProperty1 && i === 0 ? s.customProperty1 :
                             s.customProperty2 && i === 1 ? s.customProperty2 :
                             s.customProperty3 && i === 2 ? s.customProperty3 :
                             s.customProperty4 && i === 3 ? s.customProperty4 : '-';
  });

  // Terminal session name
  document.getElementById('terminalSessionName').textContent = s.name || 'Remote Terminal';

  // Render events
  renderEvents(s);

  // Switch to Start tab
  switchTab('start');
}

function generateDisplayCode(id) {
  return id.slice(0, 4).toUpperCase() + id.slice(4, 8).toUpperCase();
}
function formatCode(code) {
  const clean = code.replace(/[^0-9A-Za-z]/g, '');
  if (clean.length >= 8) return `${clean.slice(0,4)}-${clean.slice(4,8)}`.toUpperCase();
  return code.toUpperCase();
}

// ── Tab Switching ──────────────────────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll('.dp-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.dp-tab-content').forEach(el => {
    el.style.display = el.id === `tab-${tabName}` ? '' : 'none';
  });
}

document.querySelectorAll('.dp-tab').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ── Render Events ──────────────────────────────────────────────────────────
function renderEvents(session) {
  const list = document.getElementById('eventsList');
  const events = session.events || session.auditLog || [];
  if (!events.length) {
    list.innerHTML = '<li style="padding:20px;text-align:center;color:var(--sc-text-dim);font-size:12px;">No events yet</li>';
    return;
  }
  const icons = {
    'connected': '🔗', 'disconnected': '🔌', 'createdSession': '➕', 'deletedSession': '🗑',
    'ranCommand': '⌨', 'sentMessage': '💬', 'sentFiles': '📤', 'receivedFiles': '📥',
    'addedNote': '📝', 'reinstall': '🔄', 'wake': '⚡', 'default': '●'
  };
  list.innerHTML = [...events].reverse().slice(0, 100).map(e => {
    const type = (e.type || e.event || '').toLowerCase();
    const icon = icons[type] || icons.default;
    return `<li class="event-item">
      <span class="ev-time">${fmtRelTime(e.time || e.timestamp)}</span>
      <span class="ev-icon">${icon}</span>
      <div>
        <span class="ev-text">${esc(e.type || e.event || 'Event')}</span>
        ${e.data || e.message ? `<div class="ev-data">${esc(e.data || e.message)}</div>` : ''}
      </div>
    </li>`;
  }).join('');
}

// ── Type/Group Switching ───────────────────────────────────────────────────
function switchType(type) {
  currentType = type;
  selectedSessionId = null;

  // Update rail items
  document.querySelectorAll('.sc-rail .rail-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === type);
  });
  // Update nav type tabs
  document.querySelectorAll('.nav-type-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });

  const titles = { support: 'Support', meeting: 'Meeting', access: 'Access' };
  const helps  = {
    support: 'Provide on-demand support for any device on the internet.',
    meeting: 'Use meeting sessions for presentations or gatherings.',
    access:  'Deploy and manage unattended access agents on remote machines.'
  };
  const panelTitles = { support: 'Support Sessions', meeting: 'Meeting Sessions', access: 'Access Sessions' };
  const createLabels = { support: '+ Create Support', meeting: '+ Create Meeting', access: '+ Build Installer' };

  document.getElementById('navPanelTitle').textContent     = titles[type];
  document.getElementById('navHelpText').textContent       = helps[type];
  document.getElementById('sessionPanelTitle').textContent = panelTitles[type];
  document.getElementById('btnCreate').textContent         = createLabels[type];

  // Show/hide build installer panel
  const instPanel = document.getElementById('buildInstallerPanel');
  if (instPanel) instPanel.style.display = type === 'access' ? 'block' : 'none';

  // Reset group to all
  switchGroup('all');
  renderSessionList();

  // Update details panel
  document.getElementById('detailsEmpty').style.display = 'flex';
  document.getElementById('detailsContent').style.display = 'none';
}

function switchGroup(group) {
  currentGroup = group;
  document.querySelectorAll('.nav-group').forEach(el => {
    el.classList.toggle('active', el.dataset.group === group);
  });
  renderSessionList();
}

// ── Create Session ─────────────────────────────────────────────────────────
document.getElementById('btnCreate').addEventListener('click', () => {
  if (currentType === 'access') {
    showModal('modalBuildInstaller');
    return;
  }
  const typeLabel = currentType === 'meeting' ? 'Meeting' : 'Support';
  document.getElementById('modalCreateTitle').textContent = `Create ${typeLabel} Session`;
  document.getElementById('newSessionName').value = `Untitled ${typeLabel}`;
  showModal('modalCreateSession');
});

document.getElementById('btnConfirmCreate').addEventListener('click', async () => {
  const name    = document.getElementById('newSessionName').value.trim() || 'Untitled Session';
  const company = document.getElementById('newSessionCompany').value.trim();
  const site    = document.getElementById('newSessionSite').value.trim();
  const dept    = document.getElementById('newSessionDepartment').value.trim();
  const devType = document.getElementById('newSessionDeviceType').value;

  try {
    const typeNum = SESSION_TYPE[currentType] ?? 0;
    const data = await apiJson('POST', '/api/sessions', {
      name,
      type: typeNum,
      customProperty1: company,
      customProperty2: site,
      customProperty3: dept,
      customProperty4: devType
    });
    closeModal('modalCreateSession');
    showToast(`Session "${name}" created`, 'success');
    await loadSessions();
    if (data.id) selectSession(data.id);
  } catch (e) {
    showToast(`Failed to create session: ${e.message}`, 'error');
  }
});

// ── Delete Session ─────────────────────────────────────────────────────────
window.deleteSessionPrompt = function(id) {
  selectedSessionId = id;
  showModal('modalDelete');
};

document.getElementById('btnDeleteSession').addEventListener('click', () => {
  if (selectedSessionId) showModal('modalDelete');
});

document.getElementById('btnConfirmDelete').addEventListener('click', async () => {
  if (!selectedSessionId) return;
  try {
    await apiJson('DELETE', `/api/sessions/${selectedSessionId}`);
    closeModal('modalDelete');
    showToast('Session deleted', 'success');
    selectedSessionId = null;
    document.getElementById('detailsEmpty').style.display = 'flex';
    document.getElementById('detailsContent').style.display = 'none';
    await loadSessions();
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'error');
  }
});

// ── Rename Session ─────────────────────────────────────────────────────────
window.renameSessionDirect = function(id) {
  selectedSessionId = id;
  const s = sessions.find(x => x.id === id);
  document.getElementById('renameInput').value = s?.name || '';
  showModal('modalRename');
};

document.getElementById('btnConfirmRename').addEventListener('click', async () => {
  const name = document.getElementById('renameInput').value.trim();
  if (!name || !selectedSessionId) return;
  try {
    await apiJson('PATCH', `/api/sessions/${selectedSessionId}`, { name });
    closeModal('modalRename');
    showToast('Session renamed', 'success');
    await loadSessions();
    showSessionDetails(selectedSessionId);
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'error');
  }
});

// ── Join Session ───────────────────────────────────────────────────────────
async function joinSession(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  try {
    // Get access token
    const data = await apiJson('GET', `/api/sessions/${id}/join-token`);
    const token = data.token || data.accessToken;
    if (token) {
      // Launch via URL scheme or open viewer
      const launchUrl = `${window.location.origin}/viewer?sessionId=${id}&token=${token}`;
      window.open(launchUrl, '_blank');
    } else {
      window.open(`/viewer?sessionId=${id}`, '_blank');
    }
  } catch {
    window.open(`/viewer?sessionId=${id}`, '_blank');
  }
}

['btnJoin', 'btnJoinSession'].forEach(id => {
  const btn = document.getElementById(id);
  if (btn) btn.addEventListener('click', () => {
    if (selectedSessionId) joinSession(selectedSessionId);
  });
});

// ── Send Message ───────────────────────────────────────────────────────────
document.getElementById('btnSendMessage').addEventListener('click', () => {
  if (selectedSessionId) showModal('modalSendMessage');
});

document.getElementById('btnConfirmMessage').addEventListener('click', async () => {
  const msg = document.getElementById('messageText').value.trim();
  if (!msg || !selectedSessionId) return;
  try {
    await apiJson('POST', `/api/sessions/${selectedSessionId}/message`, { message: msg });
    closeModal('modalSendMessage');
    showToast('Message sent', 'success');
    document.getElementById('messageText').value = '';
    // Add to chat
    addChatMessage(msg, 'from-host');
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'error');
  }
});

// Chat
document.getElementById('btnSendChat').addEventListener('click', async () => {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg || !selectedSessionId) return;
  try {
    await apiJson('POST', `/api/sessions/${selectedSessionId}/message`, { message: msg });
    addChatMessage(msg, 'from-host');
    input.value = '';
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'error');
  }
});
document.getElementById('chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('btnSendChat').click();
  }
});

function addChatMessage(text, cls) {
  const container = document.getElementById('chatMessages');
  const empty = container.querySelector('div');
  if (empty && empty.style) empty.remove();
  const div = document.createElement('div');
  div.className = `chat-msg ${cls}`;
  div.innerHTML = `
    <div class="msg-bubble">${esc(text)}</div>
    <div class="msg-time">${new Date().toLocaleTimeString()}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ── Terminal / Commands ────────────────────────────────────────────────────
document.getElementById('terminalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('terminalInput');
  const cmd = input.value.trim();
  if (!cmd || !selectedSessionId) return;

  const output = document.getElementById('terminalOutput');
  output.textContent += `\n> ${cmd}\n`;
  input.value = '';

  try {
    const data = await apiJson('POST', `/api/sessions/${selectedSessionId}/command`, { command: cmd });
    output.textContent += (data.output || data.result || '(no output)') + '\n';
  } catch (err) {
    output.textContent += `Error: ${err.message}\n`;
  }
  output.scrollTop = output.scrollHeight;
});

document.getElementById('btnClearTerminal').addEventListener('click', () => {
  document.getElementById('terminalOutput').textContent = 'Ready. Enter a command below.';
});

// ── Notes ──────────────────────────────────────────────────────────────────
document.getElementById('btnSaveNotes').addEventListener('click', async () => {
  const note = document.getElementById('sessionNotes').value.trim();
  if (!note || !selectedSessionId) return;
  try {
    await apiJson('POST', `/api/sessions/${selectedSessionId}/note`, { note });
    showToast('Note saved', 'success');
    document.getElementById('sessionNotes').value = '';
    // Refresh notes list
    const s = sessions.find(x => x.id === selectedSessionId);
    if (s) renderEvents(s);
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'error');
  }
});

// ── Wake Machine ───────────────────────────────────────────────────────────
document.getElementById('btnWakeDevice').addEventListener('click', async () => {
  if (!selectedSessionId) return;
  try {
    await apiJson('POST', `/api/sessions/${selectedSessionId}/wake`);
    showToast('Wake signal sent', 'success');
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'error');
  }
});

// ── Reinstall Agent ────────────────────────────────────────────────────────
document.getElementById('btnReinstall').addEventListener('click', async () => {
  if (!selectedSessionId) return;
  if (!confirm('Reinstall the agent on the remote machine?')) return;
  try {
    await apiJson('POST', `/api/sessions/${selectedSessionId}/reinstall`);
    showToast('Reinstall queued', 'success');
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'error');
  }
});

// ── Transfer Session ───────────────────────────────────────────────────────
document.getElementById('btnTransferSession').addEventListener('click', () => {
  if (!selectedSessionId) return;
  showModal('modalTransfer');
});

document.getElementById('btnConfirmTransfer').addEventListener('click', async () => {
  const target = document.getElementById('transferTarget').value;
  if (!target || !selectedSessionId) return;
  try {
    await apiJson('POST', `/api/sessions/${selectedSessionId}/transfer`, { toHost: target });
    closeModal('modalTransfer');
    showToast('Session transferred', 'success');
    selectedSessionId = null;
    await loadSessions();
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'error');
  }
});

// ── Build Installer ────────────────────────────────────────────────────────
document.getElementById('btnBuildInstaller').addEventListener('click', () => showModal('modalBuildInstaller'));

document.getElementById('btnDownloadInstaller').addEventListener('click', () => {
  const company = document.getElementById('instCompany').value.trim();
  const site    = document.getElementById('instSite').value.trim();
  const dept    = document.getElementById('instDept').value.trim();
  const instType = document.querySelector('input[name="instType"]:checked')?.value || 'exe';
  const extMap = { exe:'exe', msi:'msi', pkg:'pkg', deb:'deb', rpm:'rpm', sh:'sh' };
  const ext = extMap[instType] || 'exe';
  const params = new URLSearchParams({ e:'Access', y:'Guest', company, site, department: dept });
  const url = `/Bin/ScreenConnect.ClientSetup.${ext}?${params}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = `RemoteSupport.ClientSetup.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  closeModal('modalBuildInstaller');
  showToast('Installer download started', 'success');
});

document.getElementById('btnCopyInstallerUrl').addEventListener('click', () => {
  const instType = document.querySelector('input[name="instType"]:checked')?.value || 'exe';
  const url = `${window.location.origin}/Bin/ScreenConnect.ClientSetup.${instType}?e=Access&y=Guest`;
  navigator.clipboard.writeText(url).then(() => showToast('Installer URL copied', 'success')).catch(() => showToast('Copy failed', 'error'));
});

// Style radio buttons in installer
document.querySelectorAll('input[name="instType"]').forEach(radio => {
  radio.addEventListener('change', () => {
    document.querySelectorAll('.installer-type-opt').forEach(opt => {
      opt.classList.toggle('selected', opt.querySelector('input')?.checked);
    });
  });
});

// ── Email Invite ───────────────────────────────────────────────────────────
document.getElementById('btnSendEmail').addEventListener('click', async () => {
  const email = document.getElementById('inviteEmail').value.trim();
  if (!email || !selectedSessionId) { showToast('Enter an email address', 'error'); return; }
  try {
    await apiJson('POST', `/api/sessions/${selectedSessionId}/invite`, { email });
    showToast(`Invite sent to ${email}`, 'success');
    document.getElementById('inviteEmail').value = '';
  } catch (e) {
    showToast(`Failed: ${e.message}`, 'error');
  }
});

// ── Copy Session ID ────────────────────────────────────────────────────────
document.getElementById('copySessionId').addEventListener('click', () => {
  if (selectedSessionId) {
    navigator.clipboard.writeText(selectedSessionId).then(() => showToast('Copied', 'success'));
  }
});

// ── Viewer Controls ────────────────────────────────────────────────────────
document.getElementById('btnCAD').addEventListener('click', async () => {
  if (!selectedSessionId) return;
  try {
    await apiJson('POST', `/api/sessions/${selectedSessionId}/cad`);
    showToast('Ctrl+Alt+Del sent', 'info');
  } catch {}
});

document.getElementById('btnBlankScreen').addEventListener('click', async () => {
  const btn = document.getElementById('btnBlankScreen');
  const active = btn.classList.toggle('active');
  try {
    await apiJson('POST', `/api/sessions/${selectedSessionId}/blank-screen`, { enabled: active });
    showToast(active ? 'Screen blanked' : 'Screen unblanked', 'info');
  } catch { btn.classList.toggle('active'); }
});

document.getElementById('btnBlockInput').addEventListener('click', async () => {
  const btn = document.getElementById('btnBlockInput');
  const active = btn.classList.toggle('active');
  try {
    await apiJson('POST', `/api/sessions/${selectedSessionId}/block-input`, { enabled: active });
    showToast(active ? 'Input blocked' : 'Input unblocked', 'info');
  } catch { btn.classList.toggle('active'); }
});

document.getElementById('btnFullscreen').addEventListener('click', () => {
  const viewer = document.getElementById('fullscreenViewer');
  if (!selectedSessionId) return;
  const s = sessions.find(x => x.id === selectedSessionId);
  document.getElementById('fvSessionName').textContent = s?.name || 'Session';
  viewer.classList.add('open');
});

document.getElementById('btnExitFullscreen').addEventListener('click', () => {
  document.getElementById('fullscreenViewer').classList.remove('open');
});

// File drop zone
const dropZone = document.getElementById('fileDropZone');
if (dropZone) {
  dropZone.addEventListener('click', () => document.getElementById('fileInput').click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFileTransfer(e.dataTransfer.files);
  });
  document.getElementById('fileInput').addEventListener('change', e => handleFileTransfer(e.target.files));
}

async function handleFileTransfer(files) {
  if (!selectedSessionId || !files.length) return;
  const list = document.getElementById('fileTransferList');
  list.innerHTML = '';
  for (const file of files) {
    const div = document.createElement('div');
    div.className = 'file-item';
    div.innerHTML = `
      <span class="fi-name">${esc(file.name)}</span>
      <span class="fi-size">${fmtBytes(file.size)}</span>
      <div class="fi-progress"><div class="fi-progress-bar" style="width:0%"></div></div>
    `;
    list.appendChild(div);
    const bar = div.querySelector('.fi-progress-bar');

    try {
      const fd = new FormData();
      fd.append('file', file);
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) bar.style.width = `${(e.loaded/e.total*100).toFixed(0)}%`;
      };
      xhr.onload = () => {
        bar.style.width = '100%';
        bar.style.background = 'var(--sc-success)';
        showToast(`${file.name} sent`, 'success');
      };
      xhr.onerror = () => { bar.style.background = 'var(--sc-red)'; };
      xhr.open('POST', `/api/sessions/${selectedSessionId}/file`);
      xhr.send(fd);
    } catch (e) {
      showToast(`Failed: ${e.message}`, 'error');
    }
  }
}

// ── Multi-select actions ───────────────────────────────────────────────────
document.getElementById('btnClearSelect').addEventListener('click', () => {
  selectedSessionIds.clear();
  document.getElementById('multiselectBar').classList.remove('visible');
  renderSessionList();
});

document.getElementById('selectAll').addEventListener('change', (e) => {
  const checked = e.target.checked;
  filteredSessions().forEach(s => {
    if (checked) selectedSessionIds.add(s.id);
    else selectedSessionIds.delete(s.id);
  });
  const bar = document.getElementById('multiselectBar');
  bar.classList.toggle('visible', selectedSessionIds.size > 0);
  document.getElementById('multiselectCount').textContent = selectedSessionIds.size;
  renderSessionList();
});

document.getElementById('btnMultiDelete').addEventListener('click', async () => {
  if (!selectedSessionIds.size) return;
  if (!confirm(`Delete ${selectedSessionIds.size} session(s)?`)) return;
  for (const id of [...selectedSessionIds]) {
    try { await apiJson('DELETE', `/api/sessions/${id}`); } catch {}
  }
  selectedSessionIds.clear();
  document.getElementById('multiselectBar').classList.remove('visible');
  showToast('Sessions deleted', 'success');
  await loadSessions();
});

// ── Type switching buttons ─────────────────────────────────────────────────
document.querySelectorAll('.sc-rail .rail-item').forEach(btn => {
  btn.addEventListener('click', () => switchType(btn.dataset.view));
});
document.querySelectorAll('.nav-type-tab').forEach(btn => {
  btn.addEventListener('click', () => switchType(btn.dataset.type));
});
document.querySelectorAll('.nav-group').forEach(el => {
  el.addEventListener('click', () => switchGroup(el.dataset.group));
});

// ── Search ─────────────────────────────────────────────────────────────────
document.getElementById('sessionSearch').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  renderSessionList();
});

// ── Load Sessions from API ─────────────────────────────────────────────────
async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    if (res.status === 401) { location.href = '/login?Reason=NotAuthenticated'; return; }
    if (!res.ok) return;
    sessions = await res.json();
    renderSessionList();
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

// ── WebSocket for live updates ─────────────────────────────────────────────
function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws?role=host`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    } catch {}
  };

  ws.onclose = () => {
    wsReconnectTimer = setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => ws.close();
}

function handleWsMessage(msg) {
  const type = msg.type || '';

  if (type === 'session.update' || type === 'session.created' || type === 'session.deleted') {
    loadSessions();
  }
  if (type === 'frame' || type === 'screen.frame') {
    // Render screen frame if matching selected session
    const payload = msg.payload || msg;
    if (payload.sessionId === selectedSessionId) {
      const frame = document.getElementById('nativeFrame');
      if (payload.data || payload.frame) {
        frame.src = `data:image/jpeg;base64,${payload.data || payload.frame}`;
        frame.style.display = '';
        document.getElementById('viewerPlaceholder').style.display = 'none';
      }
    }
  }
  if (type === 'chat' || type === 'message') {
    const p = msg.payload || msg;
    if (p.sessionId === selectedSessionId && p.from !== 'host') {
      addChatMessage(p.message || p.text || '', 'from-guest');
    }
  }
  if (type === 'command.result') {
    const p = msg.payload || msg;
    if (p.sessionId === selectedSessionId) {
      const out = document.getElementById('terminalOutput');
      out.textContent += (p.output || p.result || '') + '\n';
      out.scrollTop = out.scrollHeight;
    }
  }
}

// ── Logout ─────────────────────────────────────────────────────────────────
document.getElementById('btnLogout').addEventListener('click', async () => {
  try {
    await api('POST', '/api/auth/logout');
  } catch {}
  location.href = '/login?Reason=Logout';
});

// ── User info ──────────────────────────────────────────────────────────────
async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      currentUser = await res.json();
      const name = currentUser.displayName || currentUser.username || 'U';
      const initial = name.charAt(0).toUpperCase();
      ['userAvatar', 'userAvatarSmall'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = initial;
      });
    }
  } catch {}
}

// ── Initialize ─────────────────────────────────────────────────────────────
async function init() {
  await loadCurrentUser();
  await loadSessions();
  connectWebSocket();

  // Start polling as fallback
  liveDataInterval = setInterval(loadSessions, 10000);

  // Default view
  switchType('support');
}

init();
