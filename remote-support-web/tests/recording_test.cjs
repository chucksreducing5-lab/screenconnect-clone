/*
 Recording (session replay) E2E test.
 login -> create session -> start recording -> mobile broadcaster sends frames
 -> stop recording -> recordings list/meta/frames endpoints return the frames.
 Run: node tests/recording_test.cjs
*/
const http = require('http');
const WebSocket = require('ws');

const HOST = 'localhost';
const PORT = 9099;
const WS_BASE = `ws://${HOST}:${PORT}`;
const results = [];
function record(n, ok, info = '') { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} :: ${n}${info ? ' :: ' + info : ''}`); }

function req(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers);
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: HOST, port: PORT, method, path, headers: h }, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const login = await req('POST', '/api/login', { headers: { Origin: 'https://helpsupport.top' }, body: { username: 'admin', password: 'admin' } });
  const cookie = String(login.headers['set-cookie'] || '').split(';')[0];
  record('technician login', login.status === 200 && !!cookie);

  const create = await req('POST', '/api/session/create', { headers: { Cookie: cookie, Origin: 'https://helpsupport.top' }, body: {} });
  const sid = create.json?.sessionId; const custToken = create.json?.customerJoinToken; const agentToken = create.json?.agentPortalToken;
  record('session created', !!sid, `sid=${sid}`);

  const rec = await req('POST', `/api/session/${sid}/recording`, { headers: { Cookie: cookie, Origin: 'https://helpsupport.top' }, body: { recording: true } });
  record('recording started', rec.status === 200 && rec.json?.recording === true);

  const agent = new WebSocket(`${WS_BASE}/?role=agent&sessionId=${sid}&client=host-viewer&token=${encodeURIComponent(agentToken)}`);
  await new Promise((r) => { agent.on('open', r); agent.on('error', r); });
  const cust = new WebSocket(`${WS_BASE}/?role=customer&sessionId=${sid}&client=android-mobile-broadcast&token=${encodeURIComponent(custToken)}`);
  await new Promise((r) => { cust.on('open', r); cust.on('error', r); });
  await sleep(200);

  const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
  for (let i = 1; i <= 3; i++) {
    cust.send(JSON.stringify({ type: 'screen.frame', payload: { sequence: i, width: 1170, height: 2532, image: img } }));
    await sleep(120);
  }
  await sleep(300);

  const stop = await req('POST', `/api/session/${sid}/recording`, { headers: { Cookie: cookie, Origin: 'https://helpsupport.top' }, body: { recording: false } });
  record('recording stopped', stop.status === 200 && stop.json?.recording === false);

  const list = await req('GET', '/api/recordings', { headers: { Cookie: cookie } });
  const found = Array.isArray(list.json) && list.json.find((r) => r.sessionId === sid);
  record('recording appears in list', !!found, found ? `frames=${found.frameCount}` : 'not found');

  const meta = await req('GET', `/api/recordings/${sid}`, { headers: { Cookie: cookie } });
  record('recording meta frameCount >= 3', (meta.json?.frameCount || 0) >= 3, `frameCount=${meta.json?.frameCount}`);

  const frames = await req('GET', `/api/recordings/${sid}/frames?from=0&limit=10`, { headers: { Cookie: cookie } });
  const ok = frames.json?.total >= 3 && frames.json?.frames?.[0]?.image?.startsWith('data:image');
  record('frames endpoint returns image data', ok, `total=${frames.json?.total}`);

  const noauth = await req('GET', '/api/recordings');
  record('recordings require technician auth (401/redirect)', noauth.status === 401 || noauth.status === 302, `status=${noauth.status}`);

  // cleanup
  await req('DELETE', `/api/recordings/${sid}`, { headers: { Cookie: cookie } });
  try { agent.close(); cust.close(); } catch {}

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n===== ${passed}/${results.length} passed =====`);
  process.exit(passed === results.length ? 0 : 1);
})();
