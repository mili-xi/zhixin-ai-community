#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/zhixin-ai}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/zhixin-ai}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"
COMPOSE=(docker compose --env-file "$PROJECT_DIR/.env.production" -f "$PROJECT_DIR/docker-compose.prod.yml")

install -d -m 0700 "$DEST"
cp -a "$PROJECT_DIR/.env.production" "$DEST/env.production"
cp -a "$PROJECT_DIR/docker-compose.prod.yml" "$DEST/docker-compose.prod.yml"
cp -a /etc/nginx/conf.d/zhixin-site.conf "$DEST/zhixin-site.conf" 2>/dev/null || true
"${COMPOSE[@]}" exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$DEST/database.dump"
"${COMPOSE[@]}" run --rm --no-deps -T api sh -c 'tar -C /app/uploads -czf - .' > "$DEST/uploads.tar.gz"
# Verify both payloads before allowing retention cleanup.
"${COMPOSE[@]}" exec -T postgres pg_restore --list < "$DEST/database.dump" > /dev/null
gzip -t "$DEST/uploads.tar.gz"
touch "$DEST/VERIFIED"
chmod -R go-rwx "$DEST"
python3 "$PROJECT_DIR/scripts/production/prune_verified_backups.py" --root "$BACKUP_ROOT" --verified "$DEST" --apply
printf '%s\n' "$DEST"
