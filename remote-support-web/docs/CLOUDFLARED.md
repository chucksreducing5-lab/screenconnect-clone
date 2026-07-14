# Expose local server via Cloudflare Tunnel (cloudflared)

This guide shows how to expose your local `remote-support-web` server running on
port `3001` as `helpsupport.top` using Cloudflare Tunnel (cloudflared). It is
for local/dev testing only. If the live site is already on the VPS public IP,
use the VPS/Caddy setup in `deploy/PRODUCTION.md` and remove the old local
Windows tunnel from the production path.

Prerequisites
- A registered domain `helpsupport.top` added to your Cloudflare account.
- `cloudflared` CLI installed on the host running this server.

Quick one-liner (temporary tunnel, good for testing):

  cloudflared tunnel --url http://localhost:3001 --hostname helpsupport.top

This will open a tunnel and create a DNS CNAME for `helpsupport.top` in your
Cloudflare account (you will be prompted to login during this process).

Persistent tunnel (recommended)
1. Login and create a tunnel credential file (only required once):

  cloudflared login

2. Create a named tunnel:

  cloudflared tunnel create remote-support-tunnel

3. Create a config file at `/etc/cloudflared/config.yml` or in this repo
   (example below) and replace `<TUNNEL-UUID>` with the value printed when
   you created the tunnel.

Sample config (repo copy: `.cloudflared/config.yml`):

  tunnel: <TUNNEL-UUID>
  credentials-file: /root/.cloudflared/<TUNNEL-UUID>.json

  ingress:
    - hostname: helpsupport.top
      service: https://localhost:3001
    - service: http_status:404

Notes
- The `service` uses `https://localhost:3001` to ensure the origin connection
  is HTTPS; if your local server is not configured for HTTPS, use `http://localhost:3001`.
- If using HTTP origin, be mindful of proxies that may strip WebSocket upgrade
  headers; prefer `https` origin when possible.

Run the tunnel as a system service (example with systemd):

  cloudflared service install --config /etc/cloudflared/config.yml

Or run interactively (useful for debugging):

  cloudflared tunnel run --config /etc/cloudflared/config.yml remote-support-tunnel

Verification
- After the tunnel is running, visit `https://helpsupport.top` in a browser and
  confirm it reaches your local app. The server logs should show requests and
  the `test-e2e.js` script should run successfully against the public URL.
