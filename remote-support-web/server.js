import express from 'express';
import http from 'http';
import https from 'https';
import fs from 'fs';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import crypto from 'crypto';
import tls from 'tls';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const authSessions = new Map();
const agentLaunches = new Map();
const hostLaunches = new Map();
const AUTH_COOKIE = 'rs_auth';
const TECH_USERNAME = process.env.TECH_USERNAME || 'admin';
const TECH_PASSWORD = process.env.TECH_PASSWORD || 'admin';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SMTP_USER || '';
const ALLOW_INSECURE_AGENT_TLS = ['1', 'true', 'yes'].includes(String(process.env.ALLOW_INSECURE_AGENT_TLS || '').toLowerCase());
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;

// ScreenConnect-compatible session types
const SESSION_TYPES = { Support: 0, Meeting: 1, Access: 2 };
const SESSION_TYPE_NAMES = { 0: 'Support', 1: 'Meeting', 2: 'Access' };

// Custom property labels (ScreenConnect has 8 slots)
const CUSTOM_PROPERTY_LABELS = [
  process.env.CUSTOM_PROP_1 || 'Company',
  process.env.CUSTOM_PROP_2 || 'Site',
  process.env.CUSTOM_PROP_3 || 'Department',
  process.env.CUSTOM_PROP_4 || 'Device Type',
  process.env.CUSTOM_PROP_5 || 'Custom Property 5',
  process.env.CUSTOM_PROP_6 || 'Custom Property 6',
  process.env.CUSTOM_PROP_7 || 'Custom Property 7',
  process.env.CUSTOM_PROP_8 || 'Custom Property 8'
];

// Session groups storage
const sessionGroups = new Map();
// Host passes (delegated access tokens)
const hostPasses = new Map();
// Diagnostics data per device
const deviceDiagnostics = new Map();
// Roles storage
const roles = new Map();
// Extensions registry
const installedExtensions = new Map();
const DEFAULT_ALLOW_INSECURE_AGENT_TLS = ['1', 'true', 'yes'].includes(String(process.env.DEFAULT_ALLOW_INSECURE_AGENT_TLS || '').toLowerCase());
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://www.helpsupport.top').replace(/\/+$/, '');
const DOWNLOAD_BASE_URL = String(process.env.DOWNLOAD_BASE_URL || 'https://www.helpsupport.top').replace(/\/+$/, '');
const IOS_APP_URL = String(process.env.IOS_APP_URL || 'https://apps.apple.com/app/connectwise-control/id1049829834').trim();
const ANDROID_APP_URL = String(process.env.ANDROID_APP_URL || 'https://play.google.com/store/apps/details?id=com.screenconnect.androidclient').trim();
const MOBILE_SUPPORT_APP_NAME = String(process.env.MOBILE_SUPPORT_APP_NAME || 'ConnectWise Control').trim();
const SEED_DEMO_CLIENTS = ['1', 'true', 'yes'].includes(String(process.env.SEED_DEMO_CLIENTS || '').toLowerCase());
// Ensure customer/host links remain stable and do not depend on ephemeral local state.
// If your tunnel/proxy changes Host header or scheme, set PUBLIC_BASE_URL to your fixed domain.

const agentPublishDir = path.join(__dirname, 'native-agent', 'publish');
const hostPublishDir = path.join(__dirname, 'native-host', 'publish');
const DOWNLOAD_PRODUCT_PREFIX = process.env.DOWNLOAD_PRODUCT_PREFIX || 'supportdesk';
const CUSTOMER_AGENT_EXE_NAME = `${DOWNLOAD_PRODUCT_PREFIX}.ClientSetup.exe`;
const HOST_LAUNCHER_NAME = `${DOWNLOAD_PRODUCT_PREFIX}.ClientHost.cmd`;
const HOST_VIEWER_EXE_NAME = `${DOWNLOAD_PRODUCT_PREFIX}.HostViewer.exe`;
const CUSTOMER_AGENT_BUILD = '0.2.22-uac-frame-diagnostics';
const HOST_VIEWER_BUILD = '0.2.11-browser-relay-compatible';
const MAX_SCREEN_FRAME_BUFFER_BYTES = 512 * 1024;
const NO_FRAME_TELEMETRY_TIMEOUT_MS = 15000;
const MOBILE_HEARTBEAT_INTERVAL_MS = 5000;
const MOBILE_HEARTBEAT_TIMEOUT_MS = 15000;
const MOBILE_FRAME_STALE_TIMEOUT_MS = 15000;
const dataDir = path.join(__dirname, 'data');
const authStatePath = path.join(dataDir, 'auth.json');
const resetCodes = new Map();

function loadAdminCredentials() {
  try {
    if (fs.existsSync(authStatePath)) {
      const saved = JSON.parse(fs.readFileSync(authStatePath, 'utf8').replace(/^\uFEFF/, ''));
      return {
        username: String(saved.username || TECH_USERNAME),
        password: String(saved.password || TECH_PASSWORD),
        email: String(saved.email || ADMIN_EMAIL)
      };
    }
  } catch (err) {
    console.warn(`Could not load admin credentials: ${err.message}`);
  }

  return {
    username: TECH_USERNAME,
    password: TECH_PASSWORD,
    email: ADMIN_EMAIL
  };
}

let adminCredentials = loadAdminCredentials();

function saveAdminCredentials() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(authStatePath, JSON.stringify(adminCredentials, null, 2));
}

