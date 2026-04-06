#!/bin/bash
# Kandji Self Service — Request Temporary Admin Access
# Deploy as a Self Service script in the Kandji Library.
umask 077  # ensure mktemp files are always 0600 regardless of calling environment

# macOS does not ship the GNU `timeout` command. Provide a no-op fallback so scripts
# run on all macOS versions; python3 calls are inherently short so the risk is minimal.
if ! command -v timeout &>/dev/null; then
  timeout() { local _t=$1; shift; "$@"; }
fi

API_ENDPOINT="https://1mng27frfb.execute-api.us-east-1.amazonaws.com/Prod/request"
RESPONSE_FILE=$(mktemp /tmp/kandji-request-XXXXXX)
chmod 600 "$RESPONSE_FILE"
API_KEY=$(security find-generic-password -a "kandji-temp-admin" -s "kandji-temp-admin-api" -w /Library/Keychains/System.keychain 2>/dev/null)
if [ -z "$API_KEY" ]; then
  echo "ERROR: API key not found in system keychain — run the provisioning script first" >&2
  exit 1
fi
META_DIR="/var/root/.kandji-elevation"
META_FILE="$META_DIR/meta.json"
install -d -m 700 "$META_DIR"
chmod 700 "$META_DIR"  # Re-enforce in case directory already existed with looser permissions

echo "--- Admin Access Request Script Starting ---"

# ---------------------------------------------------------------------------
# Collect device identity
# ---------------------------------------------------------------------------
echo "Collecting device info..."
SERIAL=$(system_profiler SPHardwareDataType | awk '/Serial Number/{print $NF}')
HOSTNAME=$(scutil --get ComputerName)
USERNAME=$(stat -f "%Su" /dev/console)

echo "Serial: $SERIAL"
echo "Hostname: $HOSTNAME"
echo "Username: $USERNAME"

if [ -z "$SERIAL" ] || [ -z "$USERNAME" ]; then
  echo "ERROR: Could not determine serial or username"
  /usr/local/bin/kandji display-alert --title "Error" --message "Could not determine device information. Please contact IT."
  exit 1
fi

# ---------------------------------------------------------------------------
# Check if user already has admin access — show remaining time if so
# ---------------------------------------------------------------------------
IS_ADMIN=$(dseditgroup -o checkmember -m "$USERNAME" admin 2>/dev/null | grep -c "yes")

