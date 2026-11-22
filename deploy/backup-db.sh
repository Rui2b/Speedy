#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PostgreSQL backup
#
# With PostgreSQL in Docker (the 1Panel default) this dumps straight through
# docker exec, so no psql client is needed on the host.
#
# Usage:
#   sudo bash deploy/backup-db.sh
#   sudo bash deploy/backup-db.sh /var/backups/speedy
#
# Suggested crontab entry, daily at 03:10:
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

echo "[$(date -Is)] dumping ${PG_DB} to ${OUT}"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Container ${CONTAINER} not found. Check the PG_CONTAINER variable." >&2
  exit 1
fi

docker exec -i "$CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" \
  --no-owner --no-privileges --clean --if-exists \
  | gzip -9 > "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
echo "[$(date -Is)] finished, ${SIZE}"

# Drop expired backups
find "$BACKUP_DIR" -maxdepth 1 -name 'speedy-*.sql.gz' -mtime "+${KEEP_DAYS}" -print -delete

# Verify the archive opens and contains the users table
if gzip -t "$OUT" 2>/dev/null && gzip -dc "$OUT" | grep -q 'CREATE TABLE.*users'; then
  echo "[$(date -Is)] backup verified"
else
  echo "[$(date -Is)] backup verification failed" >&2
  exit 1
fi
