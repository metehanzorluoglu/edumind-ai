#!/usr/bin/env bash
# Backs up the private, mutable corpus state (milestone 8 §13):
#   - data/raw/                    raw source documents
#   - data/metadata.csv            the metadata CSV, if you keep one at this path
#   - data/ingestion_registry.json duplicate-detection registry (document IDs live here)
#   - data/qdrant_storage/         embedded Qdrant index (only relevant when QDRANT_MODE=local)
#   - evaluation/                  question sets, reports, human-review CSVs
#
# Deliberately does NOT include Ollama model weights: they are not stored
# anywhere under this project (they live in Ollama's own model store,
# typically ~/.ollama), so a selective copy like this one never sweeps them
# in by accident. Nothing to explicitly exclude.
#
# Usage:
#   ./scripts/backup.sh                    # writes to ./backups/backup-<timestamp>/
#   BACKUP_ROOT=/other/place ./scripts/backup.sh
#
# Never overwrites an existing backup directory (timestamps make collisions
# practically impossible, but the check exists anyway — silent overwrite of
# a backup is exactly the failure mode backups exist to prevent against).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

if command -v shasum >/dev/null 2>&1; then
  SHA_CMD=(shasum -a 256)
elif command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD=(sha256sum)
else
  echo "Neither shasum nor sha256sum is available — cannot write an integrity manifest." >&2
  exit 1
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${BACKUP_ROOT:-./backups}"
BACKUP_DIR="$BACKUP_ROOT/backup-$TIMESTAMP"

if [ -e "$BACKUP_DIR" ]; then
  echo "Refusing to overwrite existing backup directory: $BACKUP_DIR" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
echo "Backing up to $BACKUP_DIR ..."

copy_if_exists() {
  local src="$1"
  local dest="$2"
  if [ -e "$src" ]; then
    mkdir -p "$(dirname "$dest")"
    cp -R "$src" "$dest"
    echo "  copied $src"
  else
    echo "  skipped (not found): $src"
  fi
}

copy_if_exists "data/raw" "$BACKUP_DIR/data/raw"
copy_if_exists "data/metadata.csv" "$BACKUP_DIR/data/metadata.csv"
copy_if_exists "data/ingestion_registry.json" "$BACKUP_DIR/data/ingestion_registry.json"
copy_if_exists "data/qdrant_storage" "$BACKUP_DIR/data/qdrant_storage"
copy_if_exists "evaluation" "$BACKUP_DIR/evaluation"

echo "Writing integrity manifest ..."
(cd "$BACKUP_DIR" && find . -type f ! -name 'MANIFEST.*' -print0 | sort -z | xargs -0 "${SHA_CMD[@]}" > MANIFEST.sha256)

cat > "$BACKUP_DIR/MANIFEST.json" <<EOF
{
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_root": "$ROOT_DIR",
  "excludes": ["Ollama model weights (stored outside this project; not applicable by design)"]
}
EOF

echo ""
echo "Backup complete: $BACKUP_DIR"
echo "Contents:"
find "$BACKUP_DIR" -maxdepth 2 -mindepth 1 | sed 's/^/  /'
echo ""
echo "Restore with: ./scripts/restore.sh $BACKUP_DIR"
