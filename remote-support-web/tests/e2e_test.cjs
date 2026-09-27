// E2E regression test for ScreenConnect Node app
const http = require('http');
const WebSocket = require('ws');

const BASE = 'http://localhost:9099';

function request(method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  let pass = 0, fail = 0;
  const check = (label, cond, extra='') => {
    if (cond) { console.log(`PASS ${label}`); pass++; }
    else { console.log(`FAIL ${label} ${extra}`); fail++; }
  };

  // 1) login
  const login = await request('POST', '/api/login', { body: { username: 'admin', password: 'admin' } });
  check('login 200', login.status === 200, `status=${login.status}`);
  const setCookie = login.headers['set-cookie'];
  check('login set-cookie', Array.isArray(setCookie) && setCookie.length > 0);
  const cookie = (setCookie || []).map(c => c.split(';')[0]).join('; ');

  // 2) create session
  const create = await request('POST', '/api/session/create', { cookie, body: {} });
  check('session create 200', create.status === 200, `status=${create.status} body=${create.body.slice(0,200)}`);
  let cj = {};
  try { cj = JSON.parse(create.body); } catch {}
  check('has sessionId', !!cj.sessionId);
  check('has joinCode', !!cj.joinCode);
  check('has customerJoinToken', !!cj.customerJoinToken);
  console.log('  joinCode=', cj.joinCode, 'sessionId=', cj.sessionId);

  // 3) join
  const join = await request('POST', `/api/session/${cj.joinCode}/join`, { body: {} });
  check('join 200', join.status === 200, `status=${join.status} body=${join.body.slice(0,200)}`);
  let jj = {};
  try { jj = JSON.parse(join.body); } catch {}
  check('join ok:true', jj.ok === true);
  check('join returns sessionId', jj.sessionId === cj.sessionId);
  check('join returns customerJoinToken', !!jj.customerJoinToken);

  // 4) invalid join code -> 404 SESSION_NOT_FOUND
  const bad = await request('POST', '/api/session/00000000/join', { body: {} });
  check('invalid join 404', bad.status === 404, `status=${bad.status}`);
  let bj = {};
  try { bj = JSON.parse(bad.body); } catch {}
  check('invalid join code SESSION_NOT_FOUND', bj.code === 'SESSION_NOT_FOUND', `body=${bad.body.slice(0,200)}`);

  // 5) customer WS receives session.ready with customer_joined
  const wsUrl = `ws://localhost:9099/?role=customer&client=browser-broadcast&sessionId=${encodeURIComponent(jj.sessionId)}&token=${encodeURIComponent(jj.customerJoinToken)}`;
  await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let gotReady = false;
    const t = setTimeout(() => {
      check('customer WS session.ready customer_joined', gotReady, 'timeout');
      try { ws.close(); } catch {}
      resolve();
    }, 5000);
    ws.on('open', () => console.log('  WS open'));
    ws.on('message', (data) => {
      let msg = {};
      try { msg = JSON.parse(data.toString()); } catch {}
      console.log('  WS msg:', msg.type, msg.payload?.status || '');
      if (msg.type === 'session.ready' && msg.payload?.status === 'customer_joined') {
        gotReady = true;
        clearTimeout(t);
        check('customer WS session.ready customer_joined', true);
        try { ws.close(); } catch {}
        resolve();
      }
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      check('customer WS session.ready customer_joined', false, `wserr=${e.message}`);
      resolve();
    });
  });

  console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