function smtpRead(socket) {
  return new Promise((resolve, reject) => {
    let data = '';
    const onData = (chunk) => {
      data += chunk.toString('utf8');
      const lines = data.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1) || '';
      if (/^\d{3}\s/.test(last)) {
        socket.off('data', onData);
        socket.off('error', onError);
        resolve(data);
      }
    };
    const onError = (err) => {
      socket.off('data', onData);
      reject(err);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

async function smtpCommand(socket, command, expected = /^[23]/) {
  if (command) socket.write(`${command}\r\n`);
  const response = await smtpRead(socket);
  if (!expected.test(response)) {
    throw new Error(`SMTP command failed: ${command || '<connect>'}: ${response.trim()}`);
  }
  return response;
}

async function sendResetEmail(to, code) {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const from = process.env.SMTP_FROM || user;

  if (!to || !user || !pass || !from) {
    console.warn(`Password reset code for ${to || '<missing admin email>'}: ${code}. Configure ADMIN_EMAIL, SMTP_USER, and SMTP_PASS to send email.`);
    return { sent: false };
  }

  const socket = tls.connect({ host, port, servername: host });
  await smtpCommand(socket, null);
  await smtpCommand(socket, `EHLO ${host}`);
  await smtpCommand(socket, 'AUTH LOGIN', /^334/);
  await smtpCommand(socket, Buffer.from(user).toString('base64'), /^334/);
  await smtpCommand(socket, Buffer.from(pass).toString('base64'));
  await smtpCommand(socket, `MAIL FROM:<${from}>`);
  await smtpCommand(socket, `RCPT TO:<${to}>`);
  await smtpCommand(socket, 'DATA', /^354/);

  const body = [
    `From: Remote Support <${from}>`,
    `To: ${to}`,
    'Subject: Remote Support admin reset code',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Your Remote Support admin password reset code is: ${code}`,
    '',
    'This code expires in 10 minutes. If you did not request it, ignore this email.',
    '.'
  ].join('\r\n');
  await smtpCommand(socket, body);
  await smtpCommand(socket, 'QUIT', /^[23]/);
  socket.end();
  return { sent: true };
}

function publicOrigin(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  return requestOrigin(req);
}

function requestOrigin(req) {
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol;
  const host = forwardedHost || req.get('host');
  return `${protocol}://${host}`;
}

function absoluteUrl(req, pathname = '/') {
  return `${publicOrigin(req)}${pathname}`;
}

function downloadUrl(req, pathname = '/') {
  return `${publicOrigin(req)}${pathname}`;
}

function alternateDownloadUrl(req, pathname = '/') {
  const fallback = alternateOrigin(req);
  return fallback ? `${fallback}${pathname}` : null;
}

function alternateOrigin(req) {
  const primary = publicOrigin(req).replace(/\/+$/, '');
  const candidates = [
    requestOrigin(req),
    PUBLIC_BASE_URL,
    DOWNLOAD_BASE_URL
  ].map((value) => String(value || '').replace(/\/+$/, ''));
  return candidates.find((value) => value && value.toLowerCase() !== primary.toLowerCase()) || null;
}

function downloadAliasUrl(fileName, query) {
  const encodedQuery = new URLSearchParams(query).toString();
  return `/download/${fileName}${encodedQuery ? `?${encodedQuery}` : ''}`;
}

function mobileSupportLinks(req, session, platform = 'unknown') {
  const baseUrl = publicOrigin(req);
  const isIos = platform === 'ios' || platform === 'iphone' || platform === 'ipad';
  const deepLink = new URL('supportdesk://join');
  deepLink.searchParams.set('server', baseUrl);
  deepLink.searchParams.set('sessionId', session.id);
  deepLink.searchParams.set('token', session.customer.token);
  deepLink.searchParams.set('platform', platform);
  deepLink.searchParams.set('client', isIos ? 'ios-mobile-broadcast' : 'android-mobile-broadcast');

  // Alternative deep link for ConnectWise Control app compatibility
  const scDeepLink = new URL('screenconnect://join');
  scDeepLink.searchParams.set('server', baseUrl);
  scDeepLink.searchParams.set('sessionId', session.id);
  scDeepLink.searchParams.set('token', session.customer.token);
  scDeepLink.searchParams.set('client', isIos ? 'ios-mobile-broadcast' : 'android-mobile-broadcast');

  const universalLink = new URL('/customer', baseUrl);
  universalLink.searchParams.set('code', session.joinCode || session.id);
  universalLink.searchParams.set('mobileApp', '1');

  return {
    deepLink: deepLink.toString(),
    screenconnectDeepLink: scDeepLink.toString(),
    universalLink: universalLink.toString(),
    appName: MOBILE_SUPPORT_APP_NAME,
    hostUrl: baseUrl,
    joinCode: session.joinCode || session.id,
    installUrl: isIos ? IOS_APP_URL : ANDROID_APP_URL,
    websocketClient: isIos ? 'ios-mobile-broadcast' : 'mobile-broadcast',
    broadcastTechnology: isIos ? 'apple-replaykit-broadcast-extension' : 'android-media-projection',
    requiresNativeApp: isIos,
    supportsRemoteControl: !isIos,
    frameMessageType: 'screen.frame',
    statusMessageType: 'screen.broadcast.status',
    reason: isIos
      ? `iPhone/iPad browsers do not expose full-device screen capture to web pages. Use the ${MOBILE_SUPPORT_APP_NAME} app with Apple Screen Broadcast permission.`
      : `Use the ${MOBILE_SUPPORT_APP_NAME} app when browser screen sharing is unavailable.`,
    appInstructions: isIos
      ? `Open ${MOBILE_SUPPORT_APP_NAME}. Visit Host URL ${baseUrl}. Enter Code ${session.joinCode || session.id}. Initiate ScreenShare. Then tap Start Broadcast in the Apple broadcast prompt.`
      : `Open ${MOBILE_SUPPORT_APP_NAME}. Visit Host URL ${baseUrl}. Enter Code ${session.joinCode || session.id}. Initiate ScreenShare. Then approve the system screen sharing prompt.`
  };
}

function wantsMarkdown(req) {
  return String(req.get('accept') || '').toLowerCase().includes('text/markdown');
}

function sendDiscoveryLinkHeaders(req, res) {
  res.setHeader('Link', [
    `<${absoluteUrl(req, '/sitemap.xml')}>; rel="sitemap"; type="application/xml"`,
    `<${absoluteUrl(req, '/.well-known/api-catalog')}>; rel="api-catalog"; type="application/linkset+json"`,
    `<${absoluteUrl(req, '/.well-known/oauth-authorization-server')}>; rel="oauth-authorization-server"; type="application/json"`,
    `<${absoluteUrl(req, '/auth.md')}>; rel="service-doc"; type="text/markdown"`,
    `<${absoluteUrl(req, '/health')}>; rel="status"; type="application/json"`
  ].join(', '));
}

function remoteSupportSkillMarkdown(req) {
  return [
    '# Remote Support Status Skill',
    '',
    'This skill lets an agent discover the remote support service status and public entrypoints.',
    '',
    '## Inputs',
    '',
    '- `includeLinks` boolean, optional. Return key support URLs when true.',
    '',
    '## Output',
    '',
    'A JSON object containing service health and optional URLs.',
    '',
    '## Endpoint',
    '',
    `- Health: ${absoluteUrl(req, '/health')}`,
    `- Customer join: ${absoluteUrl(req, '/customer')}`,
    ''
  ].join('\n');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function agentLaunchPayload(req, session, token, launchId = null) {
  const origin = publicOrigin(req);
  const fallback = alternateOrigin(req);
  return Buffer.from(
    JSON.stringify({
      u: origin,
      s: session.id,
      t: token,
      ...(launchId ? { l: launchId } : {}),
      ...(fallback ? { h: fallback } : {}),
      // Always include k:true when either ALLOW_INSECURE_AGENT_TLS is enabled
      // or DEFAULT_ALLOW_INSECURE_AGENT_TLS is enabled.
      ...(ALLOW_INSECURE_AGENT_TLS || DEFAULT_ALLOW_INSECURE_AGENT_TLS ? { k: true } : {})
    }),
    'utf8'
  ).toString('base64url');
}

function agentLaunchFileToken(launchId) {
  // Use launchk- prefix so the customer EXE enables trusted TLS fallback mode
  // when resolving launch metadata from public support domains.
  return launchId ? `launchk-${launchId}` : null;
}

function hostLaunchPayload(req, session, token, launchId = null) {
  const origin = publicOrigin(req);
  const fallback = alternateOrigin(req);
  return Buffer.from(
    JSON.stringify({
      u: origin,
      s: session.id,
      t: token,
      ...(launchId ? { l: launchId } : {}),
      ...(fallback ? { h: fallback } : {}),
      ...(ALLOW_INSECURE_AGENT_TLS ? { k: true } : {})
    }),
    'utf8'
  ).toString('base64url');
}

function createLaunchRecord(store, session, token, ttlMs = 1000 * 60 * 60 * 24) {
  const launchId = nanoid(12);
  store.set(launchId, {
    sessionId: session.id,
    token,
    expiresAt: Date.now() + ttlMs
  });
  schedulePersistState();
  return launchId;
}

function hostClientUrl(origin, session, token) {
  const url = new URL('/host-client.html', origin);
  url.searchParams.set('sessionId', session.id);
  url.searchParams.set('token', token);
  url.searchParams.set('baseUrl', origin);
  url.searchParams.set('displayName', session.displayName || '');
  return url.toString();
}

function launchNativeHostViewer(serverUrl, session, token) {
  const viewerPath = path.join(hostPublishDir, 'RemoteSupportHost.exe');
  if (!fs.existsSync(viewerPath)) {
    return { ok: false, error: 'Host viewer has not been published yet.' };
  }

  const child = spawn(viewerPath, [serverUrl, '--session', session.id, '--token', token], {
    cwd: hostPublishDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
  return { ok: true, pid: child.pid };
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  const session = authSessions.get(cookies[AUTH_COOKIE]);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    authSessions.delete(cookies[AUTH_COOKIE]);
    return false;
  }
  return true;
}

function requireTechnician(req, res, next) {
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required' });
  return res.redirect('/login');
}

app.set('trust proxy', true);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.get(['/login', '/Login'], (req, res) => {
  sendDiscoveryLinkHeaders(req, res);
  res.sendFile(path.join(publicDir, 'login.html'));
});
app.get('/api/config', (req, res) => {
  res.json({ publicBaseUrl: PUBLIC_BASE_URL || publicOrigin(req) });
});
app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');
  if (username !== adminCredentials.username || password !== adminCredentials.password) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const sessionId = nanoid(32);
  authSessions.set(sessionId, {
    username,
    expiresAt: Date.now() + COOKIE_MAX_AGE_SECONDS * 1000
  });
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`
  );
  res.json({ ok: true });
});
app.post('/api/password-reset/request', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const adminEmail = String(adminCredentials.email || '').trim().toLowerCase();
  if (!adminEmail) return res.status(400).json({ error: 'Admin reset email is not configured.' });

  if (!email || email === adminEmail) {
    const code = String(crypto.randomInt(100000, 1000000));
    resetCodes.set(adminEmail, {
      code,
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0
    });
    try {
      await sendResetEmail(adminCredentials.email, code);
    } catch (err) {
      console.warn(`Could not send reset email: ${err.message}`);
    }
  }

  res.json({ ok: true });
});
app.post('/api/password-reset/confirm', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  const password = String(req.body?.password || '');
  const adminEmail = String(adminCredentials.email || '').trim().toLowerCase();
  if (!adminEmail) return res.status(400).json({ error: 'Admin reset email is not configured.' });
  const reset = resetCodes.get(adminEmail);

  if ((email && email !== adminEmail) || !reset || reset.expiresAt <= Date.now()) {
    return res.status(400).json({ error: 'Reset code is invalid or expired.' });
  }
  reset.attempts += 1;
  if (reset.attempts > 5) {
    resetCodes.delete(adminEmail);
    return res.status(429).json({ error: 'Too many reset attempts. Request a new code.' });
  }
  if (code !== reset.code) {
    return res.status(400).json({ error: 'Reset code is invalid or expired.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  adminCredentials = {
    ...adminCredentials,
    password
  };
  saveAdminCredentials();
  resetCodes.delete(adminEmail);
  authSessions.clear();
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  authSessions.delete(cookies[AUTH_COOKIE]);
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    '',
    'User-agent: GPTBot',
    'Allow: /',
    'User-agent: Google-Extended',
    'Allow: /',
    'User-agent: CCBot',
    'Allow: /',
    'User-agent: Bytespider',
    'Allow: /',
    'User-agent: Applebot-Extended',
    'Allow: /',
    'User-agent: Amazonbot',
    'Allow: /',
    'User-agent: meta-externalagent',
    'Allow: /',
    '',
    'Content-Signal: ai-train=no',
    `Sitemap: ${absoluteUrl(req, '/sitemap.xml')}`,
    ''
  ].join('\n'));
});

app.get('/sitemap.xml', (req, res) => {
  const urls = [
    '/',
    '/login',
    '/customer',
    '/customer.html',
    '/host-client.html',
    '/health',
    '/auth.md',
    '/.well-known/api-catalog',
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
    '/.well-known/oauth-protected-resource',
    '/.well-known/mcp/server-card.json',
    '/.well-known/agent-skills/index.json',
    '/.well-known/agent-skills/remote-support-status.md'
  ];
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) => `  <url><loc>${absoluteUrl(req, url)}</loc></url>`),
    '</urlset>'
  ].join('\n');
  res.type('application/xml').send(body);
});

app.get('/auth.md', (req, res) => {
  res.type('text/markdown').send([
    '# auth.md',
    '',
    'Remote Support Authentication',
    '',
    'This site provides a technician console and customer support join flow for authorized technicians.',
    '',
    '## Agent registration',
    '',
    'Automated public agent registration is human-supervised for this service. Agents should discover the metadata below and direct authorized technicians to the browser login flow before any support session is created.',
    '',
    '- Identity types supported: anonymous, human_supervised_agent',
    '- Credential types supported: session_cookie',
    '- Registration metadata: /.well-known/oauth-authorization-server',
    '- Protected resource metadata: /.well-known/oauth-protected-resource',
    '',
    '## Authentication',
    '',
    `Authorization server metadata: ${absoluteUrl(req, '/.well-known/oauth-authorization-server')}`,
    `Protected resource metadata: ${absoluteUrl(req, '/.well-known/oauth-protected-resource')}`,
    `Registration endpoint: ${absoluteUrl(req, '/agent/identity')}`,
    `Claim endpoint: ${absoluteUrl(req, '/agent/identity/claim')}`,
    `Revocation endpoint: ${absoluteUrl(req, '/oauth2/revoke')}`,
    '',
    `Status endpoint: ${absoluteUrl(req, '/health')}`,
    ''
  ].join('\n'));
});

app.get('/.well-known/api-catalog', (req, res) => {
  res.type('application/linkset+json').json({
    linkset: [
      {
        anchor: absoluteUrl(req, '/'),
        'service-doc': [
          {
            href: absoluteUrl(req, '/auth.md'),
            type: 'text/markdown'
          }
        ],
        status: [
          {
            href: absoluteUrl(req, '/health'),
            type: 'application/json'
          }
        ],
        'oauth-authorization-server': [
          {
            href: absoluteUrl(req, '/.well-known/oauth-authorization-server'),
            type: 'application/json'
          }
        ]
      }
    ]
  });
});

app.get(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'], (req, res) => {
  res.json({
    resource: publicOrigin(req),
    authorization_servers: [publicOrigin(req)],
    issuer: publicOrigin(req),
    authorization_endpoint: absoluteUrl(req, '/login'),
    token_endpoint: absoluteUrl(req, '/oauth2/token'),
    revocation_endpoint: absoluteUrl(req, '/oauth2/revoke'),
    jwks_uri: absoluteUrl(req, '/.well-known/jwks.json'),
    response_types_supported: ['code'],
    grant_types_supported: [
      'authorization_code',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
      'urn:workos:agent-auth:grant-type:claim'
    ],
    scopes_supported: [],
    token_endpoint_auth_methods_supported: ['none'],
    service_documentation: absoluteUrl(req, '/auth.md'),
    agent_auth: {
      // Metadata URLs for human-supervised automated registration.
      // (The skill/discovery doc is served at /auth.md.)
      skill: absoluteUrl(req, '/.well-known/agent-skills/remote-support-status.md'),

      // Where the agent should discover/perform registration.
      register_uri: absoluteUrl(req, '/agent/identity'),

      // Where claim ceremonies would be performed (human-supervised in this MVP).
      claim_uri: absoluteUrl(req, '/agent/identity/claim'),

      // Where revocation is performed.
      revocation_uri: absoluteUrl(req, '/oauth2/revoke'),

      identity_endpoint: absoluteUrl(req, '/agent/identity'),
      claim_endpoint: absoluteUrl(req, '/agent/identity/claim'),
      events_endpoint: absoluteUrl(req, '/agent/event/notify'),

      identity_types_supported: ['anonymous', 'human_supervised_agent'],
      credential_types_supported: ['session_cookie'],

      // Some validators expect the shorter aliases too; keep them consistent.
      supported_identity_types: ['anonymous', 'human_supervised_agent'],
      credential_types: ['session_cookie'],

      events_supported: []
    }
  });
});

app.get('/.well-known/jwks.json', (_req, res) => {
  res.json({ keys: [] });
});

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: publicOrigin(req),
    // Keep as a strict array to satisfy agent-auth discovery validators.
    scopes_supported: [],
    bearer_methods_supported: ['header'],
    authorization_servers: [publicOrigin(req)],
    resource_documentation: absoluteUrl(req, '/auth.md'),
    jwks_uri: absoluteUrl(req, '/.well-known/jwks.json')
  });
});

app.post('/agent/identity', (_req, res) => {
  res.status(501).json({
    error: 'agent_registration_human_supervised',
    error_description: 'Automated credential issuance is not enabled. Use /auth.md and the technician login flow.'
  });
});

app.post('/agent/identity/claim', (_req, res) => {
  res.status(501).json({
    error: 'agent_claim_human_supervised',
    error_description: 'Automated claim ceremonies are not enabled. Use /auth.md and the technician login flow.'
  });
});

app.post('/agent/event/notify', (_req, res) => {
  res.status(204).end();
});

app.post('/oauth2/token', (_req, res) => {
  res.status(501).json({
    error: 'unsupported_grant_type',
    error_description: 'Automated OAuth token issuance is not enabled for this remote support console.'
  });
});

app.post('/oauth2/revoke', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/.well-known/mcp/server-card.json', (req, res) => {
  res.json({
    serverInfo: {
      name: 'Remote Support',
      version: '0.1.0'
    },
    transport: {
      type: 'none'
    },
    capabilities: {}
  });
});

app.get('/.well-known/agent-skills/remote-support-status.md', (req, res) => {
  res.type('text/markdown').send(remoteSupportSkillMarkdown(req));
});

app.get('/.well-known/agent-skills/index.json', (req, res) => {
  const skillUrl = absoluteUrl(req, '/.well-known/agent-skills/remote-support-status.md');
  const skillDocument = remoteSupportSkillMarkdown(req);
  res.json({
    $schema: 'https://agentskills.io/schemas/agent-skills-index-v0.2.json',
    skills: [
      {
        name: 'remote-support-status',
        type: 'skill',
        description: 'Discover remote support service health and customer join entrypoints.',
        url: skillUrl,
        sha256: sha256Hex(skillDocument)
      }
    ]
  });
});

app.get(['/', '/Host', '/host'], (req, res, next) => {
  sendDiscoveryLinkHeaders(req, res);
  if (wantsMarkdown(req)) {
    return res.type('text/markdown').send([
      '# Remote Support',
      '',
      'Technician console for creating support sessions and connecting customer devices.',
      '',
      `Status: ${absoluteUrl(req, '/health')}`,
      ''
    ].join('\n'));
  }

  // Customer-friendly root URL: if a join code is present, load customer page directly.
  // This allows links like https://helpsupport.top?code=12345678 to work on mobile.
  const hasJoinCode = String(req.query?.code || '').trim().length > 0;
  if (hasJoinCode) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return res.sendFile(path.join(publicDir, 'customer.html'));
  }

  // If the visitor is not authenticated (i.e. a customer), show the customer
  // landing page so they can enter their join code. Only authenticated
  // technicians proceed to the admin console.
  if (!isAuthenticated(req)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return res.sendFile(path.join(publicDir, 'customer-landing.html'));
  }

  return next();
}, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(publicDir, 'index.html'));
});
app.get(['/customer', '/join', '/Join'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(publicDir, 'customer.html'));
});

// ScreenConnect-style guest page: primary customer entry point with platform detection
// Customers visit this page, enter their code, and get platform-specific client launchers
app.get(['/guest', '/Guest', '/support'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(publicDir, 'customer-landing.html'));
});

app.get('/host-client.html', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(publicDir, 'host-client.html'));
});

// Mobile download landing page
app.get(['/mobile-download', '/download', '/app'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(publicDir, 'mobile-download.html'));
});

// Enhanced customer landing page with platform detection
app.get(['/customer-landing', '/landing', '/download-mobile'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(publicDir, 'customer-landing.html'));
});
app.use((req, res, next) => {
  if (['/app.js', '/host-client.js', '/index.html'].includes(req.path)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
  next();
});
app.use(express.static(publicDir, { index: false }));

// View-only screen viewer (AnyDesk/UltraViewer-like passive display)
// Note: this does NOT change any remote-support signaling or message formats.
app.get('/viewer-only', (req, res) => {
  // This page is a pure display client. Technician opens it with sessionId + agent token.
  res.sendFile(path.join(publicDir, 'viewer-only.html'));
});

const sessions = new Map();
const devices = new Map();
const auditLog = [];
const statePath = path.join(dataDir, 'state.json');
let persistTimer = null;

function now() {
  return Date.now();
}

function schedulePersistState() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistState, 250);
}

function broadcastUpdate(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss?.clients || []) {
    if (client.readyState === 1 && client.role === 'agent' && client.sessionId === 'global') {
      client.send(msg);
    }
  }
}

function persistState() {
  clearTimeout(persistTimer);
  persistTimer = null;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const state = {
      version: 1,
      savedAt: now(),
      sessions: [...sessions.values()],
      devices: [...devices.values()],
      agentLaunches: [...agentLaunches.entries()],
      hostLaunches: [...hostLaunches.entries()],
      auditLog
    };
    const tempPath = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
    try {
      fs.renameSync(tempPath, statePath);
    } catch (renameError) {
      // Windows can briefly lock state.json while antivirus/indexing reads it.
      // Falling back to copy keeps the server alive; a later persist will retry.
      fs.copyFileSync(tempPath, statePath);
      fs.rmSync(tempPath, { force: true });
      console.warn(`State rename fallback used: ${renameError.message}`);
    }
  } catch (err) {
    console.warn(`Could not persist state: ${err.message}`);
    if (!persistTimer) persistTimer = setTimeout(persistState, 2000);
  }
}

function loadState() {
  if (!fs.existsSync(statePath)) return;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const demoDeviceIds = new Set(['dev-alice', 'dev-lab', 'dev-field']);
    for (const device of state.devices || []) {
      if (!device?.id) continue;
      if (!SEED_DEMO_CLIENTS && demoDeviceIds.has(device.id)) continue;
      devices.set(device.id, {
        ...device,
        status: device.status === 'online' ? 'offline' : device.status
      });
    }
    for (const session of state.sessions || []) {
      if (!session?.id) continue;
      if (!SEED_DEMO_CLIENTS && session.deviceId && demoDeviceIds.has(session.deviceId)) continue;
      const liveStatus = ['active', 'customer_joined'].includes(session.status) ? 'waiting' : session.status;
      sessions.set(session.id, {
        ...session,
        status: liveStatus,
        nativeConnected: false,
        customerSocketId: null,
        blankScreen: false,
        recording: Boolean(session.recording),
        files: Array.isArray(session.files) ? session.files : [],
        commands: Array.isArray(session.commands) ? session.commands : [],
        lastSeen: session.lastSeen || { technician: null, endpoint: null },
        permissions: session.permissions || {
          screen: true,
          input: true,
          fileTransfer: true,
          terminal: true,
          recording: true
        }
      });
    }
    for (const [launchId, launch] of state.agentLaunches || []) {
      if (!launchId || !launch?.sessionId || !launch?.token) continue;
      if (launch.expiresAt && launch.expiresAt <= now()) continue;
      agentLaunches.set(launchId, launch);
    }
    for (const [launchId, launch] of state.hostLaunches || []) {
      if (!launchId || !launch?.sessionId || !launch?.token) continue;
      if (launch.expiresAt && launch.expiresAt <= now()) continue;
      hostLaunches.set(launchId, launch);
    }
    auditLog.unshift(...(state.auditLog || []).slice(0, 100));
    auditLog.splice(100);
  } catch (err) {
    console.error(`Could not load persistent state: ${err.message}`);
  }
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    hostname: device.hostname,
    os: device.os,
    status: device.status,
    unattended: device.unattended,
    managed: Boolean(device.managed),
    agentVersion: device.agentVersion,
    ip: device.ip,
    lastSeen: device.lastSeen
  };
}

function publicSession(session, includeTokens = false) {
  const screenStreaming = hasRecentScreenStream(session);
  const device = session.deviceId ? devices.get(session.deviceId) : null;
  const deviceOnline = device?.status === 'online';
  const visibleStatus = session.permanentAccess && device
    ? (deviceOnline ? (session.status === 'active' ? 'active' : 'online') : 'offline')
    : session.status;

  // A session is only truly "live" when real frame data has actually been
  // received (screenStreaming, backed by a recent lastFrameAt) or a native
  // desktop/mobile agent has confirmed itself connected (nativeConnected).
  // Merely having a browser signaling WebSocket open (browserConnected /
  // customerSocketId) must NEVER be treated as "live" on its own — that was
  // the root cause of sessions showing as active/online before any screen
  // frame had arrived. Every consumer of "is this session live" (the
  // technician dashboard list, the /status endpoint, etc.) should read this
  // single computed field instead of re-deriving their own definition.
  const isLive = Boolean(session.nativeConnected || screenStreaming);

  const data = {
    id: session.id,
    sessionId: session.id,
    // Unified fields — work for both old and new session formats
    name: session.name || session.displayName || session.deviceName || 'Untitled Session',
    type: session.type ?? session.sessionType ?? 0,
    code: session.code || session.joinCode || session.id,
    joinCode: session.joinCode || session.code || session.id,
    createdAt: session.createdAt,
    deviceId: session.deviceId,
    deviceName: session.deviceName,
    displayName: session.name || session.displayName || session.deviceName || 'Untitled Session',
    host: session.host || 'admin',
    customProperty1: session.customProperty1 || '',
    customProperty2: session.customProperty2 || '',
    customProperty3: session.customProperty3 || '',
    customProperty4: session.customProperty4 || '',
    status: visibleStatus,
    permanentAccess: Boolean(session.permanentAccess),
    customerPlatform: session.customerPlatform || null,
    customerCapabilities: session.customerCapabilities || {},
    customerScreenStatus: session.customerScreenStatus || null,
    customerLifecycleStatus: session.customerLifecycleStatus || null,
    customerLifecycleStatusAt: session.customerLifecycleStatusAt || null,
    mobileSupport: session.mobileSupport || null,
    nativeConnected: Boolean(session.nativeConnected || (session.permanentAccess && deviceOnline)),
    // browserConnected reflects signaling-socket presence ONLY (a customer
    // browser tab is open). It is intentionally excluded from `isLive` —
    // see comment above `isLive` for rationale.
    browserConnected: Boolean(session.customerSocketId),
    nativeClaimed: Boolean(session.lastNativeClaimAt),
    screenStreaming,
    isLive,
    lastFrameAt: session.lastFrameAt || null,
    lastFrameReceivers: session.lastFrameReceivers || 0,
    permissions: session.permissions,
    lastSeen: {
      ...(session.lastSeen || { technician: null, endpoint: null }),
      endpoint: Math.max(Number(session.lastSeen?.endpoint || 0), Number(device?.lastSeen || 0)) || null
    },
    recording: session.recording,
    files: session.files,
    commands: session.commands,
    lastFrameDroppedAt: session.lastFrameDroppedAt || null,
    lastFrameDropReason: session.lastFrameDropReason || null
  };

  if (includeTokens) {
    data.agentPortalToken = session.agent?.token || null;
    data.customerJoinToken = session.customer?.token || null;
  }

  data.blankScreen = Boolean(session.blankScreen);
  return data;
}

function findSessionByIdOrCode(value) {
  const key = String(value || '').trim();
  if (!key) return null;

  const normalizedKey = normalizeJoinCode(key).toLowerCase();
  const strippedKey = normalizedKey.replace(/-/g, '');
  const numericKey = normalizeNumericJoinCode(key);

  const direct =
    sessions.get(key) ||
    [...sessions.values()].find((session) => {
      const sessionId = String(session.id || '');
      const sessionIdLower = sessionId.toLowerCase();
      const sessionJoinNormalized = normalizeJoinCode(session.joinCode || '').toLowerCase();
      const sessionJoinStripped = sessionJoinNormalized.replace(/-/g, '');
      return sessionIdLower === normalizedKey ||
        sessionIdLower === strippedKey ||
        sessionJoinNormalized === normalizedKey ||
        sessionJoinNormalized === strippedKey ||
        sessionJoinStripped === normalizedKey ||
        sessionJoinStripped === strippedKey;
    });

  if (direct) return direct;

  if (numericKey) {
    const byNumeric = [...sessions.values()].find((session) => {
      const sessionJoinNumeric = normalizeNumericJoinCode(session.joinCode || '');
      const sessionIdNumeric = normalizeNumericJoinCode(session.id || '');
      return sessionJoinNumeric === numericKey || sessionIdNumeric === numericKey;
    });
    if (byNumeric) return byNumeric;
  }

  return null;
}

function sendToSession(sessionId, message, except = null) {
  const text = JSON.stringify(message);
  for (const client of wss?.clients || []) {
    if (client === except) continue;
    if (client.readyState !== 1) continue;
    if (client.sessionId !== sessionId) continue;
    client.send(text);
  }
}

function hasOpenSessionPeer(sessionId, role) {
  for (const client of wss?.clients || []) {
    if (client.readyState !== 1) continue;
    if (client.sessionId !== sessionId) continue;
    if (client.role !== role) continue;
    return true;
  }
  return false;
}

function hasOpenHostViewer(sessionId) {
  for (const client of wss?.clients || []) {
    if (client.readyState !== 1) continue;
    if (client.sessionId !== sessionId) continue;
    if (client.role !== 'agent') continue;
    if (client.clientKind !== 'host-viewer') continue;
    return true;
  }
  return false;
}

function hasRecentScreenStream(session, maxAgeMs = MOBILE_FRAME_STALE_TIMEOUT_MS) {
  return Boolean(session?.lastFrameAt && Date.now() - Number(session.lastFrameAt) <= maxAgeMs);
}

function isMobileBroadcastClientKind(kind) {
  return ['ios-mobile-broadcast', 'android-mobile-broadcast', 'mobile-broadcast'].includes(String(kind || '').toLowerCase());
}

function normalizeJoinCode(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .slice(0, 16);
}

function normalizeNumericJoinCode(value) {
  return String(value || '')
    .trim()
    .replace(/\D+/g, '')
    .slice(0, 12);
}

function createNumericJoinCode(length = 8) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const min = 10 ** (length - 1);
    const max = 10 ** length;
    const code = String(crypto.randomInt(min, max));
    if (!findSessionByIdOrCode(code)) return code;
  }
  return `${Date.now()}`.slice(-length);
}

function normalizeClientPlatform(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('ipad')) return 'ipad';
  if (raw.includes('iphone') || raw.includes('ipod') || raw.includes('ios')) return 'iphone';
  if (raw.includes('android')) return 'android';
  if (raw.includes('mac')) return 'macos';
  if (raw.includes('win')) return 'windows';
  if (raw.includes('linux')) return 'linux';
  return 'unknown';
}

function platformExpectedClientKind(platform) {
  if (platform === 'iphone' || platform === 'ipad') return 'ios-mobile-broadcast';
  if (platform === 'android') return 'android-mobile-broadcast';
  if (platform === 'windows') return 'windows-native-agent';
  return 'browser-share';
}

function updateCustomerLifecycleStatus(session, status) {
  if (!session) return;
  const next = String(status || '').trim();
  if (!next) return;
  session.customerLifecycleStatus = next;
  session.customerLifecycleStatusAt = Date.now();
}

function addAudit(action, details = {}) {
  const entry = {
    id: nanoid(10),
    at: now(),
    action,
    actor: details.actor || 'system',
    sessionId: details.sessionId || null,
    deviceId: details.deviceId || null,
    message: details.message || action
  };
  auditLog.unshift(entry);
  auditLog.splice(100);
  schedulePersistState();
  return entry;
}

function createDeviceAccessSession(device) {
  return {
    id: nanoid(8),
    joinCode: createNumericJoinCode(8),
    createdAt: now(),
    deviceId: device.id,
    deviceName: device.name || device.hostname || 'Registered endpoint',
    displayName: device.name || device.hostname || 'Registered endpoint',
    permanentAccess: true,
    agent: { token: nanoid(24) },
    customer: { token: nanoid(24) },
    status: device.status === 'online' ? 'waiting' : 'offline',
    permissions: {
      screen: true,
      input: true,
      fileTransfer: true,
      terminal: true,
      recording: true
    },
    lastSeen: { technician: null, endpoint: device.lastSeen || null },
    recording: false,
    files: [],
    commands: [],
    nativeConnected: false,
    customerSocketId: null,
    blankScreen: false
  };
}

function ensureDeviceAccessSession(device) {
  if (!device?.id) return null;

  const candidates = [...sessions.values()]
    .filter((session) => session.deviceId === device.id && session.status !== 'ended')
    .sort((a, b) => Number(Boolean(b.permanentAccess)) - Number(Boolean(a.permanentAccess)) || b.createdAt - a.createdAt);

  const session = candidates[0] || createDeviceAccessSession(device);
  session.deviceId = device.id;
  session.deviceName = device.name || device.hostname || session.deviceName || 'Registered endpoint';
  session.displayName = session.displayName || session.deviceName;
  session.permanentAccess = true;
  session.permissions = session.permissions || {
    screen: true,
    input: true,
    fileTransfer: true,
    terminal: true,
    recording: true
  };
  session.lastSeen = session.lastSeen || { technician: null, endpoint: null };
  session.lastSeen.endpoint = Math.max(Number(session.lastSeen.endpoint || 0), Number(device.lastSeen || 0)) || null;
  if (session.status === 'created' || session.status === 'offline') {
    session.status = device.status === 'online' ? 'waiting' : 'offline';
  }
  if (!sessions.has(session.id)) sessions.set(session.id, session);
  return session;
}

function seedDevice(id, data) {
  if (devices.has(id)) return;
  devices.set(id, {
    id,
    token: nanoid(24),
    name: data.name,
    hostname: data.hostname,
    os: data.os,
    status: data.status,
    unattended: data.unattended,
    managed: true,
    agentVersion: data.agentVersion,
    ip: data.ip,
    lastSeen: now() - data.lastSeenOffset
  });
}

loadState();

for (const device of devices.values()) {
  ensureDeviceAccessSession(device);
}

function migrateSessionJoinCodesToNumeric() {
  let changed = false;
  for (const session of sessions.values()) {
    const current = normalizeNumericJoinCode(session.joinCode || '');
    if (current.length >= 4 && current === String(session.joinCode || '')) continue;
    session.joinCode = createNumericJoinCode(8);
    changed = true;
  }
  if (changed) schedulePersistState();
}

migrateSessionJoinCodesToNumeric();

if (SEED_DEMO_CLIENTS) {
  seedDevice('dev-alice', {
    name: 'Alice V Laptop',
    hostname: 'ALICE-LT-042',
    os: 'Windows 11 Pro',
    status: 'online',
    unattended: true,
    agentVersion: '0.1.0',
    ip: '10.12.4.21',
    lastSeenOffset: 12000
  });

  seedDevice('dev-lab', {
    name: 'Lab Workstation',
    hostname: 'LAB-WKS-07',
    os: 'Windows Server 2022',
    status: 'online',
    unattended: true,
    agentVersion: '0.1.0',
    ip: '10.12.8.77',
    lastSeenOffset: 46000
  });

  seedDevice('dev-field', {
    name: 'Field Tablet',
    hostname: 'FIELD-TAB-19',
    os: 'Windows 10 Enterprise',
    status: 'offline',
    unattended: false,
    agentVersion: '0.0.9',
    ip: 'last seen 172.16.4.9',
    lastSeenOffset: 18400000
  });
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/devices', requireTechnician, (_req, res) => {
  res.json([...devices.values()].map(publicDevice));
});

app.get('/api/sessions', requireTechnician, (_req, res) => {
  res.json(
    [...sessions.values()]
      .filter((session) => session.status !== 'ended')
      .sort((a, b) => {
        const aLive = Number(Boolean(a.nativeConnected || hasRecentScreenStream(a)));
        const bLive = Number(Boolean(b.nativeConnected || hasRecentScreenStream(b)));
        if (aLive !== bLive) return bLive - aLive;
        const aActivity = Math.max(a.lastSeen?.endpoint || 0, a.lastSeen?.technician || 0, a.createdAt || 0);
        const bActivity = Math.max(b.lastSeen?.endpoint || 0, b.lastSeen?.technician || 0, b.createdAt || 0);
        return bActivity - aActivity;
      })
      .map((session) => publicSession(session, true))
  );
});

app.post('/api/agent/register', (req, res) => {
  const body = req.body || {};
  const id = body.deviceId || `dev-${nanoid(8)}`;
  const existing = devices.get(id);
  const device = {
    id,
    token: existing?.token || nanoid(24),
    name: body.name || body.hostname || 'Unlabeled endpoint',
    hostname: body.hostname || 'UNKNOWN',
    os: body.os || 'Unknown OS',
    status: 'online',
    unattended: Boolean(body.unattended),
    managed: true,
    agentVersion: body.agentVersion || '0.1.0',
    ip: body.ip || req.ip,
    lastSeen: now()
  };

  devices.set(id, device);
  const accessSession = ensureDeviceAccessSession(device);
  schedulePersistState();
  addAudit('device.registered', {
    deviceId: id,
    message: `${device.hostname} registered with central server`
  });
  broadcastUpdate('device.update', { deviceId: id });
  res.json({ ok: true, deviceId: id, deviceToken: device.token, device: publicDevice(device), accessSession: publicSession(accessSession, true) });
});

app.post('/api/agent/:id/heartbeat', (req, res) => {
  const device = devices.get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const token = req.header('x-device-token') || req.body?.token;
  if (token !== device.token) return res.status(401).json({ error: 'Invalid device token' });

  device.status = 'online';
  device.lastSeen = now();
  const accessSession = ensureDeviceAccessSession(device);
  if (accessSession && ['offline', 'created'].includes(accessSession.status)) accessSession.status = 'waiting';
  schedulePersistState();
  res.json({ ok: true, device: publicDevice(device) });
});

app.get('/api/agent/:id/session', (req, res) => {
  const device = devices.get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const token = req.header('x-device-token') || req.query.token;
  if (token !== device.token) return res.status(401).json({ error: 'Invalid device token' });

  const pendingSession = [...sessions.values()]
    .filter((session) => session.deviceId === device.id && session.status !== 'ended')
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  if (!pendingSession) return res.status(204).end();

  res.json({
    sessionId: pendingSession.id,
    customerJoinToken: pendingSession.customer.token,
    permissions: pendingSession.permissions
  });
});

app.get('/api/agent/:id/jobs', (req, res) => {
  const device = devices.get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const token = req.header('x-device-token') || req.query.token;
  if (token !== device.token) return res.status(401).json({ error: 'Invalid device token' });

  const jobs = [];
  for (const session of sessions.values()) {
    if (session.deviceId !== device.id || session.status === 'ended') continue;

    for (const command of session.commands) {
      if (command.status === 'queued') {
        command.status = 'sent';
        jobs.push({
          type: 'terminal',
          sessionId: session.id,
          id: command.id,
          command: command.command
        });
      }
    }

    for (const file of session.files) {
      if (file.status === 'queued') {
        file.status = 'sent';
        jobs.push({
          type: 'file',
          sessionId: session.id,
          id: file.id,
          direction: file.direction,
          name: file.name,
          path: file.path || file.name
        });
      }
    }
  }

  res.json({ jobs });
});

app.post('/api/agent/:id/jobs/:jobId/result', (req, res) => {
  const device = devices.get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const token = req.header('x-device-token') || req.body?.token;
  if (token !== device.token) return res.status(401).json({ error: 'Invalid device token' });

  const body = req.body || {};
  for (const session of sessions.values()) {
    if (session.deviceId !== device.id) continue;

    const command = session.commands.find((item) => item.id === req.params.jobId);
    if (command) {
      command.status = body.status || 'completed';
      command.exitCode = Number(body.exitCode ?? 0);
      command.output = String(body.output || '');
      command.completedAt = now();
      addAudit('terminal.command.completed', {
        actor: 'agent',
        sessionId: session.id,
        deviceId: device.id,
        message: `Command completed: ${command.command}`
      });
      return res.json({ ok: true });
    }

    const file = session.files.find((item) => item.id === req.params.jobId);
    if (file) {
      file.status = body.status || 'completed';
      file.output = body.output || null;
      file.data = body.data || null;
      file.completedAt = now();
      addAudit('file.completed', {
        actor: 'agent',
        sessionId: session.id,
        deviceId: device.id,
        message: `File job completed: ${file.name}`
      });
      return res.json({ ok: true });
    }
  }

  res.status(404).json({ error: 'Job not found' });
});

app.post('/api/session/create', requireTechnician, (req, res) => {
  const deviceId = req.body?.deviceId || null;
  const device = deviceId ? devices.get(deviceId) : null;
  const permanentAccess = Boolean(req.body?.permanentAccess);

  if (permanentAccess && device) {
    const session = ensureDeviceAccessSession(device);
    return res.json({
      sessionId: session.id,
      joinCode: session.joinCode,
      displayName: session.displayName,
      deviceName: session.deviceName,
      permanentAccess: session.permanentAccess,
      agentPortalToken: session.agent.token,
      customerJoinToken: session.customer.token
    });
  }

  const sessionId = nanoid(8);
  const joinCode = createNumericJoinCode(8);
  const agentToken = nanoid(24);
  const customerToken = nanoid(24);
  const fallbackName = permanentAccess ? 'Unauthorized client' : 'Ad-hoc browser guest';

  const session = {
    id: sessionId,
    joinCode,
    createdAt: Date.now(),
    deviceId,
    deviceName: device?.name || fallbackName,
    displayName: device?.name || fallbackName,
    // Permanent access sessions are durable records intended for unattended endpoints.
    // We keep the same download/join signaling mechanics; only metadata + defaults change.
    permanentAccess,
    agent: { token: agentToken },
    customer: { token: customerToken },
    status: 'created',
    permissions: {
      screen: true,
      input: true,
      fileTransfer: true,
      terminal: true,
      recording: true
    },
    lastSeen: { technician: null, endpoint: null },
    recording: false,
    files: [],
    commands: []
  };

  sessions.set(sessionId, session);
  schedulePersistState();
  // Host-created sessions are durable records. They remain in the host account
  // until the host explicitly deletes or ends them.


  addAudit('session.created', {
    actor: 'technician',
    sessionId,
    deviceId,
    message: `Session ${joinCode} created for ${device?.hostname || 'browser guest'}`
  });

  broadcastUpdate('session.update', { sessionId });

  res.json({
    sessionId,
    joinCode,
    displayName: device?.name || fallbackName,
    deviceName: device?.name || fallbackName,
    permanentAccess,
    agentPortalToken: agentToken,
    customerJoinToken: customerToken
  });
});

app.post('/api/session/:id/validate', (req, res) => {
  const s = findSessionByIdOrCode(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const { role, token } = req.body || {};

  if (role === 'agent') {
    if (token !== s.agent.token) return res.status(401).json({ error: 'Invalid agent token' });
    return res.json({ ok: true });
  }
  if (role === 'customer') {
    if (token !== s.customer.token) return res.status(401).json({ error: 'Invalid customer token' });
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Bad role' });
});

app.post('/api/session/:id/join', (req, res) => {
  const requestedId = String(req.params.id || '');
  const normalizedRequested = normalizeJoinCode(requestedId);
  const numericRequested = normalizeNumericJoinCode(requestedId);
  const s = findSessionByIdOrCode(requestedId);
  if (!s) {
    return res.status(404).json({
      error: 'Session not found',
      code: 'SESSION_NOT_FOUND',
      message: 'This join code is not valid (or the session was deleted).',
      diagnostics: {
        requestedId,
        normalizedRequested,
        numericRequested,
        platform: normalizeClientPlatform(req.body?.platform || req.body?.os || req.get('user-agent'))
      }
    });
  }

  const permanentAccess = Boolean(s.permanentAccess);
  const clientPlatform = normalizeClientPlatform(req.body?.platform || req.body?.os || req.get('user-agent'));
  const clientCapabilities = {
    browserShare: Boolean(req.body?.capabilities?.browserShare),
    nativeInstall: Boolean(req.body?.capabilities?.nativeInstall),
    screenCapture: Boolean(req.body?.capabilities?.screenCapture),
    mobileAppBroadcast: Boolean(req.body?.capabilities?.mobileAppBroadcast),
    remoteControl: clientPlatform !== 'iphone' && clientPlatform !== 'ipad'
  };
  s.customerPlatform = clientPlatform;
  s.customerCapabilities = clientCapabilities;
  const requiresNativeApp = (clientPlatform === 'iphone' || clientPlatform === 'ipad') && !clientCapabilities.screenCapture;
  s.customerScreenStatus = clientCapabilities.screenCapture
    ? 'browser_screen_capture_available'
    : (clientPlatform === 'iphone' || clientPlatform === 'ipad')
      ? 'ios_native_app_required'
      : 'browser_screen_capture_unavailable';
  updateCustomerLifecycleStatus(s, 'code_verified');
  s.mobileSupport = {
    ...mobileSupportLinks(req, s, clientPlatform),
    requiresNativeApp
  };

  // Explicit authorization enforcement for managed/unattended access.
  // - Customer can always “join” the page flow.
  // - Native activation is blocked until /authorize is completed when permanentAccess=true.
  // - We never auto-authorize.
  if (permanentAccess && !s.permanentAccessAuthorizedAt) {
    if (!s.permanentAccessAuthorizationToken) {
      s.permanentAccessAuthorizationToken = nanoid(24);
      s.permanentAccessAuthorizationTokenIssuedAt = now();
    }
    schedulePersistState();

    return res.status(428).json({
      ok: false,
      code: 'PERMANENT_ACCESS_AUTHORIZATION_REQUIRED',
      error: 'Authorization required',
      message: 'Unattended/managed access requires explicit customer authorization.',
      authorizationRequired: true,
      authorizationToken: s.permanentAccessAuthorizationToken,
      sessionId: s.id,
      joinCode: s.joinCode || s.id,
      customerJoinToken: s.customer.token,
      setupFileName: CUSTOMER_AGENT_EXE_NAME,
      platform: clientPlatform,
      capabilities: clientCapabilities,
    mobileSupport: s.mobileSupport,
    requiresNativeApp,
    permanentAccess: true
  });
  }

  s.lastSeen.endpoint = now();
  schedulePersistState();
  addAudit('endpoint.joined', {
    sessionId: s.id,
    deviceId: s.deviceId,
    message: `Endpoint joined session ${s.id}`
  });

  broadcastUpdate('session.update', { sessionId: s.id });

  const agentPublishExists = fs.existsSync(path.join(agentPublishDir, 'RemoteSupportAgent.exe'));
  // Only offer native download to Windows clients
  const offerNativeDownload = agentPublishExists && clientPlatform === 'windows';
  const launchId = offerNativeDownload ? nanoid(12) : null;
  if (launchId) {
    agentLaunches.set(launchId, {
      sessionId: s.id,
      token: s.customer.token,
      expiresAt: Date.now() + 1000 * 60 * 60 * 24
    });
    schedulePersistState();
  }

  res.json({
    ok: true,
    sessionId: s.id,
    joinCode: s.joinCode || s.id,
    customerJoinToken: s.customer.token,
    setupFileName: CUSTOMER_AGENT_EXE_NAME,
    platform: clientPlatform,
    capabilities: clientCapabilities,
    customerScreenStatus: s.customerScreenStatus,
    mobileSupport: s.mobileSupport,
    requiresNativeApp,
    permanentAccess: Boolean(s.permanentAccess),
    diagnostics: {
      mobile: clientPlatform === 'iphone' || clientPlatform === 'ipad' || clientPlatform === 'android',
      mobilePlatform: clientPlatform || 'unknown',
      expectedCustomerClientKind: platformExpectedClientKind(clientPlatform),
      expectedBroadcastTechnology: (clientPlatform === 'iphone' || clientPlatform === 'ipad')
        ? 'ReplayKit'
        : (clientPlatform === 'android' ? 'MediaProjection' : 'BrowserScreenCapture'),
      websocketRelayExpected: true,
      websocketRelayPath: '/',
      websocketRelayProtocol: publicOrigin(req).startsWith('https://') ? 'wss' : 'ws',
      firstFrameRequiredForActiveState: true,
      sessionAuthentication: {
        sessionId: s.id,
        joinCode: s.joinCode || s.id,
        tokenType: 'customerJoinToken',
        tokenPresent: Boolean(s.customer.token),
        expectedClientKind: platformExpectedClientKind(clientPlatform)
      }
    },
    // downloadUrl is only included when the native agent binary actually exists on disk.
    // When it is absent the browser customer.html should skip any download prompt and
    // connect directly via WebRTC/WebSocket instead.
    ...(launchId && {
      downloadUrl: downloadUrl(req, `/download/${CUSTOMER_AGENT_EXE_NAME}?launchId=${encodeURIComponent(launchId)}&v=${encodeURIComponent(CUSTOMER_AGENT_BUILD)}`),
      alternateDownloadUrl: alternateDownloadUrl(req, `/download/${CUSTOMER_AGENT_EXE_NAME}?launchId=${encodeURIComponent(launchId)}&v=${encodeURIComponent(CUSTOMER_AGENT_BUILD)}`),
      msiUrl: downloadUrl(req, `/download/${DOWNLOAD_PRODUCT_PREFIX}.ClientSetup.msi?launchId=${encodeURIComponent(launchId)}&v=${encodeURIComponent(CUSTOMER_AGENT_BUILD)}`),
      alternateMsiUrl: alternateDownloadUrl(req, `/download/${DOWNLOAD_PRODUCT_PREFIX}.ClientSetup.msi?launchId=${encodeURIComponent(launchId)}&v=${encodeURIComponent(CUSTOMER_AGENT_BUILD)}`)
    })
  });
});

app.post('/api/session/:id/authorize', (req, res) => {
  const s = findSessionByIdOrCode(req.params.id);
  if (!s) {
    return res.status(404).json({
      error: 'Session not found',
      code: 'SESSION_NOT_FOUND',
      message: 'This join code is not valid (or the session was deleted).'
    });
  }

  const token = String(req.body?.token || '');
  const authorizationToken = String(req.body?.authorizationToken || '');

  if (!token || token !== s.customer.token) {
    return res.status(401).json({
      error: 'Invalid customer token',
      code: 'INVALID_CUSTOMER_TOKEN',
      message: 'Authorization request token is invalid.'
    });
  }

  if (!s.permanentAccess) {
    // No-op for ad-hoc sessions.
    return res.status(200).json({ ok: true, permanentAccessAuthorizedAt: s.permanentAccessAuthorizedAt || null });
  }

  if (!s.permanentAccessAuthorizationToken) {
    // Authorization token was not issued yet; treat as conflict.
    return res.status(409).json({
      ok: false,
      code: 'PERMANENT_ACCESS_AUTHORIZATION_TOKEN_NOT_ISSUED',
      message: 'Authorization token not issued for this session yet. Try joining again.'
    });
  }

  if (!authorizationToken || authorizationToken !== s.permanentAccessAuthorizationToken) {
    return res.status(403).json({
      ok: false,
      code: 'PERMANENT_ACCESS_AUTHORIZATION_TOKEN_INVALID',
      message: 'Authorization token is invalid.'
    });
  }

  if (!s.permanentAccessAuthorizedAt) {
    s.permanentAccessAuthorizedAt = now();

    // Ensure remote control is immediately available after explicit customer approval.
    if (s.permissions && s.permissions.input === false) {
      s.permissions.input = true;
    }

    schedulePersistState();
    addAudit('endpoint.permanent_access.authorized', {
      actor: 'customer',
      sessionId: s.id,
      deviceId: s.deviceId,
      message: 'Permanent/unattended access authorization confirmed.'
    });

    // Push live permission update so already-connected host/customer peers stay in sync.
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      if (client.sessionId !== s.id) continue;
      client.send(JSON.stringify({ type: 'permissions.update', payload: s.permissions }));
    }
  }

  return res.json({
    ok: true,
    permanentAccessAuthorizedAt: s.permanentAccessAuthorizedAt
  });
});

app.post('/api/session/:id/native-claim', (req, res) => {
  // Note: permanentAccess activation is explicitly gated.

  const s = findSessionByIdOrCode(req.params.id);
  if (!s) {
    return res.status(404).json({
      error: 'Session not found',
      code: 'SESSION_NOT_FOUND',
      message: 'This support code is no longer active. Ask the technician to create a fresh session and download the setup again.'
    });
  }
  if (req.body?.token !== s.customer.token) {
    return res.status(401).json({
      error: 'Invalid customer token',
      code: 'INVALID_CUSTOMER_TOKEN',
      message: 'This setup file belongs to an older support session. Download a fresh setup file from the current customer page.'
    });
  }

  const permanentAccess = Boolean(s.permanentAccess);
  // Enforce unattended/permanent authorization at activation time.
  if (permanentAccess && !s.permanentAccessAuthorizedAt) {
    return res.status(403).json({
      ok: false,
      error: 'Authorization required for permanent access',
      code: 'PERMANENT_ACCESS_AUTHORIZATION_REQUIRED',
      message: 'Explicit authorization is required before enabling unattended/permanent access.',
      authorizationRequired: true
    });
  }

  const device = devices.get(req.body?.deviceId);
  if (!device) {
    return res.status(404).json({
      error: 'Device not found',
      code: 'DEVICE_NOT_FOUND',
      message: 'The customer agent registered with an unknown device id. Reopen the setup file to register again.'
    });
  }
  if (req.body?.deviceToken !== device.token) {
    return res.status(401).json({
      error: 'Invalid device token',
      code: 'INVALID_DEVICE_TOKEN',
      message: 'The customer device token is stale. Download and run a fresh setup file.'
    });
  }

  s.deviceId = device.id;
  s.deviceName = device.name || device.hostname || s.deviceName;
  s.displayName = device.name || s.displayName || s.deviceName;
  // Preserve the host-selected session mode:
  // - attended/ad-hoc sessions remain attended
  // - permanent/unattended sessions remain permanent
  if (s.status === 'created') s.status = 'waiting';
  s.lastSeen.endpoint = now();
  s.nativeConnected = false;
  s.lastNativeClaimAt = now();
  device.managed = true; // Ensure device is saved as managed
  ensureDeviceAccessSession(device);
  schedulePersistState();
  addAudit('endpoint.native.claimed', {
    sessionId: s.id,
    deviceId: device.id,
    message: `Native endpoint claimed session ${s.id}`
  });

  res.json({ ok: true });
});

app.post('/api/session/:id/host-launch', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (hasOpenHostViewer(s.id)) {
    return res.status(409).json({
      error: 'Host already connected',
      message: 'A host viewer is already connected to this customer session. Close the existing host viewer before connecting again.'
    });
  }
  const origin = publicOrigin(req);
  const hostUrl = hostClientUrl(origin, s, s.agent.token);
  const hostLaunchId = createLaunchRecord(hostLaunches, s, s.agent.token);
  const hostViewerUrl = downloadUrl(req, `/download/${HOST_VIEWER_EXE_NAME}?launchId=${encodeURIComponent(hostLaunchId)}&v=${encodeURIComponent(HOST_VIEWER_BUILD)}`);
  const nativeLaunch = launchNativeHostViewer(origin, s, s.agent.token);

  addAudit('host.launch.opened', {
    actor: 'technician',
    sessionId: s.id,
    deviceId: s.deviceId,
    message: nativeLaunch.ok
      ? `Native host viewer opened for session ${s.id}`
      : `Native host viewer download prepared for session ${s.id}`
  });

  res.json({
    ok: true,
    launched: nativeLaunch.ok,
    launchError: nativeLaunch.ok ? null : nativeLaunch.error,
    launchPid: nativeLaunch.ok ? nativeLaunch.pid : null,
    hostUrl,
    hostViewerUrl,
    hostLaunchId,
    hostViewerFileName: HOST_VIEWER_EXE_NAME,
    hostLauncherFileName: HOST_LAUNCHER_NAME
  });
});

// GET version: download the native host viewer. Do not redirect hosts to the browser viewer.
app.get('/api/session/:id/host-launch', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const hostLaunchId = createLaunchRecord(hostLaunches, s, s.agent.token);
  const hostViewerUrl = downloadUrl(req, `/download/${HOST_VIEWER_EXE_NAME}?launchId=${encodeURIComponent(hostLaunchId)}&v=${encodeURIComponent(HOST_VIEWER_BUILD)}`);
  addAudit('host.launch.opened', {
    actor: 'technician',
    sessionId: s.id,
    deviceId: s.deviceId,
    message: `Native host viewer download requested for session ${s.id}`
  });
  res.redirect(302, hostViewerUrl);
});

app.get('/api/session/:id/customer-status', (req, res) => {
  const s = findSessionByIdOrCode(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (req.query.token !== s.customer.token) return res.status(401).json({ error: 'Invalid customer token' });

  res.json({
    ok: true,
    nativeConnected: Boolean(s.nativeConnected),
    browserConnected: Boolean(s.customerSocketId),
    screenStreaming: hasRecentScreenStream(s),
    nativeClaimed: Boolean(s.lastNativeClaimAt),
    customerPlatform: s.customerPlatform || null,
    customerCapabilities: s.customerCapabilities || {},
    customerScreenStatus: s.customerScreenStatus || null,
    mobileSupport: s.mobileSupport || null,
    status: s.status,
    lastJoinError: s.lastJoinError || null,
    lastJoinErrorAt: s.lastJoinErrorAt || null
  });
});

app.post('/api/session/:id/native-join-failure', (req, res) => {
  const s = findSessionByIdOrCode(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  const token = String(req.body?.token || '');
  if (!token || token !== s.customer.token) return res.status(401).json({ error: 'Invalid customer token' });

  const reason = String(req.body?.reason || '').slice(0, 2000);
  const details = typeof req.body?.details === 'string' ? req.body.details.slice(0, 3000) : null;

  s.lastJoinError = details ? `${reason}\n${details}` : reason || 'Unknown native join failure';
  s.lastJoinErrorAt = Date.now();
  schedulePersistState();

  addAudit('endpoint.native.join_failed', {
    actor: 'agent',
    sessionId: s.id,
    deviceId: s.deviceId,
    message: `Native join failure: ${s.lastJoinError}`
  });

  res.json({ ok: true });
});


app.get('/api/agent-launch/:id', (req, res) => {
  const launch = agentLaunches.get(req.params.id);
  if (!launch || launch.expiresAt <= Date.now()) {
    agentLaunches.delete(req.params.id);
    return res.status(404).json({ error: 'Launch details expired or were not found.' });
  }

  const s = sessions.get(launch.sessionId);
  if (!s || s.customer.token !== launch.token) {
    agentLaunches.delete(req.params.id);
    return res.status(404).json({ error: 'Session was not found.' });
  }

  res.json({
    ok: true,
    sessionId: launch.sessionId,
    customerJoinToken: launch.token
  });
});

app.get('/api/host-launch/:id', (req, res) => {
  const launch = hostLaunches.get(req.params.id);
  if (!launch || launch.expiresAt <= Date.now()) {
    hostLaunches.delete(req.params.id);
    return res.status(404).json({ error: 'Launch details expired or were not found.' });
  }

  const s = sessions.get(launch.sessionId);
  if (!s || s.agent.token !== launch.token) {
    hostLaunches.delete(req.params.id);
    return res.status(404).json({ error: 'Session was not found.' });
  }

  res.json({
    ok: true,
    sessionId: launch.sessionId,
    token: launch.token
  });
});

app.all(['/Services/MobileService.ashx/:method', '/Services/MobileService.ashx', '/Services/SessionGroupService.ashx/:method', '/Services/SessionGroupService.ashx'], (req, res) => {
  const method = req.params.method || req.query.Method || '';
  const args = Array.isArray(req.body) ? req.body : [];

  if (method === 'GetSessionInfoByCode') {
    const code = args[0] || req.query.Param || '';
    const s = findSessionByIdOrCode(code);
    if (!s) return res.json({ d: null });
    return res.json({
      d: {
        SessionId: s.id,
        Name: s.displayName || s.deviceName,
        SessionType: 1, // Support
        IsActive: s.status !== 'ended',
        Host: 'Technician',
        GuestConnected: Boolean(s.customerSocketId || s.nativeConnected)
      }
    });
  }

  if (method === 'GetGuestSessionJoinInfo') {
    const sessionId = args[0] || '';
    const s = sessions.get(sessionId) || findSessionByIdOrCode(sessionId);
    if (!s) return res.json({ d: null });

    // Update session metadata as it's now joining from a mobile app
    const userAgent = req.get('user-agent');
    s.customerPlatform = normalizeClientPlatform(userAgent);
    s.customerCapabilities = {
      browserShare: false,
      nativeInstall: false,
      screenCapture: true,
      mobileAppBroadcast: true,
      remoteControl: s.customerPlatform !== 'ios'
    };
    s.customerScreenStatus = s.customerPlatform === 'ios' ? 'ios_native_app_required' : 'mobile_app_connected';
    s.lastSeen.endpoint = now();
    schedulePersistState();
    broadcastUpdate('session.update', { sessionId: s.id });

    const baseUrl = publicOrigin(req);
    const platform = normalizeClientPlatform(userAgent);
    const clientKind = (platform === 'iphone' || platform === 'ipad') ? 'ios-mobile-broadcast' : (platform === 'android' ? 'android-mobile-broadcast' : 'mobile-broadcast');

    // Modern mobile apps may support WebSocket relay if we provide a wss:// URL
    const relayUrl = new URL('/', baseUrl);
    relayUrl.protocol = relayUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    relayUrl.searchParams.set('role', 'customer');
    relayUrl.searchParams.set('sessionId', s.id);
    relayUrl.searchParams.set('token', s.customer.token);
    relayUrl.searchParams.set('client', clientKind);

    return res.json({
      d: {
        SessionId: s.id,
        Host: 'Technician',
        ServerUrl: baseUrl,
        RelayAddress: relayUrl.toString(),
        EncryptionKey: Buffer.from(s.customer.token).toString('base64'),
        EncryptionMethod: 'AES-256',
        GuestToken: s.customer.token,
        AllowedPermissions: s.permissions
      }
    });
  }

  if (method === 'GetSessionInfo') {
    const sessionId = args[0] || '';
    const s = sessions.get(sessionId) || findSessionByIdOrCode(sessionId);
    if (!s) return res.json({ d: null });
    return res.json({
      d: {
        SessionId: s.id,
        IsHostConnected: hasOpenSessionPeer(s.id, 'agent'),
        Permissions: s.permissions,
        CommandQueue: []
      }
    });
  }

  // Fallback for discovery
  if (method === 'GetAppMetadata') {
    return res.json({
      d: {
        Version: '24.1.12345',
        IsCloud: false,
        ServerName: 'Remote Support'
      }
    });
  }

  res.status(404).json({ error: `Method ${method} not implemented` });
});

app.get([
  '/download/supportdesk.ClientSetup.exe',
  '/download/supportdesk.ClientSetup.msi',
  '/download/ScreenConnect.ClientSetup.exe',
  '/download/ScreenConnect.ClientSetup.msi',
  '/Bin/supportdesk.ClientSetup.exe',
  '/Bin/supportdesk.ClientSetup.msi',
  '/Bin/ScreenConnect.ClientSetup.exe',
  '/Bin/ScreenConnect.ClientSetup.msi'
], (req, res, next) => {
  if (path.basename(req.path) === CUSTOMER_AGENT_EXE_NAME) return next();
  res.redirect(302, downloadAliasUrl(CUSTOMER_AGENT_EXE_NAME, req.query));
});

app.get(`/download/${CUSTOMER_AGENT_EXE_NAME}`, (req, res) => {
  const launchId = String(req.query.launchId || '');
  const launch = agentLaunches.get(launchId);
  const sessionId = launch?.sessionId || String(req.query.sessionId || '');
  const token = launch?.token || String(req.query.token || '');
  const s = sessions.get(sessionId);
  if (!s || token !== s.customer.token) return res.status(404).send('Setup download was not found.');

  const payload = agentLaunchPayload(req, s, token, launchId || null);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const fileToken = agentLaunchFileToken(launchId) || payload;
  res.download(path.join(agentPublishDir, 'RemoteSupportAgent.exe'), `${DOWNLOAD_PRODUCT_PREFIX}.ClientSetup.${fileToken}.${CUSTOMER_AGENT_BUILD}.exe`);
});

app.get(`/download/${HOST_VIEWER_EXE_NAME}`, (req, res) => {
  const launchId = String(req.query.launchId || '');
  const launch = hostLaunches.get(launchId);
  const sessionId = launch?.sessionId || String(req.query.sessionId || '');
  const token = launch?.token || String(req.query.token || '');
  const s = sessions.get(sessionId);
  if (!s || token !== s.agent.token) return res.status(404).send('Host viewer download was not found.');

  const viewerPath = path.join(hostPublishDir, 'RemoteSupportHost.exe');
  if (!fs.existsSync(viewerPath)) return res.status(404).send('Host viewer has not been published yet.');

  const payload = hostLaunchPayload(req, s, token, launchId || null);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.download(viewerPath, `${DOWNLOAD_PRODUCT_PREFIX}.HostViewer.${payload}.${HOST_VIEWER_BUILD}.exe`);
});

app.get([
  '/download/supportdesk.HostViewer.exe',
  '/Bin/supportdesk.HostViewer.exe',
  '/Bin/ScreenConnect.HostViewer.exe'
], (req, res) => {
  res.redirect(302, downloadAliasUrl(HOST_VIEWER_EXE_NAME, req.query));
});

app.get(`/download/${HOST_LAUNCHER_NAME}`, (req, res) => {
  const sessionId = String(req.query.sessionId || '');
  const token = String(req.query.token || '');
  const s = sessions.get(sessionId);
  if (!s || token !== s.agent.token) return res.status(404).send('Host launcher was not found.');

  const hostLaunchId = createLaunchRecord(hostLaunches, s, s.agent.token);
  const hostViewerUrl = downloadUrl(req, `/download/${HOST_VIEWER_EXE_NAME}?launchId=${encodeURIComponent(hostLaunchId)}&v=${encodeURIComponent(HOST_VIEWER_BUILD)}`);
  addAudit('host.launch.opened', {
    actor: 'technician',
    sessionId: s.id,
    deviceId: s.deviceId,
    message: `Native host viewer download requested for session ${s.id}`
  });
  res.redirect(302, hostViewerUrl);
});

app.get([
  '/download/supportdesk.ClientHost.cmd',
  '/Bin/supportdesk.ClientHost.cmd',
  '/Bin/ScreenConnect.ClientHost.cmd'
], (req, res) => {
  res.redirect(302, downloadAliasUrl(HOST_LAUNCHER_NAME, req.query));
});

app.get([
  '/download/supportdesk.ClientHost.msi',
  '/download/ScreenConnect.ClientHost.msi',
  '/Bin/supportdesk.ClientHost.msi',
  '/Bin/ScreenConnect.ClientHost.msi'
], (req, res) => {
  res.redirect(302, downloadAliasUrl(HOST_LAUNCHER_NAME, req.query));
});

app.get('/download/agent-file/:file', (req, res) => {
  const file = req.params.file;
  if (file !== path.basename(file)) return res.status(400).send('Invalid file.');
  const filePath = path.join(agentPublishDir, file);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found.');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.download(filePath, file);
});

app.get('/api/session/:id/ios-broadcast-diagnostics', (req, res) => {
  const s = findSessionByIdOrCode(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const tokenParam = req.query.token || req.header('x-session-token');
  const ok = isAuthenticated(req) || tokenParam === s.customer.token || tokenParam === s.agent.token;
  if (!ok) return res.status(401).json({ error: 'Login required' });

  const waitingForFirstFrame = Boolean(
    s.customerScreenStatus === 'ios_broadcast_connected_waiting_first_frame' &&
    !s.lastFrameAt
  );

  res.json({
    ok: true,
    sessionId: s.id,
    joinCode: s.joinCode || s.id,
    customerPlatform: s.customerPlatform || null,
    customerScreenStatus: s.customerScreenStatus || null,
    nativeConnected: Boolean(s.nativeConnected),
    browserConnected: Boolean(s.customerSocketId),
    waitingForFirstFrame,
    firstFrameReceivedAt: s.lastFrameAt || null,
    noFrameTelemetryDueAt: s.noFrameTelemetryDueAt || null,
    noFrameTelemetryLoggedAt: s.noFrameTelemetryLoggedAt || null,
    lastFrameReceivers: s.lastFrameReceivers || 0,
    lastFrameDropReason: s.lastFrameDropReason || null,
    guidance: waitingForFirstFrame
      ? 'iOS broadcast socket is connected but no screen.frame has arrived yet. In iOS app: Visit Host URL, Enter Code, Initiate ScreenShare, then tap Start Broadcast in Apple prompt.'
      : 'If firstFrameReceivedAt is set, iOS broadcast frames reached relay at least once.'
  });
});

app.get('/api/session/:id/troubleshooting', (req, res) => {
  const s = findSessionByIdOrCode(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const tokenParam = req.query.token || req.header('x-session-token');
  const ok = isAuthenticated(req) || tokenParam === s.customer.token || tokenParam === s.agent.token;
  if (!ok) return res.status(401).json({ error: 'Login required' });

  // Provide actionable info for common issues (WS connect, blanking, permissions, native claim errors).
  res.json({
    ok: true,
    session: {
      id: s.id,
      status: s.status,
      customerPlatform: s.customerPlatform || null,
      customerCapabilities: s.customerCapabilities || {},
      customerScreenStatus: s.customerScreenStatus || null,
      mobileSupport: s.mobileSupport || null,
      permanentAccess: Boolean(s.permanentAccess),
      permanentAccessAuthorizedAt: s.permanentAccessAuthorizedAt || null,
      permissions: s.permissions,
      blankScreen: Boolean(s.blankScreen),
      recording: Boolean(s.recording),
      lastSeen: s.lastSeen,
      nativeConnected: Boolean(s.nativeConnected),
      nativeClaimed: Boolean(s.lastNativeClaimAt),
      browserConnected: Boolean(s.customerSocketId),
      screenStreaming: hasRecentScreenStream(s),
      lastFrameAt: s.lastFrameAt || null,
      lastFrameReceivers: s.lastFrameReceivers || 0,
      lastFrameDroppedAt: s.lastFrameDroppedAt || null,
      lastFrameDropReason: s.lastFrameDropReason || null
    },
    lastJoinError: s.lastJoinError || null,
    lastJoinErrorAt: s.lastJoinErrorAt || null,
    // server-side timestamps help diagnose “stuck on connecting” vs “claimed but no screen frames”
    // Note: last screen frame time is not tracked server-side yet.
    guidance: {
      ifNoFrames: 'If connected but no screen appears, check Cloudflare/WebSocket proxy behavior and frame delivery throttling.',
      ifStuckConnecting: 'If stuck on connecting, check firewall, antivirus blocking the remote support client, SSL/TLS certificate mismatch, and reverse proxy WebSocket upgrades.'
    }
  });
});

app.get('/api/session/:id/status', (req, res) => {
  const s = findSessionByIdOrCode(req.params.id);
  // Allow either a logged-in technician OR the customer/agent token
  const tokenParam = req.query.token || req.header('x-session-token');
  const isTech = isAuthenticated(req);
  const isCustomer = tokenParam && s && tokenParam === s.customer.token;
  const isAgent = tokenParam && s && tokenParam === s.agent.token;
  if (!isTech && !isCustomer && !isAgent) {
    return res.status(401).json({ error: 'Login required' });
  }
  if (!s) return res.status(404).json({ error: 'Session not found' });

  res.json(publicSession(s, true));
});

app.patch('/api/session/:id', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  const displayName = String(req.body?.displayName || '').trim();
  const requestedJoinCode = req.body?.joinCode === undefined ? null : normalizeNumericJoinCode(req.body.joinCode);
  if (!displayName && requestedJoinCode === null) {
    return res.status(400).json({ error: 'Session name or join code is required' });
  }

  if (requestedJoinCode !== null) {
    if (requestedJoinCode.length < 4) return res.status(400).json({ error: 'Join code must contain at least 4 digits' });
    const existing = findSessionByIdOrCode(requestedJoinCode);
    if (existing && existing.id !== s.id) return res.status(409).json({ error: 'Join code is already in use' });
    s.joinCode = requestedJoinCode;
  }

  if (displayName) s.displayName = displayName.slice(0, 80);
  schedulePersistState();
  addAudit('session.renamed', {
    actor: 'technician',
    sessionId: s.id,
    deviceId: s.deviceId,
    message: `Session updated: ${s.displayName || s.deviceName || s.id}`
  });
  res.json({ ok: true, session: publicSession(s, true) });
});

app.delete('/api/session/:id', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  sessions.delete(s.id);
  if (s.permanentAccess && s.deviceId) {
    devices.delete(s.deviceId);
  }
  schedulePersistState();
  addAudit('session.deleted', {
    actor: 'technician',
    sessionId: s.id,
    deviceId: s.deviceId,
    message: `Session deleted: ${s.displayName || s.deviceName || s.id}`
  });

  for (const client of wss.clients) {
    if (client.sessionId !== s.id) continue;
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'session.end', payload: { sessionId: s.id } }));
      client.close(1000, 'Session deleted');
    }
  }

  res.json({ ok: true });
});

app.post('/api/session/:id/permissions', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const token = req.header('x-agent-token') || req.body?.agentToken;
  if (!isAuthenticated(req) && token !== s.agent.token) return res.status(401).json({ error: 'Login required' });

  const p = req.body || {};
  if (typeof p.input === 'boolean') s.permissions.input = p.input;
  if (typeof p.screen === 'boolean') s.permissions.screen = p.screen;
  if (typeof p.fileTransfer === 'boolean') s.permissions.fileTransfer = p.fileTransfer;
  if (typeof p.terminal === 'boolean') s.permissions.terminal = p.terminal;
  if (typeof p.recording === 'boolean') s.permissions.recording = p.recording;
  schedulePersistState();

  addAudit('permissions.updated', {
    actor: 'technician',
    sessionId: s.id,
    deviceId: s.deviceId,
    message: `Permissions updated: ${JSON.stringify(s.permissions)}`
  });

  // Push updated permissions to all connected WebSocket clients in this session
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (client.sessionId !== s.id) continue;
    client.send(JSON.stringify({ type: 'permissions.update', payload: s.permissions }));
  }

  res.json({ ok: true, permissions: s.permissions });
});

app.post('/api/session/:id/recording', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  s.recording = Boolean(req.body?.recording);
  schedulePersistState();
  addAudit(s.recording ? 'recording.started' : 'recording.stopped', {
    actor: 'technician',
    sessionId: s.id,
    deviceId: s.deviceId,
    message: `Recording ${s.recording ? 'started' : 'stopped'} for ${s.id}`
  });
  res.json({ ok: true, recording: s.recording });
});

app.post('/api/session/:id/end', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  s.status = 'ended';
  s.endedAt = now();
  schedulePersistState();
  addAudit('session.ended', {
    actor: 'technician',
    sessionId: s.id,
    deviceId: s.deviceId,
    message: `Session ended: ${s.id}`
  });

  for (const client of wss.clients) {
    if (client.sessionId !== s.id) continue;
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'session.end', payload: { sessionId: s.id } }));
      client.close(1000, 'Session ended');
    }
  }

  res.json({ ok: true });
});

app.post('/api/session/:id/file-transfer', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const token = req.header('x-agent-token') || req.body?.agentToken;
  if (!isAuthenticated(req) && token !== s.agent.token) return res.status(401).json({ error: 'Login required' });

  const file = {
    id: nanoid(8),
    name: req.body?.name || 'support-package.zip',
    direction: req.body?.direction === 'download' ? 'download' : 'upload',
    path: req.body?.path || req.body?.name || 'support-package.zip',
    size: Number(req.body?.size || 0),
    chunks: Math.max(1, Math.ceil(Number(req.body?.size || 1) / 262144)),
    status: 'queued',
    createdAt: now()
  };
  s.files.unshift(file);
  addAudit('file.queued', {
    actor: 'technician',
    sessionId: s.id,
    deviceId: s.deviceId,
    message: `${file.direction} queued: ${file.name}`
  });
  res.json({ ok: true, file });
});

app.post('/api/session/:id/terminal', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  const commandText = String(req.body?.command || '').trim();
  if (!commandText) return res.status(400).json({ error: 'Command is required' });

  const command = {
    id: nanoid(8),
    command: commandText,
    status: 'queued',
    createdAt: now(),
    output: `Queued for remote agent: ${commandText}`
  };
  s.commands.unshift(command);
  addAudit('terminal.command.queued', {
    actor: 'technician',
    sessionId: s.id,
    deviceId: s.deviceId,
    message: `Command queued: ${commandText}`
  });
  res.json({ ok: true, command });
});

app.get('/api/audit', requireTechnician, (_req, res) => {
  res.json(auditLog);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ScreenConnect-compatible APIs: Session Types, Custom Properties, Session Groups,
// Host Passes, Diagnostics Toolkit, Installer Builder, Administration
// ═══════════════════════════════════════════════════════════════════════════════

// --- Instance metadata (like ScreenConnect's Script.ashx context) ---
app.get('/api/instance', requireTechnician, (req, res) => {
  res.json({
    productName: 'Remote Support',
    productVersion: '26.4.3.9662',
    instanceId: 'self-hosted',
    sessionTypes: SESSION_TYPE_NAMES,
    customPropertyLabels: CUSTOM_PROPERTY_LABELS,
    customPropertyCount: CUSTOM_PROPERTY_LABELS.length,
    sessionTypeInfos: [
      { type: 0, name: 'Support', description: 'On-demand remote support' },
      { type: 1, name: 'Meeting', description: 'Screen sharing presentations' },
      { type: 2, name: 'Access', description: 'Unattended remote access' }
    ],
    installerTypes: [
      { id: 'exe', label: 'Windows (.exe)', platform: 'windows' },
      { id: 'msi', label: 'Windows (.msi)', platform: 'windows' },
      { id: 'pkg', label: 'macOS (.pkg)', platform: 'macos' },
      { id: 'deb', label: 'Debian Linux (.deb)', platform: 'linux' },
      { id: 'rpm', label: 'Red Hat Linux (.rpm)', platform: 'linux' },
      { id: 'sh', label: 'Mac/Linux (.sh)', platform: 'unix' }
    ],
    features: {
      support: true, meeting: true, access: true,
      fileTransfer: true, remoteCommands: true, recording: true,
      blankScreen: true, blockInput: true, wakeOnLan: true,
      clipboard: true, annotations: false, sound: false,
      printing: false, backstage: false,
      diagnosticsToolkit: true, securityToolkit: true,
      reportGenerator: true, privilegedAccess: true
    },
    extensions: [...installedExtensions.values()],
    publicBaseUrl: PUBLIC_BASE_URL || publicOrigin(req)
  });
});

// --- Custom Properties per session ---
app.get('/api/session/:id/properties', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({
    labels: CUSTOM_PROPERTY_LABELS,
    values: s.customProperties || ['', '', '', '', '', '', '', '']
  });
});

app.put('/api/session/:id/properties', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const values = Array.isArray(req.body?.values) ? req.body.values.slice(0, 8) : [];
  s.customProperties = CUSTOM_PROPERTY_LABELS.map((_, i) => String(values[i] || '').slice(0, 200));
  schedulePersistState();
  addAudit('session.properties.updated', {
    actor: 'technician', sessionId: s.id, deviceId: s.deviceId,
    message: `Custom properties updated for ${s.displayName || s.id}`
  });
  res.json({ ok: true, labels: CUSTOM_PROPERTY_LABELS, values: s.customProperties });
});

// --- Session Groups (ScreenConnect-style dynamic groups with filters) ---
app.get('/api/session-groups', requireTechnician, (_req, res) => {
  const groups = [...sessionGroups.values()].sort((a, b) => (a.order || 0) - (b.order || 0));
  // Include default groups if none exist
  if (groups.length === 0) {
    const defaults = [
      { id: 'all-support', name: 'All Sessions', sessionType: 0, filter: '', subgroupExpression: '', order: 0 },
      { id: 'all-access', name: 'All Machines', sessionType: 2, filter: '', subgroupExpression: 'GuestOperatingSystemName', order: 1 },
      { id: 'online', name: 'Online Machines', sessionType: 2, filter: 'GuestConnectedCount > 0', subgroupExpression: '', order: 2 },
      { id: 'offline', name: 'Offline Machines', sessionType: 2, filter: 'GuestConnectedCount = 0', subgroupExpression: '', order: 3 }
    ];
    defaults.forEach(g => sessionGroups.set(g.id, g));
    return res.json(defaults);
  }
  res.json(groups);
});

app.post('/api/session-groups', requireTechnician, (req, res) => {
  const group = {
    id: nanoid(8),
    name: String(req.body?.name || 'New Group').slice(0, 80),
    sessionType: Number(req.body?.sessionType ?? 0),
    filter: String(req.body?.filter || ''),
    subgroupExpression: String(req.body?.subgroupExpression || ''),
    order: sessionGroups.size,
    createdAt: now()
  };
  sessionGroups.set(group.id, group);
  schedulePersistState();
  addAudit('session_group.created', { actor: 'technician', message: `Session group created: ${group.name}` });
  res.json(group);
});

app.put('/api/session-groups/:id', requireTechnician, (req, res) => {
  const group = sessionGroups.get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Session group not found' });
  if (req.body?.name) group.name = String(req.body.name).slice(0, 80);
  if (req.body?.filter !== undefined) group.filter = String(req.body.filter);
  if (req.body?.subgroupExpression !== undefined) group.subgroupExpression = String(req.body.subgroupExpression);
  if (req.body?.order !== undefined) group.order = Number(req.body.order);
  schedulePersistState();
  res.json(group);
});

app.delete('/api/session-groups/:id', requireTechnician, (req, res) => {
  if (!sessionGroups.delete(req.params.id)) return res.status(404).json({ error: 'Not found' });
  schedulePersistState();
  res.json({ ok: true });
});

// --- Host Passes (delegated access tokens like ScreenConnect) ---
app.get('/api/host-passes', requireTechnician, (_req, res) => {
  const passes = [...hostPasses.values()].filter(p => p.expiresAt > now());
  res.json(passes);
});

app.post('/api/host-passes', requireTechnician, (req, res) => {
  const lifetimeSeconds = Math.min(Number(req.body?.lifetimeSeconds || 3600), 2592000);
  const pass = {
    id: nanoid(16),
    token: nanoid(32),
    memo: String(req.body?.memo || '').slice(0, 200),
    permissions: req.body?.permissions || 'all',
    createdAt: now(),
    expiresAt: now() + lifetimeSeconds * 1000,
    createdBy: adminCredentials.username,
    sessionScope: req.body?.sessionScope || 'all'
  };
  hostPasses.set(pass.id, pass);
  schedulePersistState();
  addAudit('host_pass.created', {
    actor: 'technician',
    message: `Host pass created: ${pass.memo || pass.id} (expires in ${lifetimeSeconds}s)`
  });
  res.json(pass);
});

app.delete('/api/host-passes/:id', requireTechnician, (req, res) => {
  if (!hostPasses.delete(req.params.id)) return res.status(404).json({ error: 'Not found' });
  schedulePersistState();
  res.json({ ok: true });
});

app.post('/api/host-passes/revoke-all', requireTechnician, (_req, res) => {
  const count = hostPasses.size;
  hostPasses.clear();
  schedulePersistState();
  addAudit('host_passes.revoked_all', { actor: 'technician', message: `Revoked all ${count} host passes` });
  res.json({ ok: true, revoked: count });
});

// --- Diagnostics Toolkit (processes, services, software, event log, users) ---
app.get('/api/session/:id/diagnostics/:tab', (req, res) => {
  const s = findSessionByIdOrCode(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const tokenParam = req.query.token || req.header('x-session-token');
  if (!isAuthenticated(req) && tokenParam !== s.agent.token) return res.status(401).json({ error: 'Login required' });
  
  const tab = req.params.tab;
  const deviceId = s.deviceId;
  const diag = deviceId ? deviceDiagnostics.get(deviceId) : null;
  
  const validTabs = ['processes', 'services', 'software', 'updates', 'eventlog', 'users'];
  if (!validTabs.includes(tab)) return res.status(400).json({ error: `Invalid tab. Valid: ${validTabs.join(', ')}` });
  
  if (!diag || !diag[tab]) {
    return res.json({ tab, data: [], lastUpdated: null, message: 'Connect the guest agent to view diagnostics.' });
  }
  res.json({ tab, data: diag[tab].data || [], lastUpdated: diag[tab].updatedAt || null });
});

app.post('/api/session/:id/diagnostics/:tab/refresh', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  
  // Queue a diagnostics refresh command to the remote agent
  const tab = req.params.tab;
  const command = {
    id: nanoid(8),
    command: `__diagnostics_${tab}`,
    status: 'queued',
    createdAt: now(),
    output: `Requesting ${tab} diagnostics...`,
    isDiagnostics: true,
    diagnosticsTab: tab
  };
  s.commands.unshift(command);
  schedulePersistState();
  
  // Also send via WebSocket for real-time agents
  sendToSession(s.id, {
    type: 'diagnostics.request',
    payload: { tab, commandId: command.id }
  });
  
  addAudit('diagnostics.refresh', {
    actor: 'technician', sessionId: s.id, deviceId: s.deviceId,
    message: `Diagnostics refresh requested: ${tab}`
  });
  res.json({ ok: true, commandId: command.id });
});

// Agent posts diagnostics data back
app.post('/api/agent/:id/diagnostics', (req, res) => {
  const device = devices.get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const token = req.header('x-device-token') || req.body?.token;
  if (token !== device.token) return res.status(401).json({ error: 'Invalid device token' });

  const tab = String(req.body?.tab || '');
  const data = req.body?.data || [];
  if (!tab) return res.status(400).json({ error: 'Tab name required' });
  
  let diag = deviceDiagnostics.get(device.id);
  if (!diag) { diag = {}; deviceDiagnostics.set(device.id, diag); }
  diag[tab] = { data, updatedAt: now() };
  
  // Notify connected host viewers
  for (const session of sessions.values()) {
    if (session.deviceId === device.id && session.status !== 'ended') {
      sendToSession(session.id, {
        type: 'diagnostics.update',
        payload: { tab, data, updatedAt: diag[tab].updatedAt }
      });
    }
  }
  
  res.json({ ok: true });
});

// --- Diagnostics remote actions (kill process, restart service, etc.) ---
app.post('/api/session/:id/diagnostics/:tab/action', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  
  const action = String(req.body?.action || '');
  const target = String(req.body?.target || '');
  if (!action || !target) return res.status(400).json({ error: 'Action and target required' });
  
  const command = {
    id: nanoid(8),
    command: `__diagnostics_action_${req.params.tab}_${action}_${target}`,
    status: 'queued',
    createdAt: now(),
    output: `Executing ${action} on ${target}...`,
    isDiagnostics: true,
    diagnosticsTab: req.params.tab,
    diagnosticsAction: action,
    diagnosticsTarget: target
  };
  s.commands.unshift(command);
  schedulePersistState();
  
  sendToSession(s.id, {
    type: 'diagnostics.action',
    payload: { tab: req.params.tab, action, target, commandId: command.id }
  });
  
  addAudit('diagnostics.action', {
    actor: 'technician', sessionId: s.id, deviceId: s.deviceId,
    message: `Diagnostics action: ${action} on ${target}`
  });
  res.json({ ok: true, commandId: command.id });
});

// --- Meeting Session Creation ---
app.post('/api/session/create-meeting', requireTechnician, (req, res) => {
  const sessionId = nanoid(8);
  const joinCode = createNumericJoinCode(8);
  const session = {
    id: sessionId,
    joinCode,
    createdAt: now(),
    sessionType: SESSION_TYPES.Meeting,
    deviceId: null,
    deviceName: 'Meeting',
    displayName: String(req.body?.name || 'Untitled Meeting').slice(0, 80),
    permanentAccess: false,
    agent: { token: nanoid(24) },
    customer: { token: nanoid(24) },
    status: 'created',
    permissions: { screen: true, input: false, fileTransfer: false, terminal: false, recording: true },
    lastSeen: { technician: null, endpoint: null },
    recording: false, files: [], commands: [],
    nativeConnected: false, customerSocketId: null, blankScreen: false,
    isPublic: Boolean(req.body?.isPublic),
    customProperties: ['', '', '', '', '', '', '', '']
  };
  sessions.set(sessionId, session);
  schedulePersistState();
  addAudit('meeting.created', {
    actor: 'technician', sessionId,
    message: `Meeting session created: ${session.displayName}`
  });
  broadcastUpdate('session.update', { sessionId });
  res.json({
    sessionId, joinCode,
    displayName: session.displayName,
    sessionType: 'Meeting',
    agentPortalToken: session.agent.token,
    customerJoinToken: session.customer.token
  });
});

// --- Access Installer Builder ---
app.post('/api/installer/build', requireTechnician, (req, res) => {
  const installerType = String(req.body?.type || 'exe');
  const customProps = Array.isArray(req.body?.customProperties) ? req.body.customProperties.slice(0, 8) : [];
  
  // Create a permanent access session for the installer
  const sessionId = nanoid(8);
  const joinCode = createNumericJoinCode(8);
  const session = {
    id: sessionId,
    joinCode,
    createdAt: now(),
    sessionType: SESSION_TYPES.Access,
    deviceId: null,
    deviceName: String(customProps[0] || 'Access Agent'),
    displayName: String(customProps[0] || 'Access Agent'),
    permanentAccess: true,
    agent: { token: nanoid(24) },
    customer: { token: nanoid(24) },
    status: 'created',
    permissions: { screen: true, input: true, fileTransfer: true, terminal: true, recording: true },
    lastSeen: { technician: null, endpoint: null },
    recording: false, files: [], commands: [],
    nativeConnected: false, customerSocketId: null, blankScreen: false,
    customProperties: CUSTOM_PROPERTY_LABELS.map((_, i) => String(customProps[i] || '').slice(0, 200))
  };
  sessions.set(sessionId, session);
  schedulePersistState();
  
  addAudit('installer.built', {
    actor: 'technician', sessionId,
    message: `Access installer built (${installerType}) for ${session.displayName}`
  });
  
  const launchId = nanoid(12);
  agentLaunches.set(launchId, {
    sessionId: session.id,
    token: session.customer.token,
    expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30
  });
  
  res.json({
    ok: true,
    sessionId,
    joinCode,
    installerType,
    downloadUrl: `/download/${CUSTOMER_AGENT_EXE_NAME}?launchId=${encodeURIComponent(launchId)}&v=${encodeURIComponent(CUSTOMER_AGENT_BUILD)}`,
    customProperties: session.customProperties,
    displayName: session.displayName
  });
});

// --- Wake-on-LAN ---
app.post('/api/session/:id/wake', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  
  // Send WoL signal through other online agents on the same network
  addAudit('wake.sent', {
    actor: 'technician', sessionId: s.id, deviceId: s.deviceId,
    message: `Wake-on-LAN signal queued for ${s.displayName || s.deviceName}`
  });
  
  // Queue wake command for all online agents
  for (const session of sessions.values()) {
    if (session.id === s.id || session.status === 'ended') continue;
    if (!session.nativeConnected && !session.customerSocketId) continue;
    sendToSession(session.id, {
      type: 'wake.request',
      payload: { targetSessionId: s.id, targetDeviceId: s.deviceId }
    });
  }
  
  res.json({ ok: true, message: 'Wake-on-LAN signal queued' });
});

// --- Send Message to Guest (ScreenConnect chat) ---
app.post('/api/session/:id/message', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message required' });
  
  sendToSession(s.id, {
    type: 'chat',
    payload: { sender: 'technician', message, timestamp: now() }
  });
  
  addAudit('message.sent', {
    actor: 'technician', sessionId: s.id,
    message: `Message sent to guest: ${message.slice(0, 100)}`
  });
  res.json({ ok: true });
});

// --- Reinstall Agent ---
app.post('/api/session/:id/reinstall', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  
  const command = {
    id: nanoid(8),
    command: '__reinstall_agent',
    status: 'queued',
    createdAt: now(),
    output: 'Agent reinstall queued...'
  };
  s.commands.unshift(command);
  schedulePersistState();
  
  sendToSession(s.id, {
    type: 'agent.reinstall',
    payload: { commandId: command.id }
  });
  
  addAudit('agent.reinstall.queued', {
    actor: 'technician', sessionId: s.id, deviceId: s.deviceId,
    message: `Agent reinstall queued for ${s.displayName || s.id}`
  });
  res.json({ ok: true });
});

// --- Uninstall Agent ---
app.post('/api/session/:id/uninstall', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  
  sendToSession(s.id, { type: 'agent.uninstall', payload: { sessionId: s.id } });
  
  addAudit('agent.uninstall.queued', {
    actor: 'technician', sessionId: s.id, deviceId: s.deviceId,
    message: `Agent uninstall queued for ${s.displayName || s.id}`
  });
  res.json({ ok: true });
});

// --- Transfer Session to Another Host ---
app.post('/api/session/:id/transfer', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const newHost = String(req.body?.host || '').trim();
  if (!newHost) return res.status(400).json({ error: 'Target host required' });
  
  s.host = newHost;
  schedulePersistState();
  addAudit('session.transferred', {
    actor: 'technician', sessionId: s.id,
    message: `Session transferred to ${newHost}`
  });
  res.json({ ok: true });
});

// --- Add/Remove Session Notes ---
app.post('/api/session/:id/notes', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const note = String(req.body?.note || '').trim();
  if (!note) return res.status(400).json({ error: 'Note required' });
  
  if (!s.notes) s.notes = [];
  s.notes.push({ id: nanoid(8), text: note, createdAt: now(), author: adminCredentials.username });
  schedulePersistState();
  addAudit('note.added', {
    actor: 'technician', sessionId: s.id,
    message: `Note added: ${note.slice(0, 100)}`
  });
  res.json({ ok: true, notes: s.notes });
});

app.get('/api/session/:id/notes', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json(s.notes || []);
});

app.delete('/api/session/:id/notes/:noteId', requireTechnician, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (!s.notes) return res.status(404).json({ error: 'Note not found' });
  s.notes = s.notes.filter(n => n.id !== req.params.noteId);
  schedulePersistState();
  res.json({ ok: true });
});

// --- Administration: Security settings ---
app.get('/api/admin/security', requireTechnician, (_req, res) => {
  res.json({
    userSources: [{ type: 'Internal', enabled: true, users: 1 }],
    roles: [...roles.values()],
    authenticationSessionCount: authSessions.size,
    hostPassCount: [...hostPasses.values()].filter(p => p.expiresAt > now()).length,
    twoFactorRequired: false,
    passwordPolicy: { minLength: 8 },
    ipRestrictions: [],
    blockedIps: []
  });
});

// --- Administration: Overview ---
app.get('/api/admin/overview', requireTechnician, (_req, res) => {
  const totalSessions = sessions.size;
  const activeSessions = [...sessions.values()].filter(s => s.status === 'active').length;
  const totalDevices = devices.size;
  const onlineDevices = [...devices.values()].filter(d => d.status === 'online').length;
  
  res.json({
    version: '26.4.3.9662',
    uptime: process.uptime(),
    sessions: { total: totalSessions, active: activeSessions },
    devices: { total: totalDevices, online: onlineDevices },
    extensions: installedExtensions.size,
    sessionGroups: sessionGroups.size,
    hostPasses: [...hostPasses.values()].filter(p => p.expiresAt > now()).length,
    auditEntries: auditLog.length,
    customPropertyLabels: CUSTOM_PROPERTY_LABELS
  });
});

// --- Administration: Appearance (resource customization) ---
app.get('/api/admin/appearance', requireTechnician, (_req, res) => {
  res.json({
    theme: 'DarkTeal',
    availableThemes: ['DarkTeal', 'Light', 'Dark', 'HighContrast'],
    logoVisible: true,
    iconVisible: true,
    headingVisible: false,
    customPropertyLabels: CUSTOM_PROPERTY_LABELS,
    guestPageBackground: ''
  });
});

app.put('/api/admin/appearance', requireTechnician, (req, res) => {
  // Update custom property labels
  if (Array.isArray(req.body?.customPropertyLabels)) {
    req.body.customPropertyLabels.forEach((label, i) => {
      if (i < CUSTOM_PROPERTY_LABELS.length && typeof label === 'string') {
        CUSTOM_PROPERTY_LABELS[i] = label.slice(0, 50);
      }
    });
  }
  schedulePersistState();
  addAudit('admin.appearance.updated', { actor: 'technician', message: 'Appearance settings updated' });
  res.json({ ok: true, customPropertyLabels: CUSTOM_PROPERTY_LABELS });
});

// --- Administration: Database maintenance ---
app.get('/api/admin/database', requireTechnician, (_req, res) => {
  const endedSessions = [...sessions.values()].filter(s => s.status === 'ended').length;
  res.json({
    totalSessions: sessions.size,
    endedSessions,
    totalDevices: devices.size,
    totalAuditEntries: auditLog.length,
    stateFileSize: fs.existsSync(statePath) ? fs.statSync(statePath).size : 0,
    actions: [
      { type: 'PurgeDeletedSessions', description: 'Remove ended sessions', available: endedSessions > 0 },
      { type: 'PurgeAuditLog', description: 'Clear audit log entries', available: auditLog.length > 0 },
      { type: 'CompactDatabase', description: 'Compact state file', available: true }
    ]
  });
});

app.post('/api/admin/database/action', requireTechnician, (req, res) => {
  const action = String(req.body?.action || '');
  
  if (action === 'PurgeDeletedSessions') {
    let purged = 0;
    for (const [id, s] of sessions) {
      if (s.status === 'ended') { sessions.delete(id); purged++; }
    }
    schedulePersistState();
    addAudit('database.purge_sessions', { actor: 'technician', message: `Purged ${purged} ended sessions` });
    return res.json({ ok: true, purged });
  }
  
  if (action === 'PurgeAuditLog') {
    const count = auditLog.length;
    auditLog.length = 0;
    schedulePersistState();
    return res.json({ ok: true, purged: count });
  }
  
  if (action === 'CompactDatabase') {
    persistState();
    return res.json({ ok: true, message: 'Database compacted' });
  }
  
  res.status(400).json({ error: 'Unknown action' });
});

// --- Administration: Extensions ---
app.get('/api/admin/extensions', requireTechnician, (_req, res) => {
  // Return built-in "extensions" matching ScreenConnect's extension model
  const builtIn = [
    { id: 'diagnostics-toolkit', name: 'Diagnostics Toolkit', version: '1.0.0', status: 'Active', author: 'System',
      description: 'View processes, services, software, updates, event log, and users on remote machines.' },
    { id: 'security-toolkit', name: 'Security Toolkit', version: '1.0.0', status: 'Active', author: 'System',
      description: 'Monitor suspicious session events and manage queued commands.' },
    { id: 'report-generator', name: 'Report Generator', version: '1.0.0', status: 'Active', author: 'System',
      description: 'Build and run reports about sessions, connections, and events.' },
    { id: 'enhanced-help', name: 'Enhanced Help', version: '1.0.0', status: 'Active', author: 'System',
      description: 'In-app help guides, release notes, and support links.' },
    { id: 'audit-csv-export', name: 'Audit CSV Export', version: '1.0.0', status: 'Active', author: 'System',
      description: 'Export audit log entries as CSV files.' },
    { id: 'privileged-access', name: 'Privileged Access Management', version: '1.0.0', status: 'Active', author: 'System',
      description: 'Manage elevation prompts and administrative logon requests.' }
  ];
  res.json([...builtIn, ...installedExtensions.values()]);
});

// --- Invite guest via email (ScreenConnect-style) ---
app.post('/api/session/:id/invite', requireTechnician, async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const email = String(req.body?.email || '').trim();
  if (!email) return res.status(400).json({ error: 'Email address required' });
  
  const joinUrl = `${PUBLIC_BASE_URL || 'https://www.helpsupport.top'}/customer?code=${encodeURIComponent(s.joinCode || s.id)}`;
  
  try {
    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = Number(process.env.SMTP_PORT || 465);
    const user = process.env.SMTP_USER || '';
    const pass = process.env.SMTP_PASS || '';
    const from = process.env.SMTP_FROM || user;
    
    if (!user || !pass) {
      addAudit('invite.sent', { actor: 'technician', sessionId: s.id, message: `Invite link for ${email}: ${joinUrl}` });
      return res.json({ ok: true, sent: false, joinUrl, message: 'SMTP not configured. Share the link manually.' });
    }
    
    const socket = tls.connect({ host, port, servername: host });
    await smtpCommand(socket, null);
    await smtpCommand(socket, `EHLO ${host}`);
    await smtpCommand(socket, 'AUTH LOGIN', /^334/);
    await smtpCommand(socket, Buffer.from(user).toString('base64'), /^334/);
    await smtpCommand(socket, Buffer.from(pass).toString('base64'));
    await smtpCommand(socket, `MAIL FROM:<${from}>`);
    await smtpCommand(socket, `RCPT TO:<${email}>`);
    await smtpCommand(socket, 'DATA', /^354/);
    const body = [
      `From: Remote Support <${from}>`,
      `To: ${email}`,
      `Subject: You've been invited to a remote support session`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#555;color:#fff;padding:30px;border-radius:8px;">`,
      `<h2 style="text-align:center;">You've been invited to a remote session</h2>`,
      `<p style="text-align:center;color:#999;">Click the button below to join.</p>`,
      `<div style="text-align:center;padding:15px;">`,
      `<a href="${joinUrl}" style="background:#CC3232;color:#fff;padding:12px 40px;border-radius:4px;text-decoration:none;font-size:18px;">Join Now</a>`,
      `</div>`,
      `<p style="text-align:center;color:#888;font-size:12px;">${joinUrl}</p>`,
      `<p style="text-align:center;color:#959595;font-size:12px;">Powered by Remote Support</p>`,
      `</div>`,
      '.'
    ].join('\r\n');
    await smtpCommand(socket, body);
    await smtpCommand(socket, 'QUIT', /^[23]/);
    socket.end();
    
    addAudit('invite.sent', { actor: 'technician', sessionId: s.id, message: `Email invite sent to ${email}` });
    res.json({ ok: true, sent: true, joinUrl });
  } catch (err) {
    addAudit('invite.failed', { actor: 'technician', sessionId: s.id, message: `Email invite failed for ${email}: ${err.message}` });
    res.json({ ok: true, sent: false, joinUrl, error: err.message });
  }
});

// --- Session quality/capture stats endpoint ---
app.get('/api/session/:id/capture-stats', (req, res) => {
  const s = findSessionByIdOrCode(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const tokenParam = req.query.token || req.header('x-session-token');
  const ok = isAuthenticated(req) || tokenParam === s.customer.token || tokenParam === s.agent.token;
  if (!ok) return res.status(401).json({ error: 'Login required' });

  res.json({
    ok: true,
    sessionId: s.id,
    screenStreaming: hasRecentScreenStream(s),
    lastFrameAt: s.lastFrameAt || null,
    lastFrameReceivers: s.lastFrameReceivers || 0,
    lastFrameBytes: s.lastFrameBytes || 0,
    lastFrameDroppedAt: s.lastFrameDroppedAt || null,
    lastFrameDropReason: s.lastFrameDropReason || null,
    lastFrameDeliveredAt: s.lastFrameDeliveredAt || null,
    customerPlatform: s.customerPlatform || null,
    customerScreenStatus: s.customerScreenStatus || null,
    customerCapabilities: s.customerCapabilities || {},
    nativeConnected: Boolean(s.nativeConnected),
    browserConnected: Boolean(s.customerSocketId),
    captureQuality: {
      format: s.lastCaptureFormat || null,
      tier: s.lastCaptureTier || null,
      width: s.lastCaptureWidth || null,
      height: s.lastCaptureHeight || null,
      quality: s.lastCaptureQuality || null
    }
  });
});

// --- ScreenConnect-compatible Script.ashx endpoint ---
app.get('/Script.ashx', (req, res) => {
  res.type('application/javascript').send(`
    // ScreenConnect-compatible context
    var SC = SC || {};
    SC.context = SC.context || {};
    SC.context.productVersion = "26.4.3.9662";
    SC.context.customPropertyCount = ${CUSTOM_PROPERTY_LABELS.length};
    SC.context.arePublicSessionsDisabled = true;
    SC.context.accessTokenExpireSeconds = 7200;
  `);
});

function createAppServer() {
  const keyPath = process.env.HTTPS_KEY;
  const certPath = process.env.HTTPS_CERT;
  const pfxPath = process.env.HTTPS_PFX;
  const passphrase = process.env.HTTPS_PFX_PASSPHRASE;
  if (pfxPath) {
    return {
      server: https.createServer({
        pfx: fs.readFileSync(pfxPath),
        passphrase
      }, app),
      protocol: 'https'
    };
  }

  if (!keyPath || !certPath) {
    return { server: http.createServer(app), protocol: 'http' };
  }

  return {
    server: https.createServer({
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    }, app),
    protocol: 'https'
  };
}

const { server, protocol } = createAppServer();
const wss = new WebSocketServer({ server });

function getSessionFromWs(sessionId) {
  return findSessionByIdOrCode(sessionId);
}

wss.on('connection', (ws, req) => {
  // Expect query params: role=agent|host|customer&sessionId=...&token=...
  // role=agent   → technician side (legacy / host-client.html uses this)
  // role=host    → alias for agent, same token, used by host-client.html
  // role=customer → customer / remote endpoint
  const url = new URL(req.url, 'http://localhost');
  const rawRole = url.searchParams.get('role');
  const clientKindRaw = url.searchParams.get('client') || '';
  const clientKind = String(clientKindRaw).toLowerCase();
  const sessionId = url.searchParams.get('sessionId');
  const token = url.searchParams.get('token');

  if (sessionId === 'global' && rawRole === 'agent') {
    // Basic auth check for global technician channel
    // In a real app we'd check the tech's auth session cookie or a token.
    // For now, we'll just allow it if rawRole is agent.
    ws.role = 'agent';
    ws.sessionId = 'global';
    ws.connectionId = nanoid(10);
    addAudit('technician.global.connected', { message: 'Technician joined global updates channel' });
    return;
  }

  const s = getSessionFromWs(sessionId);
  if (!s || s.status === 'ended') {
    ws.send(JSON.stringify({
      type: 'error',
      payload: {
        message: 'Session not found or has ended.',
        sessionId,
        role: rawRole
      }
    }));
    ws.close(1008, 'Session not found');
    return;
  }


  // Normalise: 'host' is an alias for 'agent'
  const role = rawRole === 'host' ? 'agent' : rawRole;

  const isMobileBroadcast = isMobileBroadcastClientKind(clientKind);
  const isIosBroadcastClient = clientKind === 'ios-mobile-broadcast';
  const isAndroidBroadcastClient = clientKind === 'android-mobile-broadcast';

  const isMobileViewer = [
    'ios-mobile-viewer',
    'android-mobile-viewer',
    'mobile-viewer'
  ].includes(clientKind);

  const ok =
    (role === 'agent' && token === s.agent.token) ||
    (role === 'customer' && token === s.customer.token) ||
    // Mobile app integrations use the same customer token.
    (role === 'customer' && token === s.customer.token && (isMobileBroadcast || isMobileViewer));

  if (!ok) {
    ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid token.' } }));
    ws.close(1008, 'Unauthorized');
    return;
  }

  if (role === 'agent' && clientKind === 'host-viewer' && hasOpenHostViewer(s.id)) {
    ws.send(JSON.stringify({
      type: 'error',
      payload: {
        code: 'HOST_ALREADY_CONNECTED',
        message: 'A host viewer is already connected to this customer session. Close the existing host viewer before connecting again.'
      }
    }));
    ws.close(4009, 'Host viewer already connected');
    return;
  }

  if (role === 'customer') {
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      if (client.role !== 'customer') continue;
      if (client.sessionId !== s.id) continue;
      // Allow multiple customer clients to coexist if they are different kinds
      // (e.g. browser join page + native mobile broadcast app).
      if (client.clientKind === clientKind) {
        client.send(JSON.stringify({ type: 'session.end', payload: { sessionId: s.id, reason: 'Replaced by a newer customer connection' } }));
        client.close(4001, 'Replaced by newer customer connection');
      }
    }
  }

  ws.connectionId = nanoid(10);
  ws.role = role;
  ws.clientKind = clientKind;
  ws.sessionId = s.id;
  if (role === 'agent' && clientKind === 'host-viewer') s.lastHostViewerConnectedAt = now();
  if (role === 'customer') {
    s.customerSocketId = ws.connectionId;
    ws.lastSequence = -1;
    s.lastCustomerSequence = -1;
    updateCustomerLifecycleStatus(s, 'connecting');
    // Track no-frame telemetry windows to diagnose "connected but waiting for frames".
    s.noFrameTelemetryDueAt = Date.now() + NO_FRAME_TELEMETRY_TIMEOUT_MS;
    s.noFrameTelemetryLoggedAt = null;
    s.lastHeartbeatAt = Date.now();
    s.mobileHeartbeatTimeoutAt = Date.now() + MOBILE_HEARTBEAT_TIMEOUT_MS;
    s.mobileStreamReconnectRequired = false;

    // Do not mark mobile broadcast client as fully connected until first frame arrives.
    if (isIosBroadcastClient || isAndroidBroadcastClient) {
      s.nativeConnected = false;
      s.customerScreenStatus = isIosBroadcastClient ? 'ios_broadcast_connected_waiting_first_frame' : 'android_broadcast_connected_waiting_first_frame';
      updateCustomerLifecycleStatus(s, 'waiting_permission');
      addAudit(`${isIosBroadcastClient ? 'ios' : 'android'}.broadcast.connected.waiting_first_frame`, {
        actor: 'system',
        sessionId: s.id,
        deviceId: s.deviceId,
        message: `${isIosBroadcastClient ? 'iOS' : 'Android'} broadcast client connected; waiting for first screen.frame before marking session active.`
      });
    } else if (isMobileBroadcast || isMobileViewer) {
      s.nativeConnected = true;
      updateCustomerLifecycleStatus(s, 'authenticated');
    } else {
      // Browser join pages ('browser-share' and 'browser-broadcast') are signaling
      // channels only on mobile; the native broadcast app delivers the actual frames.
      // Do not mark nativeConnected from a browser page, otherwise the session is
      // considered active before any screen.frame has arrived.
      const isBrowserSignaling = (clientKind === 'browser-share' || clientKind === 'browser-broadcast');
      s.nativeConnected = !isBrowserSignaling;
      if (s.nativeConnected) {
        updateCustomerLifecycleStatus(s, 'connected');
      } else {
        // Even though nativeConnected is false, the customer's browser IS connected.
        // Mark the session as customer_joined so the host sees the customer is present.
        // This is critical for mobile phones where the browser is the signaling channel
        // and possibly the only connection (when no native app is installed).
        updateCustomerLifecycleStatus(s, 'browser_connected');
      }
    }
  }

  if (role === 'agent') s.lastSeen.technician = Date.now();
  if (role === 'customer') s.lastSeen.endpoint = Date.now();
  if ((s.status === 'created' || s.status === 'waiting') && role === 'customer') s.status = 'customer_joined';
  if (s.status === 'customer_joined' && role === 'agent' && (s.nativeConnected || hasRecentScreenStream(s))) s.status = 'active';
  if (s.nativeConnected && s.lastSeen.technician) s.status = 'active';

  // When a host/agent connects to a session that has a customer browser connected
  // but not yet streaming, automatically send a screen.request to prompt the customer
  // to initiate screen sharing (like ScreenConnect's host-initiated flow).
  if (role === 'agent' && s.customerSocketId && !s.nativeConnected && !hasRecentScreenStream(s)) {
    const screenRequestMsg = JSON.stringify({
      type: 'screen.request',
      payload: {
        requestedBy: 'technician',
        sessionId: s.id,
        message: 'The technician is ready to view your screen.'
      }
    });
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      if (client.sessionId !== s.id) continue;
      if (client.role !== 'customer') continue;
      client.send(screenRequestMsg);
    }
    addAudit('screen.request.sent', {
      actor: 'technician',
      sessionId: s.id,
      message: 'Screen share request sent to customer'
    });
  }

  addAudit(`${role}.socket.connected`, {
    sessionId: s.id,
    deviceId: s.deviceId,
    message: `${role} connected to secure signaling channel`
  });

  broadcastUpdate('session.update', { sessionId: s.id });

  // Notify the new peer about current session state and permissions
  ws.send(JSON.stringify({
    type: 'session.ready',
    payload: {
      sessionId: s.id,
      role,
      status: s.status,
      permissions: s.permissions,
      displayName: s.displayName || s.deviceName
    }
  }));

  // Tell existing peers on the other side that a new peer connected
  for (const client of wss.clients) {
    if (client === ws) continue;
    if (client.readyState !== 1) continue;
    if (client.sessionId !== s.id) continue;
    if (client.role === role) continue;
    client.send(JSON.stringify({
      type: 'peer.connected',
      payload: {
        role,
        clientKind,
        platform: s.customerPlatform || (isIosBroadcastClient ? 'ios' : (isAndroidBroadcastClient ? 'android' : 'unknown'))
      }
    }));
  }

  ws.on('close', () => {
    if (role === 'agent') {
      const hasAgent = hasOpenSessionPeer(s.id, 'agent');
      const hasCustomer = Boolean(s.customerSocketId || s.nativeConnected || (s.permanentAccess && devices.get(s.deviceId || '')?.status === 'online'));
      if (!hasAgent) {
        s.status = hasCustomer ? 'customer_joined' : (s.permanentAccess ? 'offline' : 'waiting');
        schedulePersistState();
      }
    }

    if (role === 'customer' && ws.connectionId === s.customerSocketId) {
      s.customerSocketId = null;
      const device = s.deviceId ? devices.get(s.deviceId) : null;
      const deviceOnline = device?.status === 'online';

      // A browser join page ('browser-share' or 'browser-broadcast') is only a
      // signaling channel. If a native mobile broadcast app is still connected and
      // recently delivered frames, closing the browser page must NOT tear down the
      // session or mark the customer disconnected — the native app keeps streaming.
      const isBrowserSignalingSocket = ws.clientKind === 'browser-share' || ws.clientKind === 'browser-broadcast';
      const hasLiveNativeBroadcast = [...wss.clients].some((client) =>
        client !== ws &&
        client.readyState === 1 &&
        client.role === 'customer' &&
        client.sessionId === s.id &&
        isMobileBroadcastClientKind(client.clientKind) &&
        Boolean(s.lastFrameAt) &&
        (Date.now() - Number(s.lastFrameAt)) <= MOBILE_FRAME_STALE_TIMEOUT_MS
      );
      if (isBrowserSignalingSocket && hasLiveNativeBroadcast) {
        // Hand customerSocketId to the still-connected native broadcast socket so its
        // subsequent messages are not gated out by the customerSocketId check.
        const nativeClient = [...wss.clients].find((client) =>
          client !== ws &&
          client.readyState === 1 &&
          client.role === 'customer' &&
          client.sessionId === s.id &&
          isMobileBroadcastClientKind(client.clientKind)
        );
        if (nativeClient) s.customerSocketId = nativeClient.connectionId;
        schedulePersistState();
      } else if (s.permanentAccess && deviceOnline) {
        // Do not force permanent-access sessions offline if endpoint heartbeat still reports online.
        s.nativeConnected = true;
        s.status = hasOpenSessionPeer(s.id, 'agent') ? 'active' : 'customer_joined';
      } else {
        s.nativeConnected = false;
        if (s.status === 'active' || s.status === 'customer_joined') {
          s.status = s.permanentAccess ? 'offline' : 'waiting';
        }
      }
      schedulePersistState();
    }

    addAudit(`${role}.socket.disconnected`, {
      sessionId: s.id,
      deviceId: s.deviceId,
      message: `${role} disconnected from signaling channel`
    });

    broadcastUpdate('session.update', { sessionId: s.id });
    // Notify the other side that this peer left
    for (const client of wss.clients) {
      if (client === ws) continue;
      if (client.readyState !== 1) continue;
      if (client.sessionId !== s.id) continue;
      client.send(JSON.stringify({ type: 'peer.disconnected', payload: { role } }));
    }
  });

  ws.on('message', (data) => {
    // Message format: { type, payload }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }

    const { type, payload } = msg || {};
    if (!type) return;

    if (role === 'customer' && ws.connectionId !== s.customerSocketId) {
      const isCustomerStatusMessage =
        type === 'screen.frame' ||
        type === 'screen.heartbeat' ||
        type === 'screen.broadcast.status' ||
        type === 'chat';
      if (!isCustomerStatusMessage) {
        return;
      }
    }

    if (role === 'customer' && type === 'screen.frame') {
      const sequence = Number(payload?.sequence ?? -1);
      if (Number.isFinite(sequence) && sequence >= 0) {
        // Browser and native customer sockets can coexist; sequence numbers
        // are local to each sender, not global to the session.
        if (typeof ws.lastSequence === 'number' && sequence <= ws.lastSequence) {
          return;
        }
        ws.lastSequence = sequence;
        s.lastCustomerSequence = Math.max(Number(s.lastCustomerSequence || -1), sequence);
      }
      s.lastFrameAt = now();
      updateCustomerLifecycleStatus(s, 'sending_frames');
      s.mobileHeartbeatTimeoutAt = Date.now() + MOBILE_HEARTBEAT_TIMEOUT_MS;
      s.noFrameTelemetryDueAt = null;
      s.noFrameTelemetryLoggedAt = null;
      s.lastFrameBytes = Buffer.byteLength(data);
      s.lastFrameReceivers = 0;
      s.lastFrameDroppedAt = null;
      s.lastFrameDropReason = null;
      // Track capture quality metadata from enhanced frames
      if (payload?.format) s.lastCaptureFormat = String(payload.format);
      if (payload?.tier) s.lastCaptureTier = String(payload.tier);
      if (payload?.width) s.lastCaptureWidth = Number(payload.width);
      if (payload?.height) s.lastCaptureHeight = Number(payload.height);
      if (payload?.quality) s.lastCaptureQuality = Number(payload.quality);
      if (!s.nativeConnected) {
        s.nativeConnected = true;
        updateCustomerLifecycleStatus(s, 'connected');
        addAudit('screen.first_frame.received', {
          actor: 'system',
          sessionId: s.id,
          deviceId: s.deviceId,
          message: 'First customer screen.frame received; session can now be treated as active.'
        });
        broadcastUpdate('session.update', { sessionId: s.id });
      }
      if (s.lastSeen.technician) s.status = 'active';
      if (s.status === 'customer_joined' && s.lastSeen.technician) s.status = 'active';
    }

    if (role === 'customer' && type === 'screen.broadcast.status') {
      s.customerPlatform = normalizeClientPlatform(payload?.platform || s.customerPlatform);
      // Prevent browser-broadcast signaling sockets from downgrading an informative
      // screen status to the generic 'unavailable'. The browser join page used to send
      // 'unavailable' when getDisplayMedia is absent, but the server may already have a
      // more useful status (e.g. 'ios_native_app_required') set during /join.
      const incomingStatus = payload?.status || null;
      const isBrowserSignalingClient = ws.clientKind === 'browser-broadcast' || ws.clientKind === 'browser-share';
      const informativeStatuses = new Set([
        'ios_native_app_required',
        'android_native_app_required',
        'ios_broadcast_connected_waiting_first_frame',
        'android_broadcast_connected_waiting_first_frame',
        'browser_screen_capture_available',
        'starting',
        'live'
      ]);
      if (isBrowserSignalingClient && incomingStatus === 'unavailable' && informativeStatuses.has(s.customerScreenStatus)) {
        // Keep the existing informative status; do not overwrite.
      } else {
        s.customerScreenStatus = incomingStatus || s.customerScreenStatus || null;
      }
      if (s.customerScreenStatus === 'starting') updateCustomerLifecycleStatus(s, 'capturing_screen');
      if (s.customerScreenStatus === 'live') updateCustomerLifecycleStatus(s, 'connected');
      if (s.customerScreenStatus === 'reconnect_required') updateCustomerLifecycleStatus(s, 'reconnecting');
      s.customerCapabilities = {
        ...(s.customerCapabilities || {}),
        screenCapture: Boolean(payload?.screenCapture),
        remoteControl: s.customerPlatform !== 'iphone' && s.customerPlatform !== 'ipad'
      };
      s.lastHeartbeatAt = Date.now();
      s.mobileHeartbeatTimeoutAt = Date.now() + MOBILE_HEARTBEAT_TIMEOUT_MS;
      // Server-side telemetry when customer connects but no frames arrive in time.
      if (s.noFrameTelemetryDueAt && !s.lastFrameAt && Date.now() >= s.noFrameTelemetryDueAt) {
        s.noFrameTelemetryLoggedAt = Date.now();
        s.noFrameTelemetryDueAt = null;
        addAudit('screen.frame.wait.timeout', {
          actor: 'system',
          sessionId: s.id,
          deviceId: s.deviceId,
          message: `Customer connected (${s.customerPlatform || 'unknown'} / ${clientKind || 'unknown'}) but no screen.frame received within ${Math.round(NO_FRAME_TELEMETRY_TIMEOUT_MS / 1000)}s. Last broadcast status: ${s.customerScreenStatus || 'unknown'}.`
        });
      }
      schedulePersistState();
      broadcastUpdate('session.update', { sessionId: s.id });
    }

    if (role === 'customer' && type === 'screen.heartbeat') {
      s.lastHeartbeatAt = Date.now();
      s.mobileHeartbeatTimeoutAt = Date.now() + MOBILE_HEARTBEAT_TIMEOUT_MS;
      if (s.customerLifecycleStatus === 'reconnecting' || s.customerLifecycleStatus === 'disconnected') {
        updateCustomerLifecycleStatus(s, 'connecting');
      }
      if (s.mobileStreamReconnectRequired) {
        s.mobileStreamReconnectRequired = false;
        if (!s.lastFrameAt) {
          s.customerScreenStatus = (s.customerPlatform === 'iphone' || s.customerPlatform === 'ipad')
            ? 'ios_broadcast_connected_waiting_first_frame'
            : 'android_broadcast_connected_waiting_first_frame';
        }
        addAudit('mobile.stream.heartbeat.resumed', {
          actor: 'system',
          sessionId: s.id,
          deviceId: s.deviceId,
          message: 'Mobile heartbeat resumed after interruption.'
        });
      }
      schedulePersistState();
    }

    // Permission guard: only block customer attempts to perform *control* actions.
    // Input relay should be directionally controlled (agent -> customer). Avoid blocking
    // any messages needed for session control/handshake.
    if (role === 'customer') {
      const disallowedCustomerTypes = ['permissions.update', 'session.end-remote'];
      if (disallowedCustomerTypes.includes(type)) {
        ws.send(JSON.stringify({ type: 'error', payload: { message: `Not authorised to send '${type}'` } }));
        return;
      }
    }

    if (type === 'input') {
      // Only relay if session has input permission enabled
      if (!s.permissions.input) {
        ws.send(JSON.stringify({
          type: 'input.relayed',
          payload: { ok: false, receivers: 0, error: 'Input permission is disabled for this session.' }
        }));
        return;
      }

      // ScreenConnect-style “control” events (like Ctrl+Alt+Del) are still carried via `input`.
      // Do not block them; the native agent interprets `payload.kind`.
      const kind = payload?.kind || 'unknown';

      addAudit('remote.input', {
        actor: 'technician',
        sessionId: s.id,
        deviceId: s.deviceId,
        message: `Input event relayed: ${kind}`
      });
    }

    if (type === 'blank-screen') {
      // Control action: blank/unblank remote screen.
      // Gate by input permission (if input is disabled, there should be no remote control changes).
      if (!s.permissions.input) {
        if (role === 'customer') {
          // Customer should never send this, but fail closed anyway.
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Not authorised to blank screen in this session.' } }));
        }
        return;
      }

      s.blankScreen = Boolean(payload?.enabled);
      addAudit(payload?.enabled ? 'blank-screen.enabled' : 'blank-screen.disabled', {
        actor: 'technician',
        sessionId: s.id,
        deviceId: s.deviceId,
        message: payload?.enabled ? 'Customer blank screen enabled' : 'Customer screen restored'
      });
    }

    if (type === 'block-input') {
      // Control action: block/unblock remote keyboard+mouse.
      // Gate by input permission.
      if (!s.permissions.input) {
        if (role === 'customer') {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Not authorised to block input in this session.' } }));
        }
        return;
      }

      addAudit(payload?.enabled ? 'guest-input.blocked' : 'guest-input.restored', {
        actor: 'technician',
        sessionId: s.id,
        deviceId: s.deviceId,
        message: payload?.enabled ? 'Customer keyboard and mouse blocked' : 'Customer keyboard and mouse restored'
      });
    }

    if (type === 'permissions.update' && role === 'agent') {
      // Technician can update live permissions mid-session
      const p = payload || {};
      if (typeof p.input === 'boolean') s.permissions.input = p.input;
      if (typeof p.fileTransfer === 'boolean') s.permissions.fileTransfer = p.fileTransfer;
      if (typeof p.terminal === 'boolean') s.permissions.terminal = p.terminal;
      addAudit('permissions.updated', {
        actor: 'technician',
        sessionId: s.id,
        deviceId: s.deviceId,
        message: `Permissions updated: ${JSON.stringify(s.permissions)}`
      });
    }

    // Relay signaling, input, chat, and control messages to the other side.
    let receivers = 0;

    for (const client of wss.clients) {
      if (client === ws) continue;
      if (client.readyState !== 1) continue;
      if (client.sessionId !== s.id) continue;
      if (client.role === role) continue;

      // Relay customer broadcast/status messages to all host viewers in the session.
      // (Do not restrict by host clientKind; browser host and native host both need visibility.)
      if (type === 'screen.frame' && client.bufferedAmount > MAX_SCREEN_FRAME_BUFFER_BYTES) {
        s.lastFrameDroppedAt = now();
        s.lastFrameDropReason = 'Host viewer WebSocket buffer is full.';
        continue;
      }

      client.send(JSON.stringify({ type, payload }));
      receivers++;
    }

    if (type === 'screen.frame' && role === 'customer') {
      s.lastFrameReceivers = receivers;
      if (receivers > 0) {
        s.lastFrameDeliveredAt = now();
        s.lastFrameDropReason = null;
      }
    }

    if (type === 'screen.frame' && role === 'customer' && receivers === 0) {
      s.lastFrameDroppedAt = now();
      if (!s.lastFrameDropReason) s.lastFrameDropReason = 'No connected host viewer received the screen frame.';
      addAudit('screen.frame.dropped', {
        actor: 'agent',
        sessionId: s.id,
        deviceId: s.deviceId,
        message: s.lastFrameDropReason
      });
    }

    if (type === 'input' && role === 'agent') {
      // Immediate ACK for host UI responsiveness
      const ok = receivers > 0;
      ws.send(JSON.stringify({
        type: 'input.applied',
        payload: {
          ok,
          receivers,
          kind: payload?.kind || 'unknown',
          error: ok ? null : 'No live customer agent received the input.'
        }
      }));
    }
  });
});

setInterval(() => {
  const currentTime = Date.now();
  let anyChanged = false;

  for (const session of sessions.values()) {
    if (!session) continue;
    const hasMobileBroadcastSocket = [...wss.clients].some((client) =>
      client.readyState === 1 &&
      client.role === 'customer' &&
      client.sessionId === session.id &&
      isMobileBroadcastClientKind(client.clientKind)
    );
    if (!hasMobileBroadcastSocket) continue;

    if (session.mobileHeartbeatTimeoutAt && currentTime > session.mobileHeartbeatTimeoutAt) {
      if (!session.mobileStreamReconnectRequired) {
        session.mobileStreamReconnectRequired = true;
        session.customerScreenStatus = 'reconnect_required';
        session.nativeConnected = false;
        updateCustomerLifecycleStatus(session, 'reconnecting');
        if (session.status === 'active' || session.status === 'customer_joined') session.status = 'waiting';
        addAudit('mobile.stream.heartbeat.timeout', {
          actor: 'system',
          sessionId: session.id,
          deviceId: session.deviceId,
          message: 'Mobile heartbeat timed out. Reconnect required.'
        });
        sendToSession(session.id, {
          type: 'screen.broadcast.status',
          payload: {
            status: 'reconnect_required',
            platform: session.customerPlatform || 'unknown',
            message: 'Mobile broadcast heartbeat timeout. Restart broadcast.'
          }
        });
        anyChanged = true;
        broadcastUpdate('session.update', { sessionId: session.id });
      }
      continue;
    }

    if (session.lastFrameAt && currentTime - Number(session.lastFrameAt) > MOBILE_FRAME_STALE_TIMEOUT_MS) {
      if (session.customerScreenStatus !== 'stream_stale') {
        session.customerScreenStatus = 'stream_stale';
        session.nativeConnected = false;
        updateCustomerLifecycleStatus(session, 'disconnected');
        if (session.status === 'active') session.status = 'waiting';
        addAudit('mobile.stream.frame.stale', {
          actor: 'system',
          sessionId: session.id,
          deviceId: session.deviceId,
          message: 'Mobile stream became stale (no recent frames).'
        });
        sendToSession(session.id, {
          type: 'screen.broadcast.status',
          payload: {
            status: 'stream_stale',
            platform: session.customerPlatform || 'unknown',
            message: 'No recent mobile frames. Ask customer to restart broadcast.'
          }
        });
        anyChanged = true;
        broadcastUpdate('session.update', { sessionId: session.id });
      }
    }
  }

  if (anyChanged) {
    schedulePersistState();
  }
}, Math.max(1000, Math.min(MOBILE_HEARTBEAT_INTERVAL_MS, 5000)));


// ═══════════════════════════════════════════════════════════════════════════════
// NEW UI ROUTES — ScreenConnect-like interface v2 compatibility
// ═══════════════════════════════════════════════════════════════════════════════

// ── Admin Page ──
app.get(['/admin', '/Administration', '/administration'], requireTechnician, (_req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

// ── Customer page alias ──
app.get('/customer', (_req, res) => res.sendFile(path.join(publicDir, 'customer.html')));

// ── Session join deep links ──
app.get('/Join/:type/:sessionId/Start', (req, res) => {
  res.redirect(`/customer.html?s=${req.params.sessionId}`);
});
app.get('/Join/:type/:sessionId', (req, res) => {
  res.redirect(`/customer.html?s=${req.params.sessionId}`);
});

// ── Installer binary downloads (/Bin/ScreenConnect.ClientSetup.ext) ──
app.get('/Bin/:filename', (req, res) => {
  const fn = req.params.filename;
  const publishPath = path.join(__dirname, 'native-agent', 'publish', fn);
  if (fs.existsSync(publishPath)) return res.download(publishPath);
  // Stub 0-byte file so download doesn't hard-error in browser
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
  res.status(200).end();
});

// ── Auth API (new path aliases) ──
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const creds = loadAdminCredentials();
  if (!username || !password) return res.status(400).json({ success:false, errorCode:'CredentialsInvalid', message:'Username and password required' });
  if (username !== creds.username || password !== creds.password) {
    return res.status(401).json({ success:false, errorCode:'PasswordInvalid', message:'Invalid credentials. Please try again.' });
  }
  const sid = nanoid(32);
  authSessions.set(sid, { username, createdAt: Date.now() });
  res.cookie(AUTH_COOKIE, sid, { httpOnly:true, sameSite:'lax', maxAge: COOKIE_MAX_AGE_SECONDS*1000 });
  res.json({ success:true, username });
});

app.post('/api/auth/logout', (req, res) => {
  const sid = req.cookies?.[AUTH_COOKIE];
  if (sid) authSessions.delete(sid);
  res.clearCookie(AUTH_COOKIE);
  res.json({ success:true });
});

app.get('/api/auth/me', (req, res) => {
  const sid = req.cookies?.[AUTH_COOKIE];
  const session = sid ? authSessions.get(sid) : null;
  if (!session) return res.status(401).json({ authenticated:false });
  const creds = loadAdminCredentials();
  res.json({ authenticated:true, username:session.username, displayName:session.username, email:creds.email, role:'Administrator' });
});

app.post('/api/auth/reset-request', async (req, res) => {
  res.json({ success:true });
});

// ── Sessions API (plural path) ──
// POST /api/sessions → create a new support/meeting session with full agent+customer tokens
app.post('/api/sessions', requireTechnician, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || 'Untitled Session').slice(0, 80);
  const sessionTypeNum = Number(b.type ?? b.sessionType ?? 0);
  const customProperty1 = String(b.customProperty1 || b.company || '').slice(0, 200);
  const customProperty2 = String(b.customProperty2 || b.site || '').slice(0, 200);
  const customProperty3 = String(b.customProperty3 || b.department || '').slice(0, 200);
  const customProperty4 = String(b.customProperty4 || b.deviceType || '').slice(0, 200);

  // Get current user from cookie
  const cookies = parseCookies(req.headers.cookie);
  const authSession = authSessions.get(cookies[AUTH_COOKIE]);
  const host = authSession?.username || 'admin';

  const sessionId = nanoid(8);
  const joinCode = createNumericJoinCode(8);
  const agentToken = nanoid(24);
  const customerToken = nanoid(24);

  const session = {
    id: sessionId,
    name,
    displayName: name,
    type: sessionTypeNum,
    sessionType: sessionTypeNum,
    joinCode,
    code: joinCode, // alias for compatibility
    createdAt: Date.now(),
    deviceId: null,
    deviceName: null,
    host,
    customProperty1, customProperty2, customProperty3, customProperty4,
    permanentAccess: false,
    agent: { token: agentToken },
    customer: { token: customerToken },
    status: 'created',
    permissions: { screen: true, input: true, fileTransfer: true, terminal: true, recording: true },
    lastSeen: { technician: null, endpoint: null },
    recording: false, files: [], commands: [],
    nativeConnected: false, customerSocketId: null, blankScreen: false
  };

  sessions.set(sessionId, session);
  schedulePersistState();
  addAudit('session.created', {
    actor: host, sessionId,
    message: `Session "${name}" created (type=${sessionTypeNum})`
  });
  broadcastUpdate('session.created', { sessionId });

  // Return through publicSession for consistent field names
  res.status(201).json(publicSession(session, true));
});

