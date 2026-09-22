#!/usr/bin/env bash
set -euo pipefail

APP="${1:?Uso: publish-update.sh app platform arch version binary signature}"
PLATFORM="${2:?platform requerido}"
ARCH="${3:?arch requerido}"
VERSION="${4:?version requerido}"
BINARY="${5:?binary requerido}"
SIGNATURE="${6:?signature requerido}"
BASE_URL="${UPDATE_BASE_URL:-https://egchat-api-xlxj.onrender.com/downloads}"
RELEASES_DIR="${RELEASES_DIR:-./releases}"
TARGET_DIR="$RELEASES_DIR/$APP/$PLATFORM/$ARCH"
FILE_NAME="$(basename "$BINARY")"

mkdir -p "$TARGET_DIR"
cp "$BINARY" "$TARGET_DIR/$FILE_NAME"
cat > "$TARGET_DIR/latest.json" <<JSON
{
  "version": "$VERSION",
  "notes": "EGCHAT desktop update $VERSION",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "$PLATFORM-$ARCH": {
      "signature": "$SIGNATURE",
      "url": "$BASE_URL/$APP/$PLATFORM/$ARCH/$FILE_NAME"
    }
  }
}
JSON
printf 'Update publicado: %s\n' "$TARGET_DIR/latest.json"
