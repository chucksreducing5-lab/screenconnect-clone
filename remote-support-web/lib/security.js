// Web security: CORS allowlist, Origin-based CSRF guard, and security headers.
// Origins come from ALLOWED_ORIGINS (comma-separated) or a safe default set.

const DEFAULT_ORIGINS = [
  'https://helpsupport.top',
  'https://www.helpsupport.top',
  'http://localhost:3001',
];

export function getAllowedOrigins() {
  const env = String(process.env.ALLOWED_ORIGINS || '').trim();
  const list = env ? env.split(',') : DEFAULT_ORIGINS;
  return list.map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

const ALLOWED = new Set(getAllowedOrigins());

function isAllowedOrigin(origin) {
  return ALLOWED.has(String(origin || '').replace(/\/+$/, ''));
}

// cors() options: reflect only allowlisted origins; allow non-browser clients
// (no Origin header — native apps, curl, server-to-server).
export const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    return cb(null, isAllowedOrigin(origin));
  },
  credentials: true,
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// CSRF defense: state-changing /api calls that carry a browser Origin must have
// an allowlisted Origin. Requests without an Origin header (native apps, curl)
// are unaffected, preserving the mobile/native app flows.
export function csrfGuard(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  if (!req.path.startsWith('/api/')) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  if (isAllowedOrigin(origin)) return next();
  return res.status(403).json({ error: 'Cross-origin request blocked.' });
}

export function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || req.protocol || '') === 'https';
}

export function securityHeaders(req, res, next) {
  if (isHttps(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'display-capture=(self), camera=(self), microphone=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self' ws: wss: https:",
    "font-src 'self' data:",
  ].join('; '));
  next();
}
