#!/usr/bin/env bash
set -euo pipefail

SOURCE="${1:-/root/zhixin.example.com.conf}"
TARGET="${2:-/etc/nginx/conf.d/zhixin-site.conf}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/zhixin-ai}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${BACKUP_DIR}/example-site.conf.pre-cutover-${STAMP}"

mkdir -p "${BACKUP_DIR}"
cp -a "${TARGET}" "${BACKUP}"
install -m 644 "${SOURCE}" "${TARGET}.new"
mv -f "${TARGET}.new" "${TARGET}"

if nginx -t; then
  systemctl reload nginx
  printf 'cutover_ok backup=%s\n' "${BACKUP}"
  exit 0
fi

cp -a "${BACKUP}" "${TARGET}"
nginx -t
systemctl reload nginx
printf 'cutover_failed_restored=%s\n' "${BACKUP}" >&2
exit 1
