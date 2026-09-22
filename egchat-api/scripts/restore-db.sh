#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL requerido}"
BACKUP_FILE="${1:?Uso: restore-db.sh backup.sql.gz}"

test -f "$BACKUP_FILE"
case "$BACKUP_FILE" in
  *.gz) gunzip -c "$BACKUP_FILE" | psql "$DATABASE_URL" ;;
  *) psql "$DATABASE_URL" < "$BACKUP_FILE" ;;
esac
printf 'Restauración completada desde: %s\n' "$BACKUP_FILE"
