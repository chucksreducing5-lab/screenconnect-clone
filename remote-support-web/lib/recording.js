// Server-side recording of relayed customer screen frames for later replay.
// Frames are appended to disk as JSONL (one frame per line) under RECORDINGS_DIR
// so memory use stays flat regardless of session length. Replay reads back
// paginated slices. Recording is opt-in per session (technician toggles it).
import fs from 'fs';
import path from 'path';

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(process.cwd(), 'recordings');
const active = new Map(); // sessionId -> { stream, meta, framePath, metaPath, startTs }

// Only allow safe id characters to prevent path traversal.
export function safeId(id) {
  const s = String(id || '');
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

export function isRecording(sessionId) { return active.has(sessionId); }

export function startRecording(session) {
  const id = safeId(session?.id);
  if (!id) return null;
  if (active.has(id)) return active.get(id).meta;
  const dir = path.join(RECORDINGS_DIR, id);
  ensureDir(dir);
  const framePath = path.join(dir, 'frames.jsonl');
  const metaPath = path.join(dir, 'meta.json');
  const stream = fs.createWriteStream(framePath, { flags: 'a' });
  const meta = {
    sessionId: id,
    joinCode: session.joinCode || null,
    displayName: session.displayName || session.deviceName || null,
    startedAt: Date.now(),
    stoppedAt: null,
    frameCount: 0,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  active.set(id, { stream, meta, framePath, metaPath, startTs: Date.now() });
  return meta;
}

export function recordFrame(sessionId, payload) {
  const rec = active.get(sessionId);
  if (!rec) return;
  const image = payload?.image || payload?.data;
  if (!image) return;
  const line = JSON.stringify({
    t: Date.now() - rec.startTs,
    seq: Number(payload?.sequence ?? rec.meta.frameCount),
    w: payload?.width || null,
    h: payload?.height || null,
    image,
  }) + '\n';
  rec.stream.write(line);
  rec.meta.frameCount += 1;
}

export function stopRecording(sessionId) {
  const rec = active.get(sessionId);
  if (!rec) return null;
  rec.meta.stoppedAt = Date.now();
  try { rec.stream.end(); } catch {}
  try { fs.writeFileSync(rec.metaPath, JSON.stringify(rec.meta)); } catch {}
  active.delete(sessionId);
  return rec.meta;
}

function readMeta(id) {
  const metaPath = path.join(RECORDINGS_DIR, id, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; }
}
function frameFileSize(id) {
  try { return fs.statSync(path.join(RECORDINGS_DIR, id, 'frames.jsonl')).size; } catch { return 0; }
}

export function listRecordings() {
  ensureDir(RECORDINGS_DIR);
  const out = [];
  for (const id of fs.readdirSync(RECORDINGS_DIR)) {
    if (!safeId(id)) continue;
    const meta = readMeta(id);
    if (!meta) continue;
    const live = active.has(id);
    out.push({ ...meta, live, frameCount: live ? active.get(id).meta.frameCount : meta.frameCount, sizeBytes: frameFileSize(id) });
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return out;
}

export function getRecordingMeta(sessionId) {
  const id = safeId(sessionId);
  if (!id) return null;
  const meta = readMeta(id);
  if (!meta) return null;
  const live = active.has(id);
  return { ...meta, live, frameCount: live ? active.get(id).meta.frameCount : meta.frameCount, sizeBytes: frameFileSize(id) };
}

export function getRecordingFrames(sessionId, from = 0, limit = 50) {
  const id = safeId(sessionId);
  if (!id) return { frames: [], total: 0 };
  const framePath = path.join(RECORDINGS_DIR, id, 'frames.jsonl');
  if (!fs.existsSync(framePath)) return { frames: [], total: 0 };
  const lines = fs.readFileSync(framePath, 'utf8').split('\n').filter(Boolean);
  const start = Math.max(0, Number(from) || 0);
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const frames = lines.slice(start, start + lim).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { frames, total: lines.length };
}

export function deleteRecording(sessionId) {
  const id = safeId(sessionId);
  if (!id) return false;
  stopRecording(id);
  try { fs.rmSync(path.join(RECORDINGS_DIR, id), { recursive: true, force: true }); return true; } catch { return false; }
}

// Delete recordings whose startedAt is older than `days` days. Live (in-progress)
// recordings are never deleted. Returns the number removed.
export function pruneOlderThan(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const cutoff = Date.now() - d * 86400000;
  let removed = 0;
  for (const r of listRecordings()) {
    if (r.live) continue;
    const ts = r.stoppedAt || r.startedAt || 0;
    if (ts && ts < cutoff) { if (deleteRecording(r.sessionId)) removed += 1; }
  }
  return removed;
}
