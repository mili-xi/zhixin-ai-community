#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /var/backups/zhixin-ai/YYYYMMDD-HHMMSS" >&2
  exit 2
fi

PROJECT_DIR="${PROJECT_DIR:-/opt/zhixin-ai}"
SOURCE="$(readlink -f "$1")"
BACKUP_ROOT="$(readlink -f "${BACKUP_ROOT:-/var/backups/zhixin-ai}")"
if [[ "$SOURCE" != "$BACKUP_ROOT"/* || ! -f "$SOURCE/database.dump" ]]; then
  echo "invalid backup directory: $SOURCE" >&2
  exit 2
fi

COMPOSE=(docker compose --env-file "$PROJECT_DIR/.env.production" -f "$PROJECT_DIR/docker-compose.prod.yml")
"${COMPOSE[@]}" up -d postgres redis
"${COMPOSE[@]}" exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && PGPASSWORD="$POSTGRES_PASSWORD" createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
"${COMPOSE[@]}" exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < "$SOURCE/database.dump"
"${COMPOSE[@]}" run --rm --no-deps -T api sh -c 'rm -rf /app/uploads/* && tar -C /app/uploads -xzf -' < "$SOURCE/uploads.tar.gz"
"${COMPOSE[@]}" up -d api worker web