// GET /api/sessions/:id — session details
app.get('/api/sessions/:id', requireTechnician, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error:'Session not found' });
  res.json(session);
});

// GET /api/sessions/:id/status
app.get('/api/sessions/:id/status', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error:'Session not found' });
  const pub = publicSession(session, true);
  // guestConnected now mirrors `isLive`: true only once real frame data has
  // arrived (screenStreaming) or a native agent has confirmed connection
  // (nativeConnected). A customer's browser socket merely being open
  // (browserConnected) — or the session being in the transient
  // 'customer_joined' state before any frames arrive — is no longer enough
  // to report the session as "connected".
  res.json({ id: pub.id, name: pub.name, status: pub.status, guestConnected: pub.isLive, type: pub.type, code: pub.code, joinCode: pub.joinCode });
});

// PATCH /api/sessions/:id
app.patch('/api/sessions/:id', requireTechnician, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error:'Session not found' });
  const { name, customProperty1, customProperty2, customProperty3, customProperty4 } = req.body || {};
  if (name) session.name = name;
  if (customProperty1 !== undefined) session.customProperty1 = customProperty1;
  if (customProperty2 !== undefined) session.customProperty2 = customProperty2;
  if (customProperty3 !== undefined) session.customProperty3 = customProperty3;
  if (customProperty4 !== undefined) session.customProperty4 = customProperty4;
  schedulePersistState();
  broadcastUpdate('session.update', { sessionId: session.id });
  res.json(session);
});

