#!/bin/sh
set -eu

# The Docker volume mounted at /data can be empty on first startup.
# Ensure the attachment directory exists before migrations or Uvicorn run.
mkdir -p /data/chat-attachments

# Replace this shell with the Compose command, preserving signals and exit codes.
exec "$@"
