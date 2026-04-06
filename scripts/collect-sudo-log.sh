#!/bin/bash
# Kandji Library Custom Script — Collect Sudo Log
# Scope to tag: temp-admin-log-collection
# Run: At install (i.e. when the log collection tag is assigned on expiration)
umask 077  # ensure mktemp files are always 0600 regardless of calling environment
#
# Reads elevation metadata written by self-service-request.sh and elevation-start.sh,
# collects sudo log entries for the elevation window, and ships them to the /log endpoint.

# macOS does not ship the GNU `timeout` command. Provide a no-op fallback so scripts
# run on all macOS versions; python3 calls are inherently short so the risk is minimal.
if ! command -v timeout &>/dev/null; then
  timeout() { local _t=$1; shift; "$@"; }
fi

API_ENDPOINT="https://1mng27frfb.execute-api.us-east-1.amazonaws.com/Prod/log"
API_KEY=$(security find-generic-password -a "kandji-temp-admin" -s "kandji-temp-admin-api" -w /Library/Keychains/System.keychain 2>/dev/null)
if [ -z "$API_KEY" ]; then
  echo "$(ts) collect-sudo-log: ERROR — API key not found in system keychain" >&2
  exit 1
fi
META_FILE="/var/root/.kandji-elevation/meta.json"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# ---------------------------------------------------------------------------
# Read metadata written at request and elevation-start time
# ---------------------------------------------------------------------------
if [ ! -f "$META_FILE" ]; then
  echo "$(ts) collect-sudo-log: metadata file not found at $META_FILE" >&2
  exit 1
fi

REQUEST_ID=$(timeout 5 python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('requestId',''))"    "$META_FILE" 2>/dev/null)
START_TIME=$(timeout 5 python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('elevationStart',''))" "$META_FILE" 2>/dev/null)
USERNAME=$(timeout 5 python3   -c "import json,sys; print(json.load(open(sys.argv[1])).get('username',''))"       "$META_FILE" 2>/dev/null)
SERIAL=$(timeout 5 python3     -c "import json,sys; print(json.load(open(sys.argv[1])).get('serial',''))"         "$META_FILE" 2>/dev/null)
END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# N8-06: validate field formats before using in API calls
if [ -z "$REQUEST_ID" ] || ! echo "$REQUEST_ID" | grep -qiE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
  echo "$(ts) collect-sudo-log: invalid or missing requestId in metadata" >&2
  exit 1
fi
if [ -z "$START_TIME" ] || ! echo "$START_TIME" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
  echo "$(ts) collect-sudo-log: invalid or missing elevationStart in metadata" >&2
  exit 1
fi

echo "$(ts) collect-sudo-log: collecting sudo log from $START_TIME to $END_TIME for request $REQUEST_ID"

# ---------------------------------------------------------------------------
# Revoke admin privileges via PrivilegesCLI — do this first so no more
# sudo commands can be run while we collect the log
# ---------------------------------------------------------------------------
PRIVILEGES_CLI="/Applications/Privileges.app/Contents/MacOS/PrivilegesCLI"
if [ -n "$USERNAME" ] && [ -f "$PRIVILEGES_CLI" ]; then
  echo "$(ts) collect-sudo-log: revoking admin for $USERNAME"
  USERNAME_UID=$(id -u "$USERNAME")
  launchctl asuser "$USERNAME_UID" sudo -u "$USERNAME" "$PRIVILEGES_CLI" --remove 2>/dev/null \
    && echo "$(ts) collect-sudo-log: admin revoked via PrivilegesCLI" \
    || echo "$(ts) collect-sudo-log: PrivilegesCLI --remove returned non-zero (may already be standard user)"
else
  echo "$(ts) collect-sudo-log: PrivilegesCLI not found or no username — skipping revocation"
fi

# ---------------------------------------------------------------------------
# Remove sudoers drop-in immediately — stops any further sudo logging
# so the log is frozen before we read it
# ---------------------------------------------------------------------------
SUDO_LOG="/var/log/kandji-sudo-elevation.log"
SUDOERS_DROP_IN="/etc/sudoers.d/kandji-elevation-logging"

if [ -f "$SUDOERS_DROP_IN" ]; then
  rm -f "$SUDOERS_DROP_IN"
  echo "$(ts) collect-sudo-log: sudoers drop-in removed (logging stopped)"
else
  echo "$(ts) collect-sudo-log: sudoers drop-in not present"
fi

# ---------------------------------------------------------------------------
# Collect sudo log — primary: sudoers logfile; fallback: unified log
# ---------------------------------------------------------------------------
FILE_LOG_CONTENT=""
UNIFIED_LOG_CONTENT=""