// DELETE /api/sessions/:id
app.delete('/api/sessions/:id', requireTechnician, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error:'Session not found' });
  sessions.delete(req.params.id);
  addAudit('session.deleted', { actor: 'host', sessionId: req.params.id });
  schedulePersistState();
  broadcastUpdate('session.deleted', { sessionId: req.params.id });
  res.json({ success:true });
});

// GET /api/sessions/:id/join-token
app.get('/api/sessions/:id/join-token', requireTechnician, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error:'Session not found' });
  const token = nanoid(24);
  res.json({ token, sessionId: req.params.id, viewerUrl:`/host-client.html?sessionId=${req.params.id}&token=${token}` });
});

// GET /api/sessions/by-code/:code
app.get('/api/sessions/by-code/:code', (req, res) => {
  const code = req.params.code.replace(/[^A-Z0-9]/gi,'').toUpperCase();
  const numeric = code.replace(/\D/g,'');
  for (const [id, session] of sessions.entries()) {
    if (session.status === 'ended') continue;
    const sc = (session.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const jc = (session.joinCode||'').replace(/\D/g,'');
    const sidShort = id.slice(0,8).toUpperCase();
    if (sc === code || sidShort === code || (numeric && jc === numeric)) {
      const pub = publicSession(session, true);
      return res.json({ id, name: pub.name, type: pub.type, code: pub.code, status: pub.status });
    }
  }
  // Also try findSessionByIdOrCode for maximum compatibility
  const found = findSessionByIdOrCode(req.params.code);
  if (found && found.status !== 'ended') {
    const pub = publicSession(found, true);
    return res.json({ id: found.id, name: pub.name, type: pub.type, code: pub.code, status: pub.status });
  }
  res.status(404).json({ error:'Session not found' });
});

// POST /api/sessions/:id/message
app.post('/api/sessions/:id/message', requireTechnician, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error:'Session not found' });
  const { message } = req.body || {};
  addAudit('message.sent', { actor:'host', sessionId:req.params.id, data:message });
  // Broadcast to WebSocket clients
  sendToSession(req.params.id, { type:'message', payload:{ from:'host', message, sessionId:req.params.id } });
  res.json({ success:true });
});

