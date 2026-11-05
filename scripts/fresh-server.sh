#!/usr/bin/env bash
# Starts RIPPLE on a throw-away database/outbox for demos and e2e runs. Usage: scripts/fresh-server.sh [port]
set -e
PORT=${1:-8787}
pkill -f "tsx src/server/index.ts" 2>/dev/null || true
rm -rf /tmp/ripple-e2e && mkdir -p /tmp/ripple-e2e
PORT=$PORT RIPPLE_DB_PATH=/tmp/ripple-e2e/ripple.db RIPPLE_OUTBOX=/tmp/ripple-e2e/outbox nohup npx tsx src/server/index.ts > /tmp/ripple-e2e/server.log 2>&1 &
for i in $(seq 1 30); do curl -sf localhost:$PORT/api/health >/dev/null && echo "RIPPLE up on :$PORT" && exit 0; sleep 0.5; done
echo "server failed to start"; cat /tmp/ripple-e2e/server.log; exit 1
