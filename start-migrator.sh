#!/usr/bin/env bash
# PowerApps Solution Migrator - start on macOS / Linux: ./start-migrator.sh
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org and run this again."
  exit 1
fi
set +e
node scripts/check-deps.js
code=$?
set -e
if [ "$code" = "2" ]; then exit 1; fi
if [ "$code" = "1" ]; then
  echo "Installing the required components (only needed once)..."
  npm install --no-audit --no-fund
  node scripts/check-deps.js --stamp
fi
echo "Starting the migrator. Closing its browser tab (or Ctrl+C here) stops it."
OPEN_BROWSER=1 AUTO_EXIT=1 exec node server.js
