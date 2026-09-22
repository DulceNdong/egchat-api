#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL requerido}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/egchat-$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR"
pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip -9 > "$FILE"
find "$BACKUP_DIR" -name 'egchat-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete
printf 'Backup creado: %s\n' "$FILE"
