#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /var/backups/zhixin-ai/YYYYMMDD-HHMMSS" >&2
  exit 2
fi

PROJECT_DIR="${PROJECT_DIR:-/opt/zhixin-ai}"
BACKUP_ROOT="$(readlink -f "${BACKUP_ROOT:-/var/backups/zhixin-ai}")"
SOURCE="$(readlink -f "$1")"
DRILL_DB="zhixin_restore_drill_$(date +%s)"
COMPOSE=(docker compose --env-file "$PROJECT_DIR/.env.production" -f "$PROJECT_DIR/docker-compose.prod.yml")

if [[ "$SOURCE" != "$BACKUP_ROOT"/* || ! -f "$SOURCE/database.dump" || ! -f "$SOURCE/uploads.tar.gz" ]]; then
  echo "invalid backup directory: $SOURCE" >&2
  exit 2
fi

cleanup() {
  "${COMPOSE[@]}" exec -T postgres sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" dropdb -U "$POSTGRES_USER" --if-exists "$1"' sh "$DRILL_DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${COMPOSE[@]}" exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" createdb -U "$POSTGRES_USER" "$1"' sh "$DRILL_DB"
"${COMPOSE[@]}" exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U "$POSTGRES_USER" -d "$1" --exit-on-error' sh "$DRILL_DB" < "$SOURCE/database.dump"

TABLE_COUNT="$("${COMPOSE[@]}" exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$1" -Atc "select count(*) from pg_tables where schemaname = '\''public'\'';"' sh "$DRILL_DB")"
tar -tzf "$SOURCE/uploads.tar.gz" >/dev/null

if [[ "$TABLE_COUNT" -lt 1 ]]; then
  echo "restore drill found no public tables" >&2
  exit 1
fi

printf 'restore_drill_ok tables=%s backup=%s\n' "$TABLE_COUNT" "$SOURCE"
