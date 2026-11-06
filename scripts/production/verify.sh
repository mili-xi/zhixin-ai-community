#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/zhixin-ai}"
PUBLIC_URL="${PUBLIC_URL:-https://zhixin.example.com}"
COMPOSE=(docker compose --env-file "$PROJECT_DIR/.env.production" -f "$PROJECT_DIR/docker-compose.prod.yml")

"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" ps
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:3001/login >/dev/null
curl --fail --silent --show-error --max-time 20 "$PUBLIC_URL/login" >/dev/null

for port in 5432 6379 8000; do
  if ss -lntH | awk '{print $4}' | grep -Eq "(^|:)$port$"; then
    echo "private service unexpectedly listens on host port $port" >&2
    exit 1
  fi
done

echo "production verification passed"
