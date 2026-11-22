#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 初始化数据库(建库 + 建表)
#
# 适用:PostgreSQL 跑在 Docker 容器里(本机实际情况)。
# 幂等:可重复执行。
#
# 用法:
#   sudo bash deploy/init-db.sh
# ---------------------------------------------------------------------------
set -euo pipefail

CONTAINER=${PG_CONTAINER:-1Panel-postgresql-tGSS}
PG_USER=${PG_USER:-speedy}
PG_DB=${PG_DB:-speedy}
SQL_FILE=${1:-$(cd "$(dirname "$0")/.." && pwd)/db/init.sql}

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "容器 ${CONTAINER} 不存在" >&2
  exit 1
fi

echo "==> 检查数据库 ${PG_DB}"
EXISTS=$(docker exec -i "$CONTAINER" psql -U "$PG_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '${PG_DB}'")

if [[ "$EXISTS" != "1" ]]; then
  echo "==> 创建数据库 ${PG_DB}"
  docker exec -i "$CONTAINER" psql -U "$PG_USER" -d postgres -c \
    "CREATE DATABASE \"${PG_DB}\" OWNER \"${PG_USER}\""
else
  echo "    已存在,跳过创建"
fi

echo "==> 应用表结构 ${SQL_FILE}"
docker exec -i "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 < "$SQL_FILE"

echo "==> 表清单"
docker exec -i "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c '\dt'
echo "完成"