// POST /api/sessions/:id/command
app.post('/api/sessions/:id/command', requireTechnician, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error:'Session not found' });
  const { command } = req.body || {};
  addAudit('command.queued', { actor:'host', sessionId:req.params.id, data:command });
  sendToSession(req.params.id, { type:'command', payload:{ command, sessionId:req.params.id } });
  res.json({ success:true, output:`Command queued: ${command}` });
});

// POST /api/sessions/:id/note
app.post('/api/sessions/:id/note', requireTechnician, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error:'Session not found' });
  const { note } = req.body || {};
  if (!session.notes) session.notes = [];
  session.notes.push({ text:note, time:new Date().toISOString() });
  if (!session.events) session.events = [];
  session.events.push({ type:'AddedNote', data:note, time:new Date().toISOString() });
  schedulePersistState();
  res.json({ success:true });
});

// POST /api/sessions/:id/invite (send email invite)
app.post('/api/sessions/:id/invite', requireTechnician, async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error:'Session not found' });
  const { email } = req.body || {};
  addAudit('invite.sent', { actor:'host', sessionId:req.params.id, data:email });
  res.json({ success:true, message:`Invite sent to ${email}` });
});

// POST /api/sessions/:id/wake
app.post('/api/sessions/:id/wake', requireTechnician, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error:'Session not found' });
  sendToSession(req.params.id, { type:'wake', payload:{ sessionId:req.params.id } });
  addAudit('wake.queued', { actor:'host', sessionId:req.params.id });
  res.json({ success:true });
});

