#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PostgreSQL 备份脚本
#
# 在你的 PG 跑在 Docker 里的场景下(1Panel 默认),直接 docker exec pg_dump,
# 避免依赖宿主机装 psql 客户端。
#
# 用法:
#   sudo bash deploy/backup-db.sh
#   sudo bash deploy/backup-db.sh /var/backups/speedy
#
# 建议加到 crontab(每天 03:10):
#   10 3 * * * /usr/bin/bash /opt/speedy/deploy/backup-db.sh >> /var/log/speedy-backup.log 2>&1
# ---------------------------------------------------------------------------
set -euo pipefail

BACKUP_DIR=${1:-/var/backups/speedy}
CONTAINER=${PG_CONTAINER:-1Panel-postgresql-tGSS}
PG_USER=${PG_USER:-speedy}
PG_DB=${PG_DB:-speedy}
KEEP_DAYS=${KEEP_DAYS:-14}

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="${BACKUP_DIR}/speedy-${STAMP}.sql.gz"

echo "[$(date -Is)] 开始备份 ${PG_DB} → ${OUT}"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "容器 ${CONTAINER} 不存在,请检查 PG_CONTAINER 环境变量" >&2
  exit 1
fi

docker exec -i "$CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" \
  --no-owner --no-privileges --clean --if-exists \
  | gzip -9 > "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
echo "[$(date -Is)] 完成,大小 ${SIZE}"

# 清理过期备份
find "$BACKUP_DIR" -maxdepth 1 -name 'speedy-*.sql.gz' -mtime "+${KEEP_DAYS}" -print -delete

# 简单完整性检查:gzip 能解开且包含 users 表
if gzip -t "$OUT" 2>/dev/null && gzip -dc "$OUT" | grep -q 'CREATE TABLE.*users'; then
  echo "[$(date -Is)] 备份校验通过"
else
  echo "[$(date -Is)] 备份校验失败" >&2
  exit 1
fi
