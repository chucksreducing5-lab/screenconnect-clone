// Per-IP rate limiter. Uses Redis (fixed-window counter) when connected so the
// limit is shared across processes/instances; otherwise falls back to an
// in-memory sliding-window per process. On any Redis error it fails open to the
// in-memory path so a Redis outage never blocks legitimate traffic.
import { getRedis } from './redisClient.js';

const memoryBuckets = new Map();

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || 'unknown')
    .toString()
    .split(',')[0]
    .trim();
}

function memoryAllow(id, max, windowMs) {
  const now = Date.now();
  const arr = (memoryBuckets.get(id) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  memoryBuckets.set(id, arr);
  return true;
}

async function redisAllow(redis, id, max, windowMs) {
  // Fixed-window counter: INCR the key and set expiry on first hit.
  const key = `rl:${id}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.pexpire(key, windowMs);
  }
  return count <= max;
}

// Returns true if the request is allowed. When blocked, writes a 429 response
// and returns false so callers can `if (!(await rateLimit(...))) return;`.
export async function rateLimit(req, res, key, max, windowMs) {
  const id = `${key}:${clientIp(req)}`;
  let allowed;

  const redis = getRedis();
  if (redis) {
    try {
      allowed = await redisAllow(redis, id, max, windowMs);
    } catch {
      allowed = memoryAllow(id, max, windowMs);
    }
  } else {
    allowed = memoryAllow(id, max, windowMs);
  }

  if (!allowed) {
    res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
    return false;
  }
  return true;
}
