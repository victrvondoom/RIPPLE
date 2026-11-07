#!/usr/bin/env bash
# Starts RIPPLE on a throw-away database/outbox for demos and e2e runs. Usage: scripts/fresh-server.sh [port]
set -e
PORT=${1:-8787}
pkill -f "tsx src/server/index.ts" 2>/dev/null || true
# Wait until the old server has released the port; otherwise the new one exits with "port in use" (seen in session 19).
for i in $(seq 1 40); do curl -s -o /dev/null "localhost:$PORT/api/health" || break; sleep 0.25; done
rm -rf /tmp/ripple-e2e && mkdir -p /tmp/ripple-e2e
RIPPLE_DEMO_ACTIVITY=${RIPPLE_DEMO_ACTIVITY:-0} PORT=$PORT RIPPLE_DB_PATH=/tmp/ripple-e2e/ripple.db RIPPLE_OUTBOX=/tmp/ripple-e2e/outbox nohup npx tsx src/server/index.ts > /tmp/ripple-e2e/server.log 2>&1 &
for i in $(seq 1 30); do curl -sf localhost:$PORT/api/health >/dev/null && echo "RIPPLE up on :$PORT" && exit 0; sleep 0.5; done
echo "server failed to start"; cat /tmp/ripple-e2e/server.log; exit 1
