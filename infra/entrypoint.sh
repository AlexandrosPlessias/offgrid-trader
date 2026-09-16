#!/bin/sh
# Start ntfy in the background (push-notification sidecar), then exec uvicorn.
# Using `exec` for uvicorn ensures it is PID 1 and receives SIGTERM from Fly.io /
# Docker correctly so graceful shutdown works.  The background ntfy process is
# killed automatically when the parent shell exits.
ntfy serve --listen-http :18880 &
exec uvicorn backend.main:app --host 0.0.0.0 --port 8000
