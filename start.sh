#!/bin/bash
set -e

# Start server in background
npm run start &
SERVER_PID=$!

# Wait for server to start
echo Waiting for server...
sleep 10

# Optional bootstrap: create default agents only when explicitly enabled.
if [ "${AUTO_INIT_AGENTS:-false}" = "true" ] && [ -f /usr/local/bin/init-agents.sh ]; then
  echo Running init script...
  /usr/local/bin/init-agents.sh || echo Init script failed or agents already exist
else
  echo "Skipping init script (set AUTO_INIT_AGENTS=true to enable)"
fi

# Wait for server process
wait "$SERVER_PID"
