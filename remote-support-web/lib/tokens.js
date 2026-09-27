// Session-token extraction helpers, kept out of URLs where possible.
// REST: prefer Authorization: Bearer, then X-Session-Token header, then legacy ?token=.
// WS:   prefer the Sec-WebSocket-Protocol subprotocol (cp.token.<token>), then legacy ?token=.

export function getReqToken(req) {
  const auth = String(req.headers?.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return (req.query && req.query.token) || (req.headers && req.headers['x-session-token']) || '';
}

export function extractWsToken(req, url) {
  const proto = String(req.headers['sec-websocket-protocol'] || '');
  for (const p of proto.split(',').map((s) => s.trim())) {
    if (p.startsWith('cp.token.')) return p.slice('cp.token.'.length);
  }
  return url.searchParams.get('token');
}
