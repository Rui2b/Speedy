#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Speedy installer (Ubuntu 22.04)
#
# What it does:
#   1. Installs Node.js 22 LTS from the official binary, not apt's 12.x
#   2. Creates the system user `speedy`
#   3. Syncs the code to /opt/speedy and installs production dependencies
#   4. Writes .env if one does not exist yet
#   5. Installs and starts the systemd unit
#
# Nginx and certbot are not installed: the default setup exposes the origin
# through a Cloudflare Tunnel. See deploy/nginx-speedy.conf if you want Nginx.
#
# Usage, on the server:
#   sudo bash deploy/install.sh
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR=/opt/speedy
APP_USER=speedy
NODE_MAJOR=22

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m[!] %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run this script with sudo" >&2
  exit 1
fi

# --- 1. Node.js -------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  log "Installing Node.js ${NODE_MAJOR} LTS"
  ARCH=$(dpkg --print-architecture)
  case "$ARCH" in
    amd64) NODE_ARCH=x64 ;;
    arm64) NODE_ARCH=arm64 ;;
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
  esac

  apt-get update -qq
  apt-get install -y -qq curl ca-certificates xz-utils >/dev/null

  NODE_NEWEST=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/" \
    | grep -oE "node-v[0-9.]+-linux-${NODE_ARCH}\.tar\.xz" | head -n1)
  if [[ -z "$NODE_NEWEST" ]]; then
    echo "Could not resolve a Node.js release. Check network access." >&2
    exit 1
  fi

  TMP=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${NODE_NEWEST}" -o "${TMP}/node.tar.xz"
  tar -xJf "${TMP}/node.tar.xz" -C /usr/local --strip-components=1
  rm -rf "$TMP"
  node -v
  npm -v
else
  log "Node.js $(node -v) already present, skipping"
fi

# --- 2. System user ---------------------------------------------------------
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "Creating system user ${APP_USER}"
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
else
  log "User ${APP_USER} already exists"
fi

# --- 3. Code ---------------------------------------------------------------
log "Syncing code to ${APP_DIR}"
mkdir -p "$APP_DIR"
# Keep .env and logs, replace everything else
rsync -a --delete \
  --exclude '.env' \
  --exclude 'logs' \
  --exclude 'node_modules' \
  --exclude '.git' \
  "$(cd "$(dirname "$0")/.." && pwd)/" "${APP_DIR}/"

log "Installing production dependencies"
cd "$APP_DIR"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

mkdir -p "${APP_DIR}/logs"
chown -R "${APP_USER}:${APP_USER}" "$APP_DIR"
chmod 750 "${APP_DIR}/logs"

# --- 4. Environment ---------------------------------------------------------
if [[ ! -f "${APP_DIR}/.env" ]]; then
  log "Writing ${APP_DIR}/.env"
  SECRET=$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))")
  cat >"${APP_DIR}/.env" <<EOF
HOST=127.0.0.1
PORT=8080
DATABASE_URL=postgres://speedy:CHANGE_ME@127.0.0.1:5432/speedy
PG_POOL_MAX=8
DB_AUTO_MIGRATE=true
SESSION_SECRET=${SECRET}
SESSION_TTL_HOURS=12
LOG_LEVEL=info
CHEAT_LOG_FILE=logs/cheat.log
EOF
  chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
  chmod 600 "${APP_DIR}/.env"
  warn "Generated a random SESSION_SECRET. Edit ${APP_DIR}/.env and set the real DATABASE_URL"
else
  log ".env already exists, leaving it alone"
fi

# --- 5. systemd -------------------------------------------------------------
log "Installing the systemd unit"
install -m 644 "${APP_DIR}/deploy/speedy.service" /etc/systemd/system/speedy.service
systemctl daemon-reload
systemctl enable speedy.service >/dev/null
systemctl restart speedy.service

sleep 2
if systemctl is-active --quiet speedy.service; then
  log "Service is running"
  systemctl status speedy.service --no-pager -n 12 || true
else
  warn "Service failed to start. Check: journalctl -u speedy -n 60 --no-pager"
  journalctl -u speedy -n 40 --no-pager || true
  exit 1
fi

cat <<'EOF'

--------------------------------------------------------------------
Install finished. Next:

  1. Check the environment:
       sudo nano /opt/speedy/.env
  2. Local health check:
       curl -s http://127.0.0.1:8080/api/health
  3. Point a Cloudflare Tunnel hostname at port 8080:
       sudo cloudflared tunnel route dns <tunnel> speedy-origin.<your-domain>
       (or add a Public Hostname in the Cloudflare dashboard)
  4. Common commands:
       sudo systemctl status speedy
       sudo journalctl -u speedy -f
       sudo journalctl -u speedy -n 200
       sudo systemctl restart speedy
--------------------------------------------------------------------
EOF
