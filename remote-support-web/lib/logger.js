// Request logging with correlation IDs and secret scrubbing.
// - Every request gets an X-Request-Id (reuses an inbound one if present).
// - Any `token`/`code`/`password` value in a URL or logged string is redacted
//   so the legacy `?token=` native/mobile fallback never lands in access logs.
import crypto from 'crypto';

const SENSITIVE_QUERY_KEYS = ['token', 'code', 'password', 'pass', 'secret', 'key'];

// Redact sensitive query params from a URL or path+query string.
export function scrubUrl(input) {
  const raw = String(input == null ? '' : input);
  return raw.replace(/([?&](?:token|code|password|pass|secret|key)=)([^&#\s]*)/gi, '$1[REDACTED]');
}

// Redact bearer tokens and sensitive query params from an arbitrary string.
export function scrubString(input) {
  let s = scrubUrl(input);
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]');
  s = s.replace(/(cp\.token\.)[A-Za-z0-9._-]+/g, '$1[REDACTED]');
  return s;
}

export function newRequestId() {
  return crypto.randomBytes(8).toString('hex');
}

// Express middleware: assigns req.id, echoes X-Request-Id, and logs a single
// scrubbed line per completed request.
export function requestLogger(req, res, next) {
  const incoming = String(req.headers['x-request-id'] || '').trim();
  req.id = incoming && /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : newRequestId();
  res.setHeader('X-Request-Id', req.id);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const line = `[${req.id}] ${req.method} ${scrubUrl(req.originalUrl || req.url)} ${res.statusCode} ${ms.toFixed(1)}ms`;
    console.log(line);
  });
  next();
}

export { SENSITIVE_QUERY_KEYS };
