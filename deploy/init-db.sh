#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Database bootstrap: create the database, then apply the schema.
#
# Assumes PostgreSQL runs in Docker, which is the case on this host.
# Idempotent, safe to re-run.
#
# Usage:
#   sudo bash deploy/init-db.sh
# ---------------------------------------------------------------------------
set -euo pipefail

CONTAINER=${PG_CONTAINER:-1Panel-postgresql-tGSS}
PG_USER=${PG_USER:-speedy}
PG_DB=${PG_DB:-speedy}
SQL_FILE=${1:-$(cd "$(dirname "$0")/.." && pwd)/db/init.sql}

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Container ${CONTAINER} not found" >&2
  exit 1
fi

echo "==> Checking database ${PG_DB}"
EXISTS=$(docker exec -i "$CONTAINER" psql -U "$PG_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '${PG_DB}'")

if [[ "$EXISTS" != "1" ]]; then
  echo "==> Creating database ${PG_DB}"
  docker exec -i "$CONTAINER" psql -U "$PG_USER" -d postgres -c \
    "CREATE DATABASE \"${PG_DB}\" OWNER \"${PG_USER}\""
else
  echo "    already present, skipping"
fi

echo "==> Applying schema ${SQL_FILE}"
docker exec -i "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 < "$SQL_FILE"

echo "==> Tables"
docker exec -i "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c '\dt'
echo "Done"
