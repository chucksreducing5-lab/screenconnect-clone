// Per-IP rate limiter. Uses Redis (fixed-window counter) when connected so the
// limit is shared across processes/instances; otherwise falls back to an
// in-memory sliding-window per process. On any Redis error it fails open to the
// in-memory path so a Redis outage never blocks legitimate traffic.
//
// Trusted IPs (RATE_LIMIT_ALLOWLIST, comma-separated IPs and/or CIDR ranges)
// bypass rate limiting entirely. Per-endpoint limits are env-configurable via
// RL_<NAME>_MAX / RL_<NAME>_WINDOW_MS and applied through guard(req,res,name).
import { getRedis } from './redisClient.js';

const memoryBuckets = new Map();

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || 'unknown')
    .toString()
    .split(',')[0]
    .trim();
}

// ---- Trusted-IP allowlist (exact IPv4/IPv6 or IPv4 CIDR) ----
function ipToLong(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function inCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipL = ipToLong(ip);
  const rL = ipToLong(range);
  if (ipL == null || rL == null || Number.isNaN(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipL & mask) === (rL & mask);
}
const ALLOWLIST = String(process.env.RATE_LIMIT_ALLOWLIST || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
function isAllowlistedIp(ip) {
  for (const entry of ALLOWLIST) {
    if (entry.includes('/')) { if (inCidr(ip, entry)) return true; }
    else if (entry === ip) return true;
  }
  return false;
}

// ---- Per-endpoint limit config (env-overridable) ----
function envNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}
export const RL = {
  login:  { max: envNum('RL_LOGIN_MAX', 10),  windowMs: envNum('RL_LOGIN_WINDOW_MS', 60000) },
  join:   { max: envNum('RL_JOIN_MAX', 20),   windowMs: envNum('RL_JOIN_WINDOW_MS', 60000) },
  create: { max: envNum('RL_CREATE_MAX', 30), windowMs: envNum('RL_CREATE_WINDOW_MS', 60000) },
  reset:  { max: envNum('RL_RESET_MAX', 5),   windowMs: envNum('RL_RESET_WINDOW_MS', 60000) },
};

function memoryAllow(id, max, windowMs) {
  const now = Date.now();
  const arr = (memoryBuckets.get(id) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  memoryBuckets.set(id, arr);
  return true;
}

async function redisAllow(redis, id, max, windowMs) {
  const key = `rl:${id}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.pexpire(key, windowMs);
  return count <= max;
}

// Returns true if allowed. When blocked, writes a 429 and returns false, so
// callers use `if (!(await rateLimit(...))) return;`.
export async function rateLimit(req, res, key, max, windowMs) {
  if (isAllowlistedIp(clientIp(req))) return true;

  const id = `${key}:${clientIp(req)}`;
  let allowed;
  const redis = getRedis();
  if (redis) {
    try { allowed = await redisAllow(redis, id, max, windowMs); }
    catch { allowed = memoryAllow(id, max, windowMs); }
  } else {
    allowed = memoryAllow(id, max, windowMs);
  }

  if (!allowed) {
    res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
    return false;
  }
  return true;
}

// Convenience: apply the configured per-endpoint limit by name.
export async function guard(req, res, name) {
  const c = RL[name] || { max: 60, windowMs: 60000 };
  return rateLimit(req, res, name, c.max, c.windowMs);
}
