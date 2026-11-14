#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
node server.js &
for i in $(seq 1 48); do
  [ -f .port ] && break
  sleep 0.25
done
PORT=$(cat .port 2>/dev/null || echo 4180)
URL="http://127.0.0.1:$PORT/"
if command -v open >/dev/null 2>&1; then open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
else echo "Open $URL in your browser"; fi
