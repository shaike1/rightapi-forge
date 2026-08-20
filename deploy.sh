#!/usr/bin/env bash
# deploy.sh — pull latest code and restart the itops-agents stack
# Usage: bash deploy.sh [branch]   (default: current branch, then main)
set -euo pipefail

CURRENT_BRANCH="$(git -C "$(dirname "$0")" branch --show-current 2>/dev/null || true)"
BRANCH="${1:-${DEPLOY_BRANCH:-${CURRENT_BRANCH:-main}}}"
DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="docker compose -f $DIR/docker-compose.yml -f $DIR/docker-compose.override.yml -f $DIR/docker-compose.local.yml"

# Safety: require docker-compose.local.yml
if [ ! -f "$DIR/docker-compose.local.yml" ]; then
  echo "[deploy] ERROR: docker-compose.local.yml not found. Copy docker-compose.local.yml.template and fill in values."
  exit 1
fi

echo "[deploy] branch=$BRANCH dir=$DIR"

echo "[deploy] pulling latest code..."
cd "$DIR"
git fetch origin
git checkout "$BRANCH"
git pull origin "$BRANCH"

echo "[deploy] building image..."
$COMPOSE build --no-cache

echo "[deploy] restarting services..."
$COMPOSE up -d --force-recreate

echo "[deploy] waiting for startup..."
for attempt in $(seq 1 24); do
  if curl -sf http://localhost:19123/api/health > /dev/null; then
    echo "[deploy] health check passed (attempt $attempt)"
    break
  fi
  if [ "$attempt" -eq 24 ]; then
    echo "[deploy] HEALTH CHECK FAILED after 120 seconds"
    $COMPOSE ps
    $COMPOSE logs --tail 120 itops-agents
    exit 1
  fi
  sleep 5
done

COMMIT=$(git rev-parse --short HEAD)
echo "[deploy] SUCCESS — deployed $COMMIT"

# Notify via IRC/agent-bus (best-effort, don't fail deploy if this errors)
curl -sf -X POST http://localhost:19123/api/agent-bus/send   -H 'Content-Type: application/json'   -d "{\"fromAgentId\":\"director\",\"toAgentId\":\"director\",\"message\":\"[deploy] Deployed commit $COMMIT to prod\"}"   > /dev/null 2>&1 || true

echo "[deploy] done"
