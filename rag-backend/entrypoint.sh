#!/bin/sh
set -eu

# The Docker volume mounted at /data can be empty on first startup.
# Ensure the attachment directory exists before migrations or Uvicorn run.
mkdir -p /data/chat-attachments

# Frontend/Platform Milestone 3.2.1: same reasoning as chat-attachments
# above, for original uploaded document files (see
# app/services/document_file_storage.py). This does NOT fix a
# misconfigured DOCUMENT_STORAGE_DIR pointed somewhere other than /data
# (DocumentFileStorage.__init__ already mkdir's -p wherever it's told to,
# which is exactly how that misconfiguration stayed silent — see this
# milestone's report) — it only ensures the *correctly configured* path
# is ready before the app starts, matching chat-attachments' own bar.
mkdir -p /data/document-files

# Replace this shell with the Compose command, preserving signals and exit codes.
exec "$@"
