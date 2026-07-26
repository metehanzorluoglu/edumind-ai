#!/usr/bin/env bash
# Restores a backup created by scripts/backup.sh (milestone 8 §13).
#
# Usage:
#   ./scripts/restore.sh <backup-path>
#
# Verifies the backup's integrity manifest before touching anything, then
# requires an explicit typed confirmation before overwriting existing
# data/raw, data/metadata.csv, data/ingestion_registry.json,
# data/qdrant_storage, or evaluation/ — restore is inherently destructive to
# whatever is currently there, so this never runs silently or unattended.
#
# Stop the backend first if QDRANT_MODE=local: restoring data/qdrant_storage
# while the app holds it open will fail the same way milestone 7 found
# concurrent local-Qdrant access fails (see app/api/routes_health.py).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="${1:-}"
if [ -z "$BACKUP_DIR" ]; then
  echo "Usage: $0 <backup-path>" >&2
  exit 1
fi
if [ ! -d "$BACKUP_DIR" ]; then
  echo "No such backup directory: $BACKUP_DIR" >&2
  exit 1
fi

MANIFEST="$BACKUP_DIR/MANIFEST.sha256"
if [ ! -f "$MANIFEST" ]; then
  echo "No MANIFEST.sha256 found in $BACKUP_DIR — refusing to restore an unverifiable backup." >&2
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  SHA_VERIFY=(shasum -a 256 -c)
elif command -v sha256sum >/dev/null 2>&1; then
  SHA_VERIFY=(sha256sum -c)
else
  echo "Neither shasum nor sha256sum is available — cannot verify the backup's integrity." >&2
  exit 1
fi

echo "Verifying integrity of $BACKUP_DIR ..."
(cd "$BACKUP_DIR" && "${SHA_VERIFY[@]}" MANIFEST.sha256)
echo "Integrity check passed."

echo ""
echo "This will restore into: $ROOT_DIR"
echo "Any of the following that exist in the backup will OVERWRITE what's currently there:"
echo "  data/raw, data/metadata.csv, data/ingestion_registry.json, data/qdrant_storage, evaluation/"
read -r -p "Type 'restore' to confirm: " CONFIRMATION
if [ "$CONFIRMATION" != "restore" ]; then
  echo "Aborted. Nothing was changed."
  exit 1
fi

restore_if_present() {
  local src="$1"
  local dest="$2"
  if [ -e "$src" ]; then
    mkdir -p "$(dirname "$dest")"
    rm -rf "$dest"
    cp -R "$src" "$dest"
    echo "  restored $dest"
  fi
}

restore_if_present "$BACKUP_DIR/data/raw" "data/raw"
restore_if_present "$BACKUP_DIR/data/metadata.csv" "data/metadata.csv"
restore_if_present "$BACKUP_DIR/data/ingestion_registry.json" "data/ingestion_registry.json"
restore_if_present "$BACKUP_DIR/data/qdrant_storage" "data/qdrant_storage"
restore_if_present "$BACKUP_DIR/evaluation" "evaluation"

echo ""
echo "Restore complete."
