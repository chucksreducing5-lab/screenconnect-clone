// Optional Redis connection with graceful fallback.
// When REDIS_URL is set and reachable, callers get a shared ioredis client;
// otherwise getRedis() returns null and callers fall back to in-memory logic.
import Redis from 'ioredis';

let client = null;
let ready = false;
let initialized = false;

export function initRedis() {
  if (initialized) return client;
  initialized = true;

  const url = String(process.env.REDIS_URL || '').trim();
  if (!url) {
    console.log('[redis] REDIS_URL not set — using in-memory fallbacks');
    return null;
  }

  try {
    client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    client.on('ready', () => {
      ready = true;
      console.log('[redis] connected — distributed rate limiting active');
    });
    client.on('end', () => { ready = false; });
    client.on('error', (err) => {
      ready = false;
      // Do not crash the process on transient Redis errors.
      console.error(`[redis] error: ${err && err.message ? err.message : err}`);
    });
  } catch (err) {
    console.error(`[redis] init failed: ${err && err.message ? err.message : err}`);
    client = null;
  }
  return client;
}

// Returns the client only when it is connected and usable, else null.
export function getRedis() {
  return ready && client ? client : null;
}
