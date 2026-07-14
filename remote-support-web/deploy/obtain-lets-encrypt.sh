#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-${CERT_DOMAIN:-}}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: obtain-lets-encrypt.sh <domain>"
  exit 1
fi

HTTPS_KEY_PATH="${HTTPS_KEY_PATH:-certs/${DOMAIN}-key.pem}"
HTTPS_CERT_PATH="${HTTPS_CERT_PATH:-certs/${DOMAIN}-cert.pem}"

mkdir -p "$(dirname "$HTTPS_KEY_PATH")"

# certbot must already be installed on the host.
# Assumes DNS is already pointed and public validation will succeed.
# We use the webroot-less standalone mode; if your network blocks inbound 80/443,
# you must switch to DNS-01.

# Try standalone first.

echo "[lets-encrypt] Requesting certificate for $DOMAIN"

if command -v certbot >/dev/null 2>&1; then
  # Use non-interactive mode.
  sudo certbot certonly \
    --non-interactive \
    --agree-tos \
    --standalone \
    -d "$DOMAIN" \
    --email "${CERTBOT_EMAIL:-admin@${DOMAIN}}" \
    --preferred-challenges http-01 \
    --keep-until-expiring
else
  echo "certbot not found. Install certbot or modify script." >&2
  exit 1
fi

# certbot standard paths (letsencrypt)
LE_LIVE_DIR="/etc/letsencrypt/live/${DOMAIN}"
if [[ ! -d "$LE_LIVE_DIR" ]]; then
  echo "Let’s Encrypt live directory not found: $LE_LIVE_DIR" >&2
  exit 1
fi

SRC_KEY="$LE_LIVE_DIR/privkey.pem"
SRC_CERT="$LE_LIVE_DIR/fullchain.pem"

# fullchain.pem includes cert + chain. server.js expects cert PEM; fullchain works.
cp "$SRC_KEY" "$HTTPS_KEY_PATH"
cp "$SRC_CERT" "$HTTPS_CERT_PATH"

echo "[lets-encrypt] Wrote:"
echo "  HTTPS_KEY_PATH=$HTTPS_KEY_PATH"
echo "  HTTPS_CERT_PATH=$HTTPS_CERT_PATH"

