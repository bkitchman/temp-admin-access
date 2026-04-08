#!/bin/bash
# deploy.sh — clean build + deploy for temp-admin-access
#
# Reads sensitive parameter values from environment variables so they never
# need to be typed on the command line or stored in samconfig.toml.
#
# Required env vars:
#   IRU_WRITE_API_TOKEN    — Iru API token (from Settings → Access → API Token)
#   SLACK_BOT_TOKEN        — Slack bot OAuth token
#   SLACK_SIGNING_SECRET   — Slack app signing secret
#   SELF_SERVICE_API_KEY   — Shared key stored in device keychain
#   DASHBOARD_API_KEY      — API key for the IT admin risk dashboard
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
#   ./deploy.sh --testing  # deploy with accelerated nudge/auto-deny timers for testing
#                          #   PendingNudgeIntervalMinutes=5  (every 5 min instead of 10)
#                          #   PendingNudgePhase1Hours=1      (unchanged)
#                          #   PendingNudgePhase2IntervalMinutes=5  (5 min instead of 60)
#                          #   PendingAutoDenyHours=1         (1 hr instead of 24)
#   ./deploy.sh --testing --confirm  # both flags together

set -euo pipefail

cd "$(dirname "$0")"

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
CONFIRM=false
TESTING=false
for arg in "$@"; do
  case "$arg" in
    --confirm) CONFIRM=true ;;
    --testing) TESTING=true ;;
    *) echo "ERROR: Unknown flag: $arg"; exit 1 ;;
  esac
done

if [ "$TESTING" = true ]; then
  echo ""
  echo "  ⚠️  TESTING MODE — accelerated timers active:"
  echo "       PendingNudgeIntervalMinutes  = 5   (prod: 10)"
  echo "       PendingNudgePhase2IntervalMinutes = 5   (prod: 60)"
  echo "       PendingAutoDenyHours         = 1   (prod: 24)"
  echo "  Run ./deploy.sh (without --testing) to restore production values."
  echo ""
fi

# ---------------------------------------------------------------------------
# Validate required env vars
# ---------------------------------------------------------------------------
MISSING=()
for VAR in IRU_WRITE_API_TOKEN SLACK_BOT_TOKEN SLACK_SIGNING_SECRET SELF_SERVICE_API_KEY DASHBOARD_API_KEY; do
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
  "IruApiToken=$IRU_WRITE_API_TOKEN"
  "IruBaseUrl=$IRU_BASE_URL"
  "SlackBotToken=$SLACK_BOT_TOKEN"
  "SlackSigningSecret=$SLACK_SIGNING_SECRET"
  "SlackItChannelId=$SLACK_IT_CHANNEL_ID"
  "SelfServiceApiKey=$SELF_SERVICE_API_KEY"
  "DashboardApiKey=$DASHBOARD_API_KEY"
  "EmailDomain=$EMAIL_DOMAIN"
  "IruElevationTag5Min=temp-admin-elevation-5min"
  "IruElevationTag10Min=temp-admin-elevation-10min"
  "IruElevationTag15Min=temp-admin-elevation-15min"
  "IruElevationTag30Min=temp-admin-elevation-30min"
  "IruLogCollectionTag=temp-admin-log-collection"
  "BedrockModelId=us.anthropic.claude-haiku-4-5-20251001-v1:0"
)

if [ -n "$ON_CALL_SLACK_USER_ID" ]; then
  PARAMS+=("OnCallSlackUserId=$ON_CALL_SLACK_USER_ID")
fi

# Pass the dashboard URL if already known (set after the first deploy)
if [ -n "${DASHBOARD_URL:-}" ]; then
  PARAMS+=("DashboardUrl=$DASHBOARD_URL")
fi

# Testing overrides — accelerated timers to make time-based features testable in ~1 hour
if [ "$TESTING" = true ]; then
  PARAMS+=(
    "PendingNudgeIntervalMinutes=5"
    "PendingNudgePhase1Hours=1"
    "PendingNudgePhase2IntervalMinutes=5"
    "PendingAutoDenyHours=1"
  )
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
STACK_NAME="${STACK_NAME:-temp-admin-access}"

if [ "$CONFIRM" = true ]; then
  sam deploy --stack-name "$STACK_NAME" --parameter-overrides "${PARAMS[@]}"
else
  sam deploy --stack-name "$STACK_NAME" --no-confirm-changeset --parameter-overrides "${PARAMS[@]}"
fi

# ---------------------------------------------------------------------------
# Upload dashboard to S3 (after stack is up so the bucket exists)
# ---------------------------------------------------------------------------
echo "==> Fetching stack outputs..."
DASHBOARD_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='DashboardBucketName'].OutputValue" \
  --output text 2>/dev/null || true)

DASHBOARD_URL=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue" \
  --output text 2>/dev/null || true)

if [ -n "$DASHBOARD_BUCKET" ]; then
  echo "==> Uploading dashboard to s3://${DASHBOARD_BUCKET}..."

  # Bake the API endpoint URL into the HTML so the browser doesn't need to prompt for it.
  # The API key is never embedded — authentication uses single-use tokens from Slack links.
  DASHBOARD_API_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='DashboardEndpoint'].OutputValue" \
    --output text 2>/dev/null || true)

  DASHBOARD_HTML_TMP=$(mktemp /tmp/dashboard-XXXXXX.html)
  sed "s|__EMBEDDED_API_URL__|${DASHBOARD_API_ENDPOINT}|g" ../dashboard/index.html > "$DASHBOARD_HTML_TMP"

  aws s3 cp "$DASHBOARD_HTML_TMP" "s3://${DASHBOARD_BUCKET}/index.html" \
    --content-type "text/html" \
    --cache-control "no-cache, no-store, must-revalidate"
  rm -f "$DASHBOARD_HTML_TMP"
  echo "==> Dashboard deployed: ${DASHBOARD_URL}"
  if [ -z "${DASHBOARD_URL:-}" ]; then
    echo ""
    echo "==> First deploy detected. To enable the dashboard link in Slack approval messages,"
    echo "    add this to your .zshrc and re-run ./deploy.sh:"
    echo ""
    echo "    export DASHBOARD_URL=${DASHBOARD_URL}"
    echo ""
  fi
else
  echo "WARNING: Could not determine dashboard bucket name — skipping dashboard upload"
fi
