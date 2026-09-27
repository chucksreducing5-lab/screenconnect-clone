/*
 Mobile broadcast + web-security tests.
 Verifies: /api/healthz, CSP/X-Frame/Permissions headers, Secure cookie on https,
 CORS/CSRF origin guard, and that Android + iOS mobile-broadcast screen.frame
 messages are relayed to the host viewer (and flip the session to active).
 Run: node tests/mobile_security_test.cjs
*/
const http = require('http');
const WebSocket = require('ws');

const HOST = 'localhost';
const PORT = 9099;
const WS_BASE = `ws://${HOST}:${PORT}`;

const results = [];
function record(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${info ? ' :: ' + info : ''}`);
}

function req(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = Object.assign({}, headers);
    if (data && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: HOST, port: PORT, method, path, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function openWs(url) {
  const ws = new WebSocket(url);
  const messages = [];
  ws.on('message', (m) => { let d = null; try { d = JSON.parse(m.toString()); } catch {} messages.push({ raw: m.toString().slice(0, 120), data: d }); });
  const ready = new Promise((resolve) => { ws.on('open', () => resolve(true)); ws.on('error', () => resolve(false)); });
  function waitFor(pred, timeout = 4000) {
    return new Promise((resolve) => {
      const existing = messages.find((m) => pred(m));
      if (existing) return resolve(existing);
      const t = setTimeout(() => resolve(null), timeout);
      ws.on('message', (m) => { let d = null; try { d = JSON.parse(m.toString()); } catch {} const item = { raw: m.toString().slice(0, 120), data: d }; if (pred(item)) { clearTimeout(t); resolve(item); } });
    });
  }
  return { ws, messages, ready, waitFor, send: (obj) => ws.send(JSON.stringify(obj)), close: () => { try { ws.close(); } catch {} } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---------- Health endpoint ----------
  {
    const r = await req('GET', '/api/healthz');
    record('healthz ok', r.status === 200 && r.json?.ok === true, `status=${r.status}`);
    record('healthz reports rate limiter mode', ['redis', 'memory'].includes(r.json?.rateLimiter), `rateLimiter=${r.json?.rateLimiter} redis=${r.json?.redisConnected}`);
  }

  // ---------- XSS / clickjacking headers ----------
  {
    const r = await req('GET', '/api/config', { headers: { 'X-Forwarded-Proto': 'https' } });
    const csp = r.headers['content-security-policy'] || '';
    record('CSP present with frame-ancestors none', csp.includes("frame-ancestors 'none'"), `csp=${csp.slice(0, 60)}...`);
    record('X-Frame-Options DENY', r.headers['x-frame-options'] === 'DENY', `val=${r.headers['x-frame-options']}`);
    record('Permissions-Policy allows display-capture self', String(r.headers['permissions-policy'] || '').includes('display-capture=(self)'), `val=${r.headers['permissions-policy']}`);
  }

  // ---------- Secure cookie on https ----------
  {
    const r = await req('POST', '/api/login', { headers: { 'X-Forwarded-Proto': 'https', Origin: 'https://helpsupport.top' }, body: { username: 'admin', password: 'admin' } });
    const setCookie = String(r.headers['set-cookie'] || '');
    record('auth cookie has Secure on https', /Secure/i.test(setCookie), `cookie=${setCookie}`);
    record('auth cookie HttpOnly + SameSite=Lax', /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), '');
  }

  // ---------- CSRF / CORS origin guard ----------
  {
    const evil = await req('POST', '/api/session/00000000/join', { headers: { Origin: 'https://evil.example' }, body: {} });
    record('CSRF: disallowed Origin blocked (403)', evil.status === 403, `status=${evil.status}`);
    const good = await req('POST', '/api/session/00000000/join', { headers: { Origin: 'https://helpsupport.top' }, body: {} });
    record('CSRF: allowed Origin not blocked', good.status !== 403, `status=${good.status}`);
    const native = await req('POST', '/api/session/00000000/join', { body: {} });
    record('CSRF: no Origin (native app) not blocked', native.status !== 403, `status=${native.status}`);
  }

  // ---------- Mobile broadcast E2E (Android + iOS) ----------
  async function mobileFrameReachesHost(clientKind, platformLabel) {
    // fresh session
    const login = await req('POST', '/api/login', { headers: { Origin: 'https://helpsupport.top' }, body: { username: 'admin', password: 'admin' } });
    const cookie = String(login.headers['set-cookie'] || '').split(';')[0];
    const create = await req('POST', '/api/session/create', { headers: { Cookie: cookie, Origin: 'https://helpsupport.top' }, body: {} });
    const sid = create.json?.sessionId; const agentToken = create.json?.agentPortalToken; const custToken = create.json?.customerJoinToken;
    if (!sid) { record(`${platformLabel}: session created`, false, JSON.stringify(create.json)); return; }

    const agent = openWs(`${WS_BASE}/?role=agent&sessionId=${sid}&client=host-viewer&token=${encodeURIComponent(agentToken)}`);
    const agentUp = await agent.ready;
    record(`${platformLabel}: host viewer WS connects`, agentUp === true);

    const cust = openWs(`${WS_BASE}/?role=customer&sessionId=${sid}&client=${clientKind}&token=${encodeURIComponent(custToken)}`);
    const custUp = await cust.ready;
    record(`${platformLabel}: mobile broadcast WS connects (${clientKind})`, custUp === true);

    await sleep(300);
    // Send a screen frame from the mobile broadcaster.
    cust.send({ type: 'screen.frame', payload: { sequence: 1, format: 'jpeg', width: 1170, height: 2532, image: 'data:image/jpeg;base64,/9j/AAQSkZJRg==' } });

    const got = await agent.waitFor((m) => m.data?.type === 'screen.frame', 4000);
    record(`${platformLabel}: screen.frame relayed to host viewer`, !!got, got ? `seq=${got.data?.payload?.sequence}` : 'no frame received');

    // Confirm session flipped to active via troubleshooting (Bearer token auth).
    const ts = await req('GET', `/api/session/${sid}/troubleshooting`, { headers: { Authorization: `Bearer ${custToken}` } });
    const active = ts.json?.session?.nativeConnected === true || ts.json?.nativeConnected === true || /active|sending_frames|connected/i.test(JSON.stringify(ts.json || {}));
    record(`${platformLabel}: session marked active after first frame`, active, `status=${ts.status}`);

    cust.close(); agent.close();
    await sleep(200);
  }

  await mobileFrameReachesHost('android-mobile-broadcast', 'Android');
  await mobileFrameReachesHost('ios-mobile-broadcast', 'iOS');
  await mobileFrameReachesHost('mobile-broadcast', 'Generic-mobile');

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n===== ${passed}/${results.length} passed =====`);
  process.exit(passed === results.length ? 0 : 1);
})();
