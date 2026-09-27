/*
 Hardening tests for J-3, J-4, WS authz, rate limit and regression.
 Run: node tests/hardening_test.cjs
*/
const http = require('http');
const WebSocket = require('ws');

const HOST = 'localhost';
const PORT = 9099;
const BASE = `http://${HOST}:${PORT}`;
const WS_BASE = `ws://${HOST}:${PORT}`;

const results = [];
function record(name, ok, info='') {
  results.push({name, ok, info});
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${info?' :: '+info:''}`);
}

function req(method, path, {headers={}, body=null, cookie=null}={}) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body==='string'?body:JSON.stringify(body)) : null;
    const h = Object.assign({}, headers);
    if (data && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    if (cookie) h['Cookie'] = cookie;
    const r = http.request({host:HOST, port:PORT, method, path, headers:h}, (res) => {
      let buf='';
      res.on('data', c => buf+=c);
      res.on('end', () => {
        let json=null; try{json=JSON.parse(buf);}catch{}
        resolve({status:res.statusCode, headers:res.headers, body:buf, json});
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function wsConnect(url, opts={}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts.subprotocols || undefined, opts.wsOpts || {});
    const events = [];
    let openTimer = setTimeout(() => { try{ws.close();}catch{}; resolve({opened:false, events, closeCode:null, closeReason:'timeout'}); }, 5000);
    ws.on('open', () => events.push({type:'open'}));
    ws.on('message', (m) => {
      let d=null; try{d=JSON.parse(m.toString());}catch{}
      events.push({type:'message', raw:m.toString().slice(0,200), data:d});
      if (opts.closeOnMessage) { try{ws.close();}catch{} }
    });
    ws.on('error', (e) => events.push({type:'error', msg:e.message}));
    ws.on('close', (code, reason) => {
      clearTimeout(openTimer);
      resolve({opened: events.some(e=>e.type==='open'), events, closeCode:code, closeReason:reason?.toString?.()||''});
    });
    // Auto-close after 3s if not closed
    setTimeout(() => { try{ws.close();}catch{} }, opts.timeout || 3000);
  });
}

(async () => {
  // ---------- J-4a HSTS + security headers ----------
  {
    const r = await req('GET', '/api/config', {headers:{'X-Forwarded-Proto':'https'}});
    const hsts = r.headers['strict-transport-security'];
    const nosniff = r.headers['x-content-type-options'];
    const refpol = r.headers['referrer-policy'];
    record('J-4a HSTS present on https', hsts === 'max-age=31536000; includeSubDomains; preload', `hsts=${hsts}`);
    record('J-4a X-Content-Type-Options nosniff', nosniff === 'nosniff', `val=${nosniff}`);
    record('J-4a Referrer-Policy no-referrer', refpol === 'no-referrer', `val=${refpol}`);
  }
  {
    const r = await req('GET', '/api/config');
    const hsts = r.headers['strict-transport-security'];
    const nosniff = r.headers['x-content-type-options'];
    const refpol = r.headers['referrer-policy'];
    record('J-4a HSTS absent on plain http', !hsts, `hsts=${hsts}`);
    record('J-4a nosniff still present on http', nosniff === 'nosniff');
    record('J-4a referrer still present on http', refpol === 'no-referrer');
  }

  // ---------- J-4b diagnostics removed ----------
  {
    const r = await req('POST', '/api/session/BADCODE/join', {body:{}});
    const has404 = r.status === 404;
    const codeOk = r.json && r.json.code === 'SESSION_NOT_FOUND';
    const noDiag = r.json && !('diagnostics' in r.json);
    record('J-4b join bad code 404', has404, `status=${r.status}`);
    record('J-4b SESSION_NOT_FOUND code', !!codeOk, `body=${r.body.slice(0,200)}`);
    record('J-4b no diagnostics field', !!noDiag);
  }

  // ---------- Login for regression + technician cookie ----------
  const loginRes = await req('POST', '/api/login', {body:{username:'admin', password:'admin'}});
  record('login admin/admin 200', loginRes.status === 200, `status=${loginRes.status}`);
  const setCookie = loginRes.headers['set-cookie'] || [];
  const cookieHeader = setCookie.map(c=>c.split(';')[0]).join('; ');

  // ---------- Create session (as tech) ----------
  const createRes = await req('POST', '/api/session/create', {cookie:cookieHeader, body:{}});
  record('session/create 200', createRes.status === 200, `status=${createRes.status} body=${createRes.body.slice(0,200)}`);
  const session = createRes.json || {};
  const sid = session.sessionId || session.id;
  const joinCode = session.joinCode || session.code;
  const customerToken = session.customerJoinToken || session.customerToken || session.joinToken;
  console.log('session:', {sid, joinCode, customerTokenLen: customerToken?.length});

  // ---------- Join via code ----------
  const joinRes = await req('POST', `/api/session/${joinCode}/join`, {body:{}});
  record('customer join ok', joinRes.status === 200 && joinRes.json && joinRes.json.ok === true, `status=${joinRes.status} body=${joinRes.body.slice(0,200)}`);
  const joinToken = (joinRes.json && (joinRes.json.customerJoinToken || joinRes.json.joinToken || joinRes.json.token)) || customerToken;
  console.log('joinToken length:', joinToken?.length);

  // ---------- J-3 WS subprotocol connect ----------
  if (sid && joinToken) {
    const url = `${WS_BASE}/?role=customer&client=browser-broadcast&sessionId=${sid}`;
    const r = await wsConnect(url, {subprotocols:[`cp.token.${joinToken}`], timeout:4000});
    const gotReady = r.events.some(e => e.type==='message' && e.data && e.data.type === 'session.ready');
    record('J-3 WS subprotocol -> session.ready', r.opened && gotReady, `opened=${r.opened} events=${r.events.map(e=>e.type+(e.data?.type?':'+e.data.type:'')).join(',')}`);
  } else {
    record('J-3 WS subprotocol -> session.ready', false, 'missing sid/token');
  }

  // ---------- J-3 legacy ?token= fallback ----------
  if (sid && joinToken) {
    const url = `${WS_BASE}/?role=customer&client=browser-broadcast&sessionId=${sid}&token=${encodeURIComponent(joinToken)}`;
    const r = await wsConnect(url, {timeout:4000});
    const gotReady = r.events.some(e => e.type==='message' && e.data && e.data.type === 'session.ready');
    record('J-3 legacy ?token= still works', r.opened && gotReady, `opened=${r.opened} closeCode=${r.closeCode}`);
  }

  // ---------- J-3 REST customer-status ----------
  if (sid && joinToken) {
    const r1 = await req('GET', `/api/session/${sid}/customer-status`, {headers:{'Authorization':`Bearer ${joinToken}`}});
    record('J-3 customer-status Bearer 200', r1.status === 200, `status=${r1.status}`);
    const r2 = await req('GET', `/api/session/${sid}/customer-status`);
    record('J-3 customer-status noauth 401', r2.status === 401, `status=${r2.status}`);

    const r3 = await req('GET', `/api/session/${sid}/troubleshooting`, {headers:{'Authorization':`Bearer ${joinToken}`}});
    record('J-3 troubleshooting Bearer 2xx', r3.status >= 200 && r3.status < 300, `status=${r3.status}`);
    const r4 = await req('GET', `/api/session/${sid}/troubleshooting`);
    record('J-3 troubleshooting noauth 401', r4.status === 401, `status=${r4.status}`);
  }

  // ---------- Global-channel WS authorization ----------
  {
    const r = await wsConnect(`${WS_BASE}/?role=agent&sessionId=global`, {timeout:3000});
    const gotAuthErr = r.events.some(e => e.type==='message' && (String(e.raw||'').includes('Technician login required') || (e.data && String(e.data.message||e.data.error||'').includes('Technician login required'))));
    record('global WS rejected without cookie (1008)', r.closeCode === 1008, `closeCode=${r.closeCode}`);
    record('global WS emits Technician login required', gotAuthErr, `events=${r.events.map(e=>e.raw||e.type).join('|').slice(0,200)}`);
  }
  {
    const r = await wsConnect(`${WS_BASE}/?role=agent&sessionId=global`, {timeout:3000, wsOpts:{headers:{Cookie: cookieHeader}}});
    record('global WS allowed with tech cookie', r.opened && r.closeCode !== 1008, `opened=${r.opened} closeCode=${r.closeCode}`);
  }

  // ---------- Rate limiting ----------
  {
    const bursts = [];
    for (let i=0;i<15;i++) bursts.push(req('POST','/api/login',{body:{username:'nope',password:'nope'}}));
    const rs = await Promise.all(bursts);
    const got429 = rs.some(r => r.status === 429);
    record('rate-limit /api/login -> 429', got429, `statuses=${rs.map(r=>r.status).join(',')}`);
  }
  {
    const bursts = [];
    for (let i=0;i<25;i++) bursts.push(req('POST','/api/session/BADCODE/join',{body:{}}));
    const rs = await Promise.all(bursts);
    const got429 = rs.some(r => r.status === 429);
    record('rate-limit /api/session/:id/join -> 429', got429, `statuses=${rs.map(r=>r.status).slice(0,30).join(',')}`);
  }

  // ---------- Static pages regression ----------
  {
    const r1 = await req('GET','/customer');
    const r2 = await req('GET','/login');
    record('/customer 200', r1.status === 200, `status=${r1.status}`);
    record('/login 200', r2.status === 200, `status=${r2.status}`);
  }

  // ---------- Summary ----------
  const passed = results.filter(r=>r.ok).length;
  const total = results.length;
  console.log(`\n===== ${passed}/${total} passed =====`);
  const fails = results.filter(r=>!r.ok);
  if (fails.length) {
    console.log('Failures:');
    fails.forEach(f => console.log(` - ${f.name} :: ${f.info}`));
  }
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