if [ "$IS_ADMIN" -gt 0 ] && [ -f "$META_FILE" ]; then
  echo "User $USERNAME is already an admin — checking remaining time"

  ELEVATION_END=$(timeout 5 python3 -c "
import json, sys
try:
    print(json.load(open(sys.argv[1])).get('elevationEnd', ''))
except:
    print('')
" "$META_FILE" 2>/dev/null)

  if [ -n "$ELEVATION_END" ]; then
    REMAINING=$(timeout 5 python3 -c "
from datetime import datetime, timezone, timedelta
import sys
end = datetime.fromisoformat(sys.argv[1].replace('Z', '+00:00'))
now = datetime.now(timezone.utc)
diff = int((end - now).total_seconds())
if diff > 0:
    mins = diff // 60
    secs = diff % 60
    print(f'{mins}m {secs}s')
else:
    print('expiring soon')
" "$ELEVATION_END" 2>/dev/null)
    /usr/local/bin/kandji display-alert --title "Admin Access Active" \
      --message "You already have temporary admin access. Time remaining: $REMAINING."
  else
    /usr/local/bin/kandji display-alert --title "Admin Access Active" \
      --message "You already have temporary admin access."
  fi

  echo "User already has admin — exiting"
  exit 0
fi

# ---------------------------------------------------------------------------
# Prompt user for a reason — osascript required here for text input
# ---------------------------------------------------------------------------
echo "Prompting user for reason..."
CURRENT_USER_UID=$(id -u "$USERNAME")

REASON=$(launchctl asuser "$CURRENT_USER_UID" sudo -u "$USERNAME" osascript \
  -e 'Tell application "System Events" to display dialog "Please enter the reason for requesting temporary admin access:" default answer "" with title "Admin Access Request" buttons {"Cancel", "Submit"} default button "Submit"' \
  -e 'text returned of result' 2>/dev/null)

OSASCRIPT_EXIT=$?
echo "Dialog exit code: $OSASCRIPT_EXIT"
echo "Reason provided: $REASON"

if [ $OSASCRIPT_EXIT -ne 0 ] || [ -z "$REASON" ]; then
  echo "User cancelled or provided no reason — exiting cleanly"
  /usr/local/bin/kandji display-alert --title "Admin Access Request" --message "Request cancelled." --no-wait
  exit 0
fi

# ---------------------------------------------------------------------------
# Build JSON payload
# ---------------------------------------------------------------------------
echo "Building request payload..."
SERIAL_SAFE=$(echo "$SERIAL" | tr -d '\000-\037')
HOSTNAME_SAFE=$(echo "$HOSTNAME" | tr -d '\000-\037')
# N8-19: whitelist USERNAME — allow only alphanumeric, dot, underscore, hyphen.
# tr -d removes ASCII control chars; sed removes Unicode zero-width and other non-whitelisted chars.
USERNAME_SAFE=$(echo "$USERNAME" | tr -d '\000-\037' | sed 's/[^a-zA-Z0-9._-]//g')
REASON_SAFE=$(echo "$REASON" | tr -d '\000-\037')
# Read email from macOS Directory Services — works reliably in Self Service context
EMAIL_RAW=$(dscl . -read /Users/"$USERNAME" EMailAddress 2>/dev/null | awk '/EMailAddress:/{print $2}')
EMAIL_SAFE=$(echo "$EMAIL_RAW" | tr -d '\000-\037')
echo "Email (from Directory Services): $EMAIL_SAFE"

PAYLOAD=$(timeout 5 python3 -c "
import json, sys
print(json.dumps({
    'serial':   sys.argv[1],
    'hostname': sys.argv[2],
    'username': sys.argv[3],
    'reason':   sys.argv[4],
    'email':    sys.argv[5]
}))
" "$SERIAL_SAFE" "$HOSTNAME_SAFE" "$USERNAME_SAFE" "$REASON_SAFE" "$EMAIL_SAFE")

if [ $? -ne 0 ] || [ -z "$PAYLOAD" ]; then
  echo "ERROR: Failed to build JSON payload"
  exit 1
fi

echo "Payload: $PAYLOAD"

# ---------------------------------------------------------------------------
# Submit request to API Gateway
# ---------------------------------------------------------------------------
echo "Submitting request to $API_ENDPOINT..."

HTTP_STATUS=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" \
  -X POST "$API_ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  --max-time 60 \
  -d "$PAYLOAD")

CURL_EXIT=$?
BODY=$(cat "$RESPONSE_FILE")
rm -f "$RESPONSE_FILE"

echo "curl exit code: $CURL_EXIT"

if [ $CURL_EXIT -ne 0 ]; then
  echo "ERROR: curl failed with exit code $CURL_EXIT"
  /usr/local/bin/kandji display-alert --title "Request Failed" \
    --message "Network error. Please check your connection and try again."
  exit 1
fi

echo "HTTP status: $HTTP_STATUS"
echo "Response body: $BODY"

if [ "$HTTP_STATUS" != "200" ]; then
  echo "ERROR: API returned HTTP $HTTP_STATUS"
  /usr/local/bin/kandji display-alert --title "Request Failed" \
    --message "Server returned an error (HTTP $HTTP_STATUS). Please contact IT."
  exit 1
fi

# ---------------------------------------------------------------------------
# Parse requestId and write metadata file
# ---------------------------------------------------------------------------
echo "Parsing requestId from response..."
REQUEST_ID=$(echo "$BODY" | timeout 5 python3 -c "import json,sys; print(json.load(sys.stdin).get('requestId',''))" 2>/dev/null)

if [ -z "$REQUEST_ID" ]; then
  echo "ERROR: No requestId in response"
  exit 1
fi

echo "Request ID: $REQUEST_ID"

# N5-07: atomic write — write to temp file first, then mv to final path
META_TMPFILE=$(mktemp /tmp/kandji-meta-XXXXXX)
chmod 600 "$META_TMPFILE"

timeout 5 python3 -c "
import json, sys
meta_file, request_id, username, hostname, serial = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
with open(meta_file, 'w') as f:
    json.dump({'requestId': request_id, 'username': username, 'hostname': hostname, 'serial': serial}, f)
" "$META_TMPFILE" "$REQUEST_ID" "$USERNAME_SAFE" "$HOSTNAME_SAFE" "$SERIAL_SAFE"

if [ $? -ne 0 ]; then
  echo "ERROR: Failed to write metadata file"
  rm -f "$META_TMPFILE"
  exit 1
fi

mv "$META_TMPFILE" "$META_FILE"
chmod 600 "$META_FILE"
echo "Metadata written to $META_FILE"

# ---------------------------------------------------------------------------
# Notify user of success, then install an approval-monitor LaunchDaemon.
# The daemon polls /status every 20 seconds in the background so this script
# can exit immediately — avoids blocking the Kandji agent while waiting.
# ---------------------------------------------------------------------------
echo "Request submitted successfully"
/usr/local/bin/kandji display-alert --title "Admin Access Request" \
  --message "Your request has been submitted and is pending IT approval. You will be notified once a decision is made." \
  --no-wait

STATUS_ENDPOINT="https://1mng27frfb.execute-api.us-east-1.amazonaws.com/Prod/status"
APPROVAL_MONITOR_SCRIPT="/usr/local/bin/kandji-approval-monitor.sh"
APPROVAL_MONITOR_PLIST="/Library/LaunchDaemons/com.kitchman.admin-approval-monitor.plist"
APPROVAL_ATTEMPT_FILE="/var/tmp/kandji-approval-attempt"

# Clean up any previous approval monitor before installing a fresh one.
# N8-04: remove files before unloading from launchd — launchctl remove uses the label
# (not the file path) so it works even after the file is gone. This prevents a window
# where the plist exists on disk but the daemon has new content, if interrupted mid-cleanup.
if [ -f "$APPROVAL_MONITOR_PLIST" ]; then
  rm -f "$APPROVAL_MONITOR_PLIST" "$APPROVAL_MONITOR_SCRIPT" "$APPROVAL_ATTEMPT_FILE"
  launchctl remove com.kitchman.admin-approval-monitor 2>/dev/null
  echo "Previous approval monitor cleaned up"
fi

# Write the approval monitor script — REQUEST_ID and SERIAL are interpolated now;
# API key is fetched from keychain at runtime (supports key rotation, mirrors N6-09).
cat > "$APPROVAL_MONITOR_SCRIPT" << MONITOR_EOF
#!/bin/bash
REQUEST_ID="$REQUEST_ID"
SERIAL="$SERIAL_SAFE"
USERNAME="$USERNAME_SAFE"
STATUS_ENDPOINT="$STATUS_ENDPOINT"
APPROVAL_MONITOR_PLIST="/Library/LaunchDaemons/com.kitchman.admin-approval-monitor.plist"
APPROVAL_MONITOR_SCRIPT="/usr/local/bin/kandji-approval-monitor.sh"
ATTEMPT_FILE="/var/tmp/kandji-approval-attempt"
MAX_ATTEMPTS=15

KANDJI_RUN_LOCK="/var/run/kandji-run.lock"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

cleanup() {
  launchctl unload "\$APPROVAL_MONITOR_PLIST" 2>/dev/null
  rm -f "\$APPROVAL_MONITOR_PLIST" "\$APPROVAL_MONITOR_SCRIPT" "\$ATTEMPT_FILE"
}

# Acquire the kandji run lock — waits up to 120s if another kandji run is in progress.
# N8-08: PID is written to the lock file so a dead holder is detected immediately
# rather than waiting out the full 120s timeout.
# Uses /var/run/ so stale locks are automatically cleared on reboot.
acquire_kandji_run_lock() {
  local waited=0
  # Remove stale lock immediately if the holding PID is no longer alive
  if [ -f "\$KANDJI_RUN_LOCK" ]; then
    local lock_pid
    lock_pid=\$(cat "\$KANDJI_RUN_LOCK" 2>/dev/null)
    if [ -n "\$lock_pid" ] && ! kill -0 "\$lock_pid" 2>/dev/null; then
      echo "\$(ts) approval-monitor: stale lock (PID \$lock_pid is dead) — removing"
      rm -f "\$KANDJI_RUN_LOCK"
    fi
  fi
  while [ -f "\$KANDJI_RUN_LOCK" ]; do
    if [ \$waited -ge 120 ]; then
      echo "\$(ts) approval-monitor: kandji run lock timed out after \${waited}s — proceeding"
      break
    fi
    local lock_pid
    lock_pid=\$(cat "\$KANDJI_RUN_LOCK" 2>/dev/null)
    if [ -n "\$lock_pid" ] && ! kill -0 "\$lock_pid" 2>/dev/null; then
      echo "\$(ts) approval-monitor: stale lock (PID \$lock_pid is dead) — removing"
      rm -f "\$KANDJI_RUN_LOCK"
      break
    fi
    echo "\$(ts) approval-monitor: kandji run in progress (locked by PID \$lock_pid) — waiting..."
    sleep 5
    waited=\$((waited + 5))
  done
  echo \$\$ > "\$KANDJI_RUN_LOCK"
}

release_kandji_run_lock() {
  rm -f "\$KANDJI_RUN_LOCK"
}

# Increment and read attempt counter — persisted across daemon invocations
ATTEMPT=\$(cat "\$ATTEMPT_FILE" 2>/dev/null || echo 0)
ATTEMPT=\$((ATTEMPT + 1))
echo "\$ATTEMPT" > "\$ATTEMPT_FILE"
echo "\$(ts) approval-monitor: poll attempt \$ATTEMPT of \$MAX_ATTEMPTS"

if [ "\$ATTEMPT" -gt "\$MAX_ATTEMPTS" ]; then
  echo "\$(ts) approval-monitor: timed out after \$MAX_ATTEMPTS attempts — request still pending"
  /usr/local/bin/kandji display-alert --title "Admin Access Request" \
    --message "Your request is still pending IT approval. You will receive a Slack DM when a decision is made — no need to re-submit." \
    --no-wait
  cleanup
  exit 0
fi

# Fetch API key each cycle so key rotation takes effect without reinstalling the daemon
API_KEY=\$(security find-generic-password -a "kandji-temp-admin" -s "kandji-temp-admin-api" -w /Library/Keychains/System.keychain 2>/dev/null)
if [ -z "\$API_KEY" ]; then
  echo "\$(ts) approval-monitor: API key not found in keychain — skipping cycle"
  exit 0
fi

STATUS_TMPFILE=\$(mktemp /tmp/kandji-approval-XXXXXX)
chmod 600 "\$STATUS_TMPFILE"
HTTP_CODE=\$(curl -s -o "\$STATUS_TMPFILE" -w "%{http_code}" \
  -H "x-api-key: \$API_KEY" \
  --max-time 10 \
  "\${STATUS_ENDPOINT}?requestId=\${REQUEST_ID}&serial=\${SERIAL}" 2>/dev/null)

case "\$HTTP_CODE" in
  200)
    CURRENT_STATUS=\$(python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" < "\$STATUS_TMPFILE" 2>/dev/null)
    echo "\$(ts) approval-monitor: status=\$CURRENT_STATUS"

    if [ "\$CURRENT_STATUS" = "approved" ]; then
      rm -f "\$STATUS_TMPFILE"
      echo "\$(ts) approval-monitor: approved — showing alert and running kandji run"
      /usr/local/bin/kandji display-alert --title "Admin Access Approved" \
        --message "Your request was approved! Applying changes now — you will be elevated to admin shortly." \
        --no-wait
      # Ignore SIGTERM during the critical section — cleanup() calls launchctl unload
      # which sends SIGTERM to this process. Without the trap, the signal can arrive
      # mid-kandji-run and kill it before it finishes processing the elevation tag.
      trap '' TERM
      echo "\$(ts) approval-monitor: waiting 5s for Kandji tag propagation..."
      sleep 5
      acquire_kandji_run_lock
      echo "\$(ts) approval-monitor: running kandji run..."
      /usr/local/bin/kandji run --reset-daily >> /var/log/kandji-elevation.log 2>&1
      echo "\$(ts) approval-monitor: kandji run exited with code \$?"
      release_kandji_run_lock
      # Verify elevation took effect — retry once after 30s if not yet admin
      IS_ADMIN=\$(dseditgroup -o checkmember -m "\$USERNAME" admin 2>/dev/null | grep -c "yes")
      if [ "\$IS_ADMIN" -eq 0 ]; then
        echo "\$(ts) approval-monitor: elevation not confirmed after first kandji run — waiting 30s before retry..."
        sleep 30
        acquire_kandji_run_lock
        echo "\$(ts) approval-monitor: retry kandji run (elevation not yet confirmed)..."
        /usr/local/bin/kandji run --reset-daily >> /var/log/kandji-elevation.log 2>&1
        echo "\$(ts) approval-monitor: retry kandji run exited with code \$?"
        release_kandji_run_lock
        IS_ADMIN=\$(dseditgroup -o checkmember -m "\$USERNAME" admin 2>/dev/null | grep -c "yes")
        if [ "\$IS_ADMIN" -eq 0 ]; then
          echo "\$(ts) approval-monitor: WARNING — user still not admin after retry; elevation-start.sh may need investigation"
        else
          echo "\$(ts) approval-monitor: elevation confirmed after retry"
        fi
      else
        echo "\$(ts) approval-monitor: elevation confirmed"
      fi
      # Keep SIGTERM ignored through cleanup — restoring it before launchctl unload
      # causes the process to be killed before rm -f completes, leaving stale files.
      cleanup
      exit 0

    elif [ "\$CURRENT_STATUS" = "denied" ]; then
      rm -f "\$STATUS_TMPFILE"
      echo "\$(ts) approval-monitor: denied — cleaning up"
      /usr/local/bin/kandji display-alert --title "Admin Access Denied" \
        --message "Your temporary admin access request was denied by IT. Please reach out to IT if you have questions."
      cleanup
      exit 0
    fi
    ;;
  401|403)
    echo "\$(ts) approval-monitor: auth error \$HTTP_CODE — stopping monitor"
    cleanup
    exit 0
    ;;
  *)
    echo "\$(ts) approval-monitor: HTTP \$HTTP_CODE — transient error, will retry next cycle"
    ;;
esac

rm -f "\$STATUS_TMPFILE"
MONITOR_EOF

chmod 700 "$APPROVAL_MONITOR_SCRIPT"

# Write the LaunchDaemon plist — fires every 20 seconds, runs immediately on load
cat > "$APPROVAL_MONITOR_PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.kitchman.admin-approval-monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$APPROVAL_MONITOR_SCRIPT</string>
  </array>
  <key>StartInterval</key>
  <integer>20</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/kandji-elevation.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/kandji-elevation.log</string>
</dict>
</plist>
PLIST_EOF

chmod 644 "$APPROVAL_MONITOR_PLIST"
launchctl load "$APPROVAL_MONITOR_PLIST"
echo "Approval monitor LaunchDaemon installed — script exiting, polling continues in background"
exit 0