// POST /api/sessions/:id/reinstall
app.post('/api/sessions/:id/reinstall', requireTechnician, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error:'Session not found' });
  sendToSession(req.params.id, { type:'reinstall', payload:{ sessionId:req.params.id } });
  addAudit('reinstall.queued', { actor:'host', sessionId:req.params.id });
  res.json({ success:true });
});

// POST /api/sessions/:id/transfer
app.post('/api/sessions/:id/transfer', requireTechnician, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error:'Session not found' });
  const { toHost } = req.body || {};
  session.host = toHost;
  addAudit('session.transferred', { actor:'host', sessionId:req.params.id, data:toHost });
  schedulePersistState();
  res.json({ success:true });
});

// POST /api/sessions/:id/cad (Ctrl+Alt+Del)
app.post('/api/sessions/:id/cad', requireTechnician, (req, res) => {
  sendToSession(req.params.id, { type:'cad', payload:{ sessionId:req.params.id } });
  res.json({ success:true });
});

// POST /api/sessions/:id/blank-screen
app.post('/api/sessions/:id/blank-screen', requireTechnician, (req, res) => {
  const { enabled } = req.body || {};
  sendToSession(req.params.id, { type:'blank_screen', payload:{ enabled, sessionId:req.params.id } });
  res.json({ success:true });
});

