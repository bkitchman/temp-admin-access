#!/bin/bash
# deploy.sh — clean build + deploy for temp-admin-access
#
# Reads sensitive parameter values from environment variables so they never
# need to be typed on the command line or stored in samconfig.toml.
#
# Required env vars:
#   IRU_API_TOKEN          — Iru API token (from Settings → Access → API Token)
#   SLACK_BOT_TOKEN        — Slack bot OAuth token
#   SLACK_SIGNING_SECRET   — Slack app signing secret
#   SELF_SERVICE_API_KEY   — Shared key stored in device keychain
#
# Optional env vars (defaults match samconfig.toml):
#   IRU_BASE_URL           — Iru tenant API base URL
#   SLACK_IT_CHANNEL_ID    — Slack channel ID for IT approval messages
#   EMAIL_DOMAIN           — Company email domain for Slack user lookup
#   ON_CALL_SLACK_USER_ID  — Slack user ID for off-hours auto-approval
#
# Usage:
#   ./deploy.sh            # build + deploy (no confirmation prompt)
#   ./deploy.sh --confirm  # build + deploy (pause to review changeset)

set -euo pipefail

cd "$(dirname "$0")"

# ---------------------------------------------------------------------------
# Validate required env vars
# ---------------------------------------------------------------------------
MISSING=()
for VAR in IRU_API_TOKEN SLACK_BOT_TOKEN SLACK_SIGNING_SECRET SELF_SERVICE_API_KEY; do
  if [ -z "${!VAR:-}" ]; then
    MISSING+=("$VAR")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "ERROR: Missing required environment variables:"
  for VAR in "${MISSING[@]}"; do
    echo "  export $VAR=..."
  done
  exit 1
fi

# ---------------------------------------------------------------------------
# Build parameter overrides from env vars + defaults
# ---------------------------------------------------------------------------
IRU_BASE_URL="${IRU_BASE_URL:-https://kitchman.api.kandji.io}"
SLACK_IT_CHANNEL_ID="${SLACK_IT_CHANNEL_ID:-YOUR_SLACK_CHANNEL_ID}"
EMAIL_DOMAIN="${EMAIL_DOMAIN:-kitchman.com}"
ON_CALL_SLACK_USER_ID="${ON_CALL_SLACK_USER_ID:-}"

PARAMS=(
  "IruApiToken=$IRU_API_TOKEN"
  "IruBaseUrl=$IRU_BASE_URL"
  "SlackBotToken=$SLACK_BOT_TOKEN"
  "SlackSigningSecret=$SLACK_SIGNING_SECRET"
  "SlackItChannelId=$SLACK_IT_CHANNEL_ID"
  "SelfServiceApiKey=$SELF_SERVICE_API_KEY"
  "EmailDomain=$EMAIL_DOMAIN"
  "IruElevationTag5Min=temp-admin-elevation-5min"
  "IruElevationTag10Min=temp-admin-elevation-10min"
  "IruElevationTag15Min=temp-admin-elevation-15min"
  "IruElevationTag30Min=temp-admin-elevation-30min"
  "IruLogCollectionTag=temp-admin-log-collection"
)

if [ -n "$ON_CALL_SLACK_USER_ID" ]; then
  PARAMS+=("OnCallSlackUserId=$ON_CALL_SLACK_USER_ID")
fi

# ---------------------------------------------------------------------------
# Clean, build, deploy
# ---------------------------------------------------------------------------
echo "==> Clearing .aws-sam build cache..."
if [ -d .aws-sam ]; then
  chmod -R u+w .aws-sam 2>/dev/null || true
  find .aws-sam -depth -exec rm -rf {} + 2>/dev/null || true
fi

echo "==> Building..."
sam build

echo "==> Deploying with parameters from environment..."
if [ "${1:-}" = "--confirm" ]; then
  sam deploy --parameter-overrides "${PARAMS[@]}"
else
  sam deploy --no-confirm-changeset --parameter-overrides "${PARAMS[@]}"
fi
