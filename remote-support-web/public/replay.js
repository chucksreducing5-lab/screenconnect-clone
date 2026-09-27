// Session recording replay: lists recordings and plays back stored screen frames.
(function () {
  const listEl = document.getElementById('recordingsList');
  const titleEl = document.getElementById('playerTitle');
  const img = document.getElementById('frameImg');
  const btnPlay = document.getElementById('btnPlay');
  const btnRestart = document.getElementById('btnRestart');
  const seek = document.getElementById('seek');
  const speedSel = document.getElementById('speed');
  const statusEl = document.getElementById('replayStatus');

  let frames = [];       // { t, image }
  let idx = 0;
  let playing = false;
  let timer = null;
  let activeId = null;

  function fmtTime(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleString();
  }
  function fmtBytes(b) {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(1)} ${u[i]}`;
  }

  async function loadList() {
    try {
      const res = await fetch('/api/recordings', { credentials: 'include' });
      if (res.status === 401) { window.location.href = '/login'; return; }
      const items = await res.json();
      if (!Array.isArray(items) || !items.length) {
        listEl.innerHTML = '<div class="rp-empty">No recordings yet. Toggle recording on a live session to capture one.</div>';
        return;
      }
      listEl.innerHTML = items.map((r) => `
        <div class="rp-item" data-id="${r.sessionId}" data-testid="recording-item-${r.sessionId}">
          <div class="code">${r.joinCode || r.sessionId}${r.live ? '<span class="rp-live">● REC</span>' : ''}</div>
          <div class="meta">${r.displayName || 'Session'} · ${r.frameCount || 0} frames · ${fmtBytes(r.sizeBytes)}</div>
          <div class="meta">${fmtTime(r.startedAt)}</div>
        </div>`).join('');
      listEl.querySelectorAll('.rp-item').forEach((el) => {
        el.addEventListener('click', () => openRecording(el.getAttribute('data-id'), el));
      });
    } catch {
      listEl.innerHTML = '<div class="rp-empty">Failed to load recordings.</div>';
    }
  }

  async function openRecording(id, el) {
    stop();
    activeId = id;
    frames = []; idx = 0;
    document.querySelectorAll('.rp-item').forEach((x) => x.classList.remove('active'));
    if (el) el.classList.add('active');
    titleEl.textContent = `Loading recording ${id}…`;
    statusEl.textContent = '';

    try {
      const metaRes = await fetch(`/api/recordings/${id}`, { credentials: 'include' });
      if (metaRes.status === 401) { window.location.href = '/login'; return; }
      const meta = await metaRes.json();
      const total = meta.frameCount || 0;
      titleEl.textContent = `${meta.joinCode || id} — ${meta.displayName || 'Session'}`;

      // Fetch frames in batches to keep requests small.
      let from = 0; const batch = 100;
      while (from < total) {
        const r = await fetch(`/api/recordings/${id}/frames?from=${from}&limit=${batch}`, { credentials: 'include' });
        const data = await r.json();
        (data.frames || []).forEach((f) => frames.push({ t: f.t || 0, image: f.image }));
        if (!data.frames || !data.frames.length) break;
        from += data.frames.length;
        statusEl.textContent = `Loaded ${frames.length}/${total} frames…`;
      }

      if (!frames.length) { statusEl.textContent = 'This recording has no frames.'; return; }
      seek.max = String(frames.length - 1);
      seek.value = '0';
      seek.disabled = false; btnPlay.disabled = false; btnRestart.disabled = false;
      showFrame(0);
      statusEl.textContent = `${frames.length} frames ready.`;
    } catch {
      titleEl.textContent = 'Failed to load recording.';
    }
  }

  function showFrame(i) {
    if (i < 0 || i >= frames.length) return;
    idx = i;
    img.src = frames[i].image;
    img.style.display = 'block';
    seek.value = String(i);
  }

  function scheduleNext() {
    if (!playing) return;
    if (idx >= frames.length - 1) { stop(); return; }
    const cur = frames[idx].t || 0;
    const nxt = frames[idx + 1].t || cur;
    const speed = Number(speedSel.value) || 1;
    const delay = Math.max(16, Math.min(2000, (nxt - cur) / speed));
    timer = setTimeout(() => { showFrame(idx + 1); scheduleNext(); }, delay);
  }

  function play() {
    if (!frames.length) return;
    if (idx >= frames.length - 1) idx = 0;
    playing = true; btnPlay.textContent = '⏸ Pause';
    scheduleNext();
  }
  function stop() {
    playing = false; btnPlay.textContent = '▶ Play';
    if (timer) { clearTimeout(timer); timer = null; }
  }

  btnPlay.addEventListener('click', () => (playing ? stop() : play()));
  btnRestart.addEventListener('click', () => { stop(); showFrame(0); });
  seek.addEventListener('input', () => { stop(); showFrame(Number(seek.value)); });

  loadList();
  setInterval(loadList, 15000); // refresh list so live recordings update
})();