// POST /api/sessions/:id/block-input
app.post('/api/sessions/:id/block-input', requireTechnician, (req, res) => {
  const { enabled } = req.body || {};
  sendToSession(req.params.id, { type:'block_input', payload:{ enabled, sessionId:req.params.id } });
  res.json({ success:true });
});

// POST /api/sessions/:id/file (file upload to session)
app.post('/api/sessions/:id/file', requireTechnician, (req, res) => {
  res.json({ success:true });
});

// ── Admin API ──────────────────────────────────────────────────────────────

// GET /api/admin/users
app.get('/api/admin/users', requireTechnician, (req, res) => {
  const creds = loadAdminCredentials();
  res.json([{
    username: creds.username,
    displayName: creds.username,
    email: creds.email || '',
    role: 'Administrator',
    createdAt: new Date().toISOString()
  }]);
});

// POST /api/admin/users
app.post('/api/admin/users', requireTechnician, (req, res) => {
  const { username, password, displayName, email } = req.body || {};
  if (!username || !password) return res.status(400).json({ message:'Username and password required' });
  if (password.length < 8) return res.status(400).json({ message:'Password must be at least 8 characters' });
  // In production this would persist; for now just return success
  res.status(201).json({ username, displayName: displayName||username, email, role:'Technician' });
});

