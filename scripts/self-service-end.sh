#!/bin/bash
# Iru Self Service — End Temporary Admin Access Early
# Deploy as a Self Service script alongside the request script.
# Users run this from Self Service when they're finished and want to
# return admin privileges before the timer expires.
umask 077

if ! command -v timeout &>/dev/null; then
  timeout() { local _t=$1; shift; "$@"; }
fi

END_ENDPOINT="https://1mng27frfb.execute-api.us-east-1.amazonaws.com/Prod/end"
META_DIR="/var/root/.iru-elevation"
META_FILE="$META_DIR/meta.json"

echo "--- End Admin Access Script Starting ---"

# ---------------------------------------------------------------------------
# Read API key from keychain
# ---------------------------------------------------------------------------
API_KEY=$(security find-generic-password -a "iru-temp-admin" -s "iru-temp-admin-api" -w /Library/Keychains/System.keychain 2>/dev/null)
if [ -z "$API_KEY" ]; then
  echo "ERROR: API key not found in system keychain"
  /usr/local/bin/kandji display-alert --title "Error" \
    --message "Could not find the API key. Please contact IT."
  exit 1
fi

# ---------------------------------------------------------------------------
# Read requestId from elevation metadata
# ---------------------------------------------------------------------------
if [ ! -f "$META_FILE" ]; then
  echo "No meta file found — no active session"
  /usr/local/bin/kandji display-alert --title "No Active Session" \
    --message "You don't have an active admin access session to end."
  exit 0
fi

REQUEST_ID=$(timeout 5 python3 -c "
import json, sys
try:
    print(json.load(open(sys.argv[1])).get('requestId', ''))
except:
    print('')
" "$META_FILE" 2>/dev/null)

if [ -z "$REQUEST_ID" ]; then
  echo "No requestId in meta file — no active session"
  /usr/local/bin/kandji display-alert --title "No Active Session" \
    --message "You don't have an active admin access session to end."
  exit 0
fi

echo "Ending session for requestId: $REQUEST_ID"

# ---------------------------------------------------------------------------
# Get serial number for server-side ownership verification
# ---------------------------------------------------------------------------
SERIAL=$(system_profiler SPHardwareDataType | awk '/Serial Number/{print $NF}')
if [ -z "$SERIAL" ]; then
  echo "ERROR: Could not determine serial number"
  /usr/local/bin/kandji display-alert --title "Error" \
    --message "Could not determine device serial number. Please contact IT."
  exit 1
fi

# ---------------------------------------------------------------------------
# POST /end
# ---------------------------------------------------------------------------
RESPONSE_FILE=$(mktemp /tmp/iru-end-XXXXXX)
chmod 600 "$RESPONSE_FILE"

HTTP_CODE=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  --max-time 15 \
  -d "{\"requestId\":\"$REQUEST_ID\",\"serial\":\"$SERIAL\"}" \
  "$END_ENDPOINT" 2>/dev/null)

echo "Response HTTP $HTTP_CODE: $(cat "$RESPONSE_FILE")"

case "$HTTP_CODE" in
  200)
    /usr/local/bin/kandji display-alert --title "Session Ended" \
      --message "Your admin access session has been ended. Iru will remove your admin privileges on the next check-in (within a few minutes)." \
      --no-wait
    ;;
  409)
    /usr/local/bin/kandji display-alert --title "No Active Session" \
      --message "Your session has already expired or been ended — no action needed."
    ;;
  401|403)
    /usr/local/bin/kandji display-alert --title "Error" \
      --message "Authentication error. Please contact IT."
    ;;
  *)
    /usr/local/bin/kandji display-alert --title "Error" \
      --message "Could not end your session (error $HTTP_CODE). Please contact IT."
    ;;
esac

rm -f "$RESPONSE_FILE"
exit 0
