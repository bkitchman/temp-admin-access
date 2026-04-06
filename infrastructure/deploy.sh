#!/bin/bash
# deploy.sh — clean build + deploy for temp-admin-access
#
# Workaround for sam build --clean failing on macOS when .aws-sam contains
# read-only node_modules directories. Always clears the cache first.
#
# Usage:
#   ./deploy.sh            # build + deploy (no confirmation prompt)
#   ./deploy.sh --confirm  # build + deploy (pause to review changeset)

set -euo pipefail

cd "$(dirname "$0")"

echo "==> Clearing .aws-sam build cache..."
if [ -d .aws-sam ]; then
  chmod -R u+w .aws-sam 2>/dev/null || true
  find .aws-sam -depth -exec rm -rf {} + 2>/dev/null || true
fi

echo "==> Building..."
sam build

echo "==> Deploying..."
if [ "${1:-}" = "--confirm" ]; then
  sam deploy
else
  sam deploy --no-confirm-changeset
fi
