#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/remotesupport-web}"
ENV_FILE="${ENV_FILE:-/etc/remotesupport-web.env}"
APP_USER="${APP_USER:-remotesupport}"
DOMAIN="${DOMAIN:-www.helpsupport.top}"
APEX_DOMAIN="${APEX_DOMAIN:-helpsupport.top}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://${DOMAIN}}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/install-ubuntu-production.sh" >&2
  exit 1
fi

if [[ ! -f "${APP_DIR}/server.js" ]]; then
  echo "server.js not found at ${APP_DIR}." >&2
  echo "Copy or clone the project to ${APP_DIR}, then run this script again." >&2
  exit 1
fi

echo "[remote-support] Installing OS packages"
apt-get update
apt-get install -y ca-certificates curl gnupg git caddy

if ! command -v node >/dev/null 2>&1; then
  echo "[remote-support] Installing Node.js 20"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi

echo "[remote-support] Creating service user"
useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}" 2>/dev/null || true

echo "[remote-support] Installing Node dependencies"
cd "${APP_DIR}"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[remote-support] Writing ${ENV_FILE}"
  install -m 0600 /dev/null "${ENV_FILE}"
  cat > "${ENV_FILE}" <<EOF
NODE_ENV=production
PORT=3001
HOST=127.0.0.1
PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
DOWNLOAD_BASE_URL=${PUBLIC_BASE_URL}
TECH_USERNAME=admin
TECH_PASSWORD=change-this-password
ADMIN_EMAIL=admin@${APEX_DOMAIN}
EOF
  echo "IMPORTANT: edit ${ENV_FILE} and set a strong TECH_PASSWORD."
fi

echo "[remote-support] Installing systemd service"
cp "${APP_DIR}/deploy/remotesupport-web.service" /etc/systemd/system/remotesupport-web.service
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
systemctl daemon-reload
systemctl enable --now remotesupport-web

echo "[remote-support] Installing Caddy HTTPS reverse proxy"
cat > /etc/caddy/Caddyfile <<EOF
${APEX_DOMAIN}, ${DOMAIN} {
	reverse_proxy 127.0.0.1:3001
}
EOF
systemctl enable --now caddy
systemctl reload caddy

echo "[remote-support] Local health check"
curl -fsS http://127.0.0.1:3001/health || {
  echo "Local health check failed. Check: journalctl -u remotesupport-web -n 100" >&2
  exit 1
}

echo
echo "Done."
echo "Now point DNS A records for ${APEX_DOMAIN} and ${DOMAIN} to this VPS public IP."
echo "Then test: curl https://${DOMAIN}/health"
