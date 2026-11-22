#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Speedy 一键安装脚本(Ubuntu 22.04)
#
# 做这些事:
#   1. 安装 Node.js 22 LTS(官方二进制,不走 apt 的 12.x)
#   2. 创建系统用户 speedy
#   3. 把代码同步到 /opt/speedy 并装依赖
#   4. 生成 .env(如果不存在)
#   5. 安装 systemd 服务并启动
#
# 不安装 Nginx / certbot:本方案用 Cloudflare Tunnel 暴露端口。
# 需要 Nginx 的话另见 deploy/nginx-speedy.conf。
#
# 用法(在服务器上):
#   sudo bash deploy/install.sh
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR=/opt/speedy
APP_USER=speedy
NODE_MAJOR=22

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m[!] %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "请用 sudo 运行本脚本" >&2
  exit 1
fi

# --- 1. Node.js -------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  log "安装 Node.js ${NODE_MAJOR} LTS"
  ARCH=$(dpkg --print-architecture)
  case "$ARCH" in
    amd64) NODE_ARCH=x64 ;;
    arm64) NODE_ARCH=arm64 ;;
    *) echo "不支持的架构: $ARCH" >&2; exit 1 ;;
  esac

  apt-get update -qq
  apt-get install -y -qq curl ca-certificates xz-utils >/dev/null

  NODE_NEWEST=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/" \
    | grep -oE "node-v[0-9.]+-linux-${NODE_ARCH}\.tar\.xz" | head -n1)
  if [[ -z "$NODE_NEWEST" ]]; then
    echo "无法解析 Node.js 版本号,请检查网络" >&2
    exit 1
  fi

  TMP=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${NODE_NEWEST}" -o "${TMP}/node.tar.xz"
  tar -xJf "${TMP}/node.tar.xz" -C /usr/local --strip-components=1
  rm -rf "$TMP"
  node -v
  npm -v
else
  log "已安装 Node.js $(node -v),跳过"
fi

# --- 2. 系统用户 ------------------------------------------------------------
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "创建系统用户 ${APP_USER}"
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
else
  log "用户 ${APP_USER} 已存在"
fi

# --- 3. 同步代码 ------------------------------------------------------------
log "同步代码到 ${APP_DIR}"
mkdir -p "$APP_DIR"
# 保留 .env 与 logs,其余覆盖
rsync -a --delete \
  --exclude '.env' \
  --exclude 'logs' \
  --exclude 'node_modules' \
  --exclude '.git' \
  "$(cd "$(dirname "$0")/.." && pwd)/" "${APP_DIR}/"

log "安装生产依赖"
cd "$APP_DIR"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

mkdir -p "${APP_DIR}/logs"
chown -R "${APP_USER}:${APP_USER}" "$APP_DIR"
chmod 750 "${APP_DIR}/logs"

# --- 4. 环境变量 ------------------------------------------------------------
if [[ ! -f "${APP_DIR}/.env" ]]; then
  log "生成 ${APP_DIR}/.env"
  SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
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
  warn "已生成随机 SESSION_SECRET。请编辑 ${APP_DIR}/.env 填入正确的 DATABASE_URL"
else
  log ".env 已存在,保留不变"
fi

# --- 5. systemd -------------------------------------------------------------
log "安装 systemd 服务"
install -m 644 "${APP_DIR}/deploy/speedy.service" /etc/systemd/system/speedy.service
systemctl daemon-reload
systemctl enable speedy.service >/dev/null
systemctl restart speedy.service

sleep 2
if systemctl is-active --quiet speedy.service; then
  log "服务已启动"
  systemctl status speedy.service --no-pager -n 12 || true
else
  warn "服务启动失败,查看日志: journalctl -u speedy -n 60 --no-pager"
  journalctl -u speedy -n 40 --no-pager || true
  exit 1
fi

cat <<'EOF'

--------------------------------------------------------------------
安装完成。下一步:

  1. 检查 .env:
       sudo nano /opt/speedy/.env
  2. 本地健康检查:
       curl -s http://127.0.0.1:8080/api/health
  3. 配置 Cloudflare Tunnel 把 speedy-origin.<你的域名> 指到 8080:
       sudo cloudflared tunnel route dns <tunnel名> speedy-origin.<你的域名>
       (或直接在 Cloudflare Dashboard 里加 Public Hostname)
  4. 常用命令:
       sudo systemctl status speedy
       sudo journalctl -u speedy -f
       sudo journalctl -u speedy -n 200
       sudo systemctl restart speedy
--------------------------------------------------------------------
EOF