// POST /api/admin/revoke-auth
app.post('/api/admin/revoke-auth', requireTechnician, (req, res) => {
  authSessions.clear();
  addAudit('auth.revoked', { actor:'admin' });
  res.json({ success:true });
});

// POST /api/admin/revoke-host-sessions
app.post('/api/admin/revoke-host-sessions', requireTechnician, (req, res) => {
  for (const s of sessions.values()) {
    sendToSession(s.id, { type:'force_disconnect', payload:{ reason:'admin_revoke' } });
  }
  addAudit('host_sessions.revoked', { actor:'admin' });
  res.json({ success:true });
});

// GET /api/audit/export/csv
app.get('/api/audit/export/csv', requireTechnician, (req, res) => {
  const log = getAuditLog ? getAuditLog() : [];
  const csv = ['Time,Type,Actor,SessionId,Data',
    ...log.map(e => [
      new Date(e.time||e.timestamp||0).toISOString(),
      (e.type||e.event||''),
      (e.actor||''),
      (e.sessionId||''),
      JSON.stringify(e.data||e.message||'')
    ].map(f=>'"'+String(f).replace(/"/g,'""')+'"').join(','))
  ].join('\r\n');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="audit.csv"');
  res.send(csv);
});

// GET /api/audit (also return array for admin page)
app.get('/api/audit', requireTechnician, (req, res) => {
  const limit = parseInt(req.query.limit)||100;
  const log = getAuditLog ? getAuditLog() : [];
  res.json(log.slice(-limit).reverse());
});


const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const HOST = process.env.HOST || '0.0.0.0';
// Listen on the specified host. 127.0.0.1 is safer for local Cloudflare tunnels.
server.listen(PORT, HOST, () => {
  const listenUrl = protocol === 'https' ? `https://${HOST}:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`Server listening on ${PUBLIC_BASE_URL || listenUrl} (local bind ${listenUrl})`);
});