# Source 1: sudoers logfile (works if macOS sudo honours the logfile directive)
if [ -f "$SUDO_LOG" ]; then
  LOG_SIZE=$(wc -c < "$SUDO_LOG" | tr -d ' ')
  echo "$(ts) collect-sudo-log: sudoers log file exists — ${LOG_SIZE} bytes"
  if [ "$LOG_SIZE" -gt 0 ]; then
    # N3-07: bound log read to 500 KB to prevent memory exhaustion on runaway log files
    FILE_LOG_CONTENT=$(tail -c 500000 "$SUDO_LOG" | grep -E "COMMAND=" 2>/dev/null)
    echo "$(ts) collect-sudo-log: file log entries found: $(echo "$FILE_LOG_CONTENT" | grep -c "COMMAND=" 2>/dev/null)"
  else
    echo "$(ts) collect-sudo-log: sudoers log file is empty — macOS may not honour Defaults logfile"
  fi
  # Note: do NOT delete SUDO_LOG here — delete only after confirmed upload
else
  echo "$(ts) collect-sudo-log: sudoers log file not found"
fi

# Source 2: macOS unified log (sudo logs commands at Info level via syslog)
# Convert UTC elevation start to local time for log show
# N7-11: validate output format — silent failure here causes log show to use wrong time range
LOCAL_START=$(timeout 5 python3 -c "
from datetime import datetime
import sys
try:
    dt = datetime.fromisoformat('$START_TIME'.replace('Z', '+00:00'))
    print(dt.astimezone().strftime('%Y-%m-%d %H:%M:%S'))
except Exception as e:
    sys.exit(1)
" 2>/dev/null)
TIMEZONE_DEGRADED=""
if [ -z "$LOCAL_START" ] || ! echo "$LOCAL_START" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'; then
  echo "$(ts) collect-sudo-log: WARNING — could not convert START_TIME to local time, skipping unified log source"
  LOCAL_START=""
  TIMEZONE_DEGRADED="1"
fi

LOCAL_END=$(timeout 5 python3 -c "
from datetime import datetime
import sys
try:
    dt = datetime.fromisoformat('$END_TIME'.replace('Z', '+00:00'))
    print(dt.astimezone().strftime('%Y-%m-%d %H:%M:%S'))
except Exception as e:
    sys.exit(1)
" 2>/dev/null)
if [ -z "$LOCAL_END" ] || ! echo "$LOCAL_END" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'; then
  echo "$(ts) collect-sudo-log: WARNING — could not convert END_TIME to local time, skipping unified log source"
  LOCAL_END=""
  TIMEZONE_DEGRADED="1"
fi

echo "$(ts) collect-sudo-log: querying unified log from $LOCAL_START to $LOCAL_END"

UNIFIED_RAW=$(log show \
  --predicate 'process == "sudo" AND message CONTAINS "COMMAND="' \
  --info \
  --start "$LOCAL_START" \
  --end "$LOCAL_END" 2>/dev/null | grep -v "^Filtering" | grep -v "^$" | grep -v "^---" | grep "COMMAND=")

if [ -n "$UNIFIED_RAW" ]; then
  UNIFIED_LOG_CONTENT="$UNIFIED_RAW"
  echo "$(ts) collect-sudo-log: unified log entries found: $(echo "$UNIFIED_LOG_CONTENT" | wc -l | tr -d ' ')"
else
  echo "$(ts) collect-sudo-log: no entries in unified log matching COMMAND= for this window"
fi

# Merge both sources, deduplicate
if [ -n "$FILE_LOG_CONTENT" ] && [ -n "$UNIFIED_LOG_CONTENT" ]; then
  LOG_CONTENT=$(printf '%s\n%s' "$FILE_LOG_CONTENT" "$UNIFIED_LOG_CONTENT" | sort -u)
elif [ -n "$FILE_LOG_CONTENT" ]; then
  LOG_CONTENT="$FILE_LOG_CONTENT"
elif [ -n "$UNIFIED_LOG_CONTENT" ]; then
  LOG_CONTENT="$UNIFIED_LOG_CONTENT"
else
  LOG_CONTENT=""
fi

if [ -z "$LOG_CONTENT" ]; then
  LOG_CONTENT="No sudo commands were recorded during the elevation window (${START_TIME} to ${END_TIME})."
fi

# N8-14: if timezone conversion failed, unified log source was skipped — prepend a
# visible warning so IT knows the log may be incomplete even if the file source is empty.
if [ -n "$TIMEZONE_DEGRADED" ]; then
  LOG_CONTENT="[WARNING: unified log source skipped — timezone conversion failed on this device. Log below reflects sudoers file source only and may be incomplete.]
$LOG_CONTENT"
fi

# N8-07: cap merged log content at 90 KB before JSON encoding to prevent memory
# exhaustion from an unbounded unified log query on high-sudo-activity sessions.
LOG_BYTE_COUNT=$(printf '%s' "$LOG_CONTENT" | wc -c | tr -d ' ')
if [ "$LOG_BYTE_COUNT" -gt 92160 ]; then
  echo "$(ts) collect-sudo-log: log content ${LOG_BYTE_COUNT} bytes — truncating to 90 KB"
  LOG_CONTENT=$(printf '%s' "$LOG_CONTENT" | tail -c 92160)
fi

echo "$(ts) collect-sudo-log: log content to be shipped:"
echo "---"
echo "$LOG_CONTENT"
echo "---"

# ---------------------------------------------------------------------------
# Escape log content for JSON
# ---------------------------------------------------------------------------
ESCAPED=$(echo "$LOG_CONTENT" | timeout 5 python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')

if [ $? -ne 0 ] || [ -z "$ESCAPED" ]; then
  echo "$(ts) collect-sudo-log: failed to JSON-encode log content" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# POST to /log endpoint — retry up to 3 times with 5s backoff
# ---------------------------------------------------------------------------
HTTP_STATUS=""
ATTEMPT=0
while [ $ATTEMPT -lt 3 ]; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "$(ts) collect-sudo-log: upload attempt $ATTEMPT of 3"
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$API_ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $API_KEY" \
    --max-time 30 \
    -d "{\"requestId\":\"$REQUEST_ID\",\"serial\":\"$SERIAL\",\"logContent\":$ESCAPED}")
  if [ "$HTTP_STATUS" = "200" ]; then
    break
  fi
  echo "$(ts) collect-sudo-log: attempt $ATTEMPT returned HTTP $HTTP_STATUS — retrying in 5s" >&2
  [ $ATTEMPT -lt 3 ] && sleep 5
done

if [ "$HTTP_STATUS" = "200" ]; then
  echo "$(ts) collect-sudo-log: log shipped successfully for request $REQUEST_ID"

  # Truncate before removal so data blocks are overwritten on disk (N4-08)
  : > "$SUDO_LOG"
  rm -f "$SUDO_LOG"

  # Clean up metadata file
  rm -f "$META_FILE"

  # Clean up approval monitor LaunchDaemon if still present (edge case: session
  # expired or was force-revoked while approval monitor was still polling)
  APPROVAL_PLIST="/Library/LaunchDaemons/com.kitchman.admin-approval-monitor.plist"
  APPROVAL_SCRIPT="/usr/local/bin/kandji-approval-monitor.sh"
  if [ -f "$APPROVAL_PLIST" ]; then
    launchctl unload "$APPROVAL_PLIST" 2>/dev/null
    rm -f "$APPROVAL_PLIST" "$APPROVAL_SCRIPT" /var/tmp/kandji-approval-attempt
    echo "$(ts) collect-sudo-log: approval monitor LaunchDaemon removed"
  fi

  # Clean up network monitor LaunchDaemon if still present
  NETWORK_PLIST="/Library/LaunchDaemons/com.kitchman.admin-network-monitor.plist"
  NETWORK_SCRIPT="/usr/local/bin/kandji-admin-network-monitor.sh"
  if [ -f "$NETWORK_PLIST" ]; then
    launchctl unload "$NETWORK_PLIST" 2>/dev/null
    rm -f "$NETWORK_PLIST"
    echo "$(ts) collect-sudo-log: network monitor LaunchDaemon removed"
  fi
  rm -f "$NETWORK_SCRIPT" 2>/dev/null

  # Clean up expiration runner LaunchDaemon and script if still present
  RUNNER_PLIST="/Library/LaunchDaemons/com.kitchman.admin-expiration-runner.plist"
  RUNNER_SCRIPT="/usr/local/bin/kandji-expiration-runner.sh"
  if [ -f "$RUNNER_PLIST" ]; then
    launchctl unload "$RUNNER_PLIST" 2>/dev/null
    rm -f "$RUNNER_PLIST"
    echo "$(ts) collect-sudo-log: expiration runner LaunchDaemon removed"
  fi
  rm -f "$RUNNER_SCRIPT" 2>/dev/null

  # Release the kandji run lock if we're cleaning up mid-run
  rm -f /var/run/kandji-run.lock 2>/dev/null
else
  echo "$(ts) collect-sudo-log: upload failed with HTTP $HTTP_STATUS" >&2
  exit 1
fi
