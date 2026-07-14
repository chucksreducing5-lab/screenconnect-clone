# Production deployment for helpsupport.top

The current Windows + Cloudflare Tunnel setup only works while that computer is powered on and connected. A domain cannot keep the app alive by itself; `helpsupport.top` needs to point to a server that stays online.

Use a small VPS or cloud VM. A 1 CPU / 1 GB RAM Ubuntu server is enough for this MVP. Keep your Windows computer only for development and testing.

## Target setup

- `helpsupport.top` and `www.helpsupport.top` point to the VPS public IP.
- The live site is now served from that VPS IP/Caddy HTTPS path, not from the old local Windows tunnel.
- Node runs `server.js` as a `systemd` service.
- Caddy handles HTTPS certificates and reverse proxies to `127.0.0.1:3001`.
- Native agents and customer links use `https://www.helpsupport.top`.

## 1. DNS

In Cloudflare or your DNS provider, set:

```text
A     helpsupport.top       <VPS_PUBLIC_IP>
A     www.helpsupport.top   <VPS_PUBLIC_IP>
```

If using Cloudflare, start with the records set to DNS only while testing. After it works, Cloudflare proxy mode can be enabled.

Remove or ignore the old local/quick Cloudflare Tunnel for production. A tunnel running on your Windows computer still goes offline when the computer shuts down.

## 2. Install server packages

On the VPS:

```bash
sudo apt update
sudo apt install -y nodejs npm git caddy
```

Node 20 LTS is preferred. If the OS package is older, install Node from NodeSource or your cloud provider image.

## 3. Upload the app

Put the project at `/opt/remotesupport-web`. Example:

```bash
sudo mkdir -p /opt/remotesupport-web
sudo chown "$USER":"$USER" /opt/remotesupport-web
git clone <your-repo-url> /opt/remotesupport-web
cd /opt/remotesupport-web
npm ci
```

If you do not use git, copy this whole folder to `/opt/remotesupport-web`, then run `npm ci` there.

## 4. Configure environment

```bash
sudo cp /opt/remotesupport-web/deploy/production.env.example /etc/remotesupport-web.env
sudo nano /etc/remotesupport-web.env
sudo chmod 600 /etc/remotesupport-web.env
```

Set a real `TECH_PASSWORD`. Keep:

```text
PUBLIC_BASE_URL=https://www.helpsupport.top
DOWNLOAD_BASE_URL=https://www.helpsupport.top
```

## 5. Install the service

Fast path:

```bash
cd /opt/remotesupport-web
sudo bash deploy/install-ubuntu-production.sh
```

Manual path:

```bash
sudo useradd --system --home /opt/remotesupport-web --shell /usr/sbin/nologin remotesupport || true
sudo chown -R remotesupport:remotesupport /opt/remotesupport-web
sudo cp /opt/remotesupport-web/deploy/remotesupport-web.service /etc/systemd/system/remotesupport-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now remotesupport-web
sudo systemctl status remotesupport-web
```

Check the local app:

```bash
curl http://127.0.0.1:3001/health
```

## 6. Enable HTTPS

```bash
sudo cp /opt/remotesupport-web/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Check public reachability:

```bash
curl https://www.helpsupport.top/health
```

## 7. Update native clients

Build or install the native service/agent using:

```text
https://www.helpsupport.top
```

Any old installer or agent that was created with a temporary/local URL should be replaced.

## Useful commands

```bash
sudo systemctl restart remotesupport-web
sudo journalctl -u remotesupport-web -f
sudo systemctl status caddy
sudo journalctl -u caddy -f
```

## Important limitation

This keeps the remote-support website available when your own computer is shut down. It does not keep customer computers online after they shut down. A customer endpoint still must be powered on and connected for unattended remote support.
