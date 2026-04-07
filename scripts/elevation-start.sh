#!/bin/bash
# Iru Library Custom Script — Elevation Start
# Scope to tag: temp-admin-elevation
# Run: At install (i.e. when the tag is assigned to the device)
#
# Records the elevation start timestamp and automatically grants admin
# access via PrivilegesCLI so the user doesn't need to open Privileges manually.
umask 077  # ensure mktemp files are always 0600 regardless of calling environment

# macOS does not ship the GNU `timeout` command. Provide a no-op fallback so scripts
# run on all macOS versions; python3 calls are inherently short so the risk is minimal.
if ! command -v timeout &>/dev/null; then
  timeout() { local _t=$1; shift; "$@"; }
fi

META_DIR="/var/root/.iru-elevation"
META_FILE="$META_DIR/meta.json"
PRIVILEGES_CLI="/Applications/Privileges.app/Contents/MacOS/PrivilegesCLI"

# ---------------------------------------------------------------------------
# Clean up any stale network monitor daemon from a previous session BEFORE
# granting admin. If a previous session ended with network loss, the old
# daemon's enforcement loop is still running and will immediately re-revoke
# the new elevation the moment admin is granted.
# ---------------------------------------------------------------------------
NETWORK_PLIST="/Library/LaunchDaemons/com.kitchman.admin-network-monitor.plist"
if [ -f "$NETWORK_PLIST" ]; then
  echo "elevation-start: unloading stale network monitor from previous session"
  launchctl unload "$NETWORK_PLIST" 2>/dev/null || true
  rm -f "$NETWORK_PLIST"
  echo "elevation-start: stale network monitor removed"
fi
rm -f "/var/tmp/iru-revoke-network-pending"

if [ ! -f "$META_FILE" ]; then
  echo "elevation-start: metadata file not found, cannot record start time" >&2
  exit 1
fi

START_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# N6-05: atomic metadata update helper — reads, modifies, writes to tmp, then mv
# Prevents partial writes if the script is interrupted mid-update.
update_meta() {
  local key="$1" value="$2"
  local tmp
  tmp=$(mktemp /tmp/iru-meta-XXXXXX) || return 1
  chmod 600 "$tmp"
  timeout 5 python3 -c "
import json, sys
meta_file, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
with open(meta_file, 'r') as f:
    meta = json.load(f)
meta[key] = val
with open(sys.argv[4], 'w') as f:
    json.dump(meta, f)
" "$META_FILE" "$key" "$value" "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$META_FILE"
  chmod 600 "$META_FILE"
}

# Add elevationStart to the existing metadata JSON
update_meta 'elevationStart' "$START_TIME"
echo "elevation-start: recorded start time $START_TIME"

# Store $EMAIL from Iru global variable into metadata — Library Items receive globals,
# Self Service scripts do not, so this is the reliable place to capture it
if [ -n "$EMAIL" ]; then
  update_meta 'email' "$EMAIL" 2>/dev/null
  echo "elevation-start: stored email $EMAIL in metadata"
else
  echo "elevation-start: \$EMAIL global not available in this context"
fi

# ---------------------------------------------------------------------------
# Auto-elevate the user via PrivilegesCLI — no manual interaction required
# ---------------------------------------------------------------------------
CURRENT_USER=$(stat -f "%Su" /dev/console)

if [ -z "$CURRENT_USER" ] || [ "$CURRENT_USER" = "root" ]; then
  echo "elevation-start: could not determine logged-in user" >&2
  exit 1
fi

# Wait up to 60 seconds for Privileges to finish installing
WAIT=0
while [ ! -f "$PRIVILEGES_CLI" ] && [ $WAIT -lt 60 ]; do
  echo "elevation-start: waiting for PrivilegesCLI... ($WAIT s)"
  sleep 1
  WAIT=$((WAIT + 1))
done

if [ ! -f "$PRIVILEGES_CLI" ]; then
  echo "elevation-start: PrivilegesCLI not found after 60s" >&2
  exit 1
fi

echo "elevation-start: granting admin to $CURRENT_USER via PrivilegesCLI"
CURRENT_USER_UID=$(id -u "$CURRENT_USER")
launchctl asuser "$CURRENT_USER_UID" sudo -u "$CURRENT_USER" "$PRIVILEGES_CLI" --add

if [ $? -eq 0 ]; then
  echo "elevation-start: admin granted successfully to $CURRENT_USER"
else
  echo "elevation-start: PrivilegesCLI --add failed" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Enable sudo command logging for the duration of this elevation window
# ---------------------------------------------------------------------------
SUDO_LOG="/var/log/iru-sudo-elevation.log"
SUDOERS_DROP_IN="/etc/sudoers.d/iru-elevation-logging"

# Verify /etc/sudoers includes the sudoers.d directory
if grep -qE '#includedir.*/sudoers\.d' /etc/sudoers 2>/dev/null; then
  echo "elevation-start: /etc/sudoers.d is included in sudoers ✓"
else
  echo "elevation-start: WARNING — /etc/sudoers.d not found in /etc/sudoers; sudo logging will not work" >&2
fi

# Write drop-in via temp file + visudo validation — prevents breaking sudo if syntax is wrong
SUDOERS_TMP=$(mktemp /tmp/iru-sudoers-XXXXXX)
chmod 440 "$SUDOERS_TMP"
printf 'Defaults log_allowed\nDefaults logfile="%s"\n' "$SUDO_LOG" > "$SUDOERS_TMP"
if visudo -c -f "$SUDOERS_TMP" 2>/dev/null; then
  mv "$SUDOERS_TMP" "$SUDOERS_DROP_IN"
  chmod 440 "$SUDOERS_DROP_IN"
else
  rm -f "$SUDOERS_TMP"
  echo "elevation-start: ERROR — sudoers drop-in failed visudo check, sudo logging disabled" >&2
fi
: > "$SUDO_LOG"
chmod 600 "$SUDO_LOG"
echo "elevation-start: sudo command logging enabled → $SUDO_LOG"
echo "elevation-start: drop-in content: $(cat "$SUDOERS_DROP_IN")"

# ---------------------------------------------------------------------------
# Notify backend that elevation is confirmed — this starts the 30-min timer
# ---------------------------------------------------------------------------
API_ENDPOINT="https://1mng27frfb.execute-api.us-east-1.amazonaws.com/Prod/start"
API_KEY=$(security find-generic-password -a "iru-temp-admin" -s "iru-temp-admin-api" -w /Library/Keychains/System.keychain 2>/dev/null)
if [ -z "$API_KEY" ]; then
  echo "elevation-start: ERROR — API key not found in system keychain" >&2
  exit 1
fi

REQUEST_ID=$(timeout 5 python3 -c "import json, sys; print(json.load(open(sys.argv[1])).get('requestId',''))" "$META_FILE" 2>/dev/null)
SERIAL=$(timeout 5 python3 -c "import json, sys; print(json.load(open(sys.argv[1])).get('serial',''))" "$META_FILE" 2>/dev/null)

if [ -z "$REQUEST_ID" ]; then
  echo "elevation-start: could not read requestId from metadata — timer not started" >&2
  exit 1
fi

# N6-17: verify stored serial matches the current device — prevents metadata from a
# cloned or copied device from starting a timer on the wrong request
CURRENT_SERIAL=$(system_profiler SPHardwareDataType | awk '/Serial Number/{print $NF}')
if [ -z "$CURRENT_SERIAL" ] || [ "$CURRENT_SERIAL" != "$SERIAL" ]; then
  echo "elevation-start: device serial mismatch (stored=$SERIAL current=$CURRENT_SERIAL) — aborting" >&2
  exit 1
fi

# Validate requestId is a UUID before embedding it in generated scripts
if ! echo "$REQUEST_ID" | grep -qiE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
  echo "elevation-start: requestId failed UUID validation: $REQUEST_ID" >&2
  exit 1
fi

# Validate SERIAL — Mac serial numbers are 8-14 uppercase alphanumeric characters
if [ -z "$SERIAL" ] || ! echo "$SERIAL" | grep -qE '^[A-Z0-9]{8,14}$'; then
  echo "elevation-start: SERIAL failed validation: $SERIAL" >&2
  exit 1
fi

ELEVATION_RESPONSE_FILE=$(mktemp /tmp/iru-elevation-XXXXXX)
chmod 600 "$ELEVATION_RESPONSE_FILE"

# N8-05: build POST body via python3 json.dumps — structurally safe regardless of
# any future upstream validation changes; avoids shell interpolation into JSON.
START_PAYLOAD=$(timeout 5 python3 -c "
import json, sys
print(json.dumps({'requestId': sys.argv[1], 'serial': sys.argv[2]}))
" "$REQUEST_ID" "$SERIAL")

HTTP_STATUS=$(curl -s -o "$ELEVATION_RESPONSE_FILE" -w "%{http_code}" \
  -X POST "$API_ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  --max-time 15 \
  -d "$START_PAYLOAD")

if [ "$HTTP_STATUS" = "200" ]; then
  echo "elevation-start: timer confirmed by backend for request $REQUEST_ID"

  # Write elevationEnd from backend response into metadata file
  ELEVATION_END=$(timeout 5 python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    print(data.get('elevationEnd', ''))
except:
    print('')
" "$ELEVATION_RESPONSE_FILE" 2>/dev/null)

  if [ -n "$ELEVATION_END" ]; then
    update_meta 'elevationEnd' "$ELEVATION_END" 2>/dev/null
    echo "elevation-start: elevationEnd $ELEVATION_END written to metadata"
  fi

  rm -f "$ELEVATION_RESPONSE_FILE"
else
  echo "elevation-start: backend timer call returned HTTP $HTTP_STATUS" >&2
  rm -f "$ELEVATION_RESPONSE_FILE"
  exit 1
fi

# ---------------------------------------------------------------------------
# Schedule iru run at expiration time — forces immediate agent processing
# when the log collection tag is assigned at T+30 min
# ---------------------------------------------------------------------------
if [ -n "$ELEVATION_END" ]; then
  EXPIRATION_RUNNER_PLIST="/Library/LaunchDaemons/com.kitchman.admin-expiration-runner.plist"
  EXPIRATION_RUNNER_SCRIPT="/usr/local/bin/iru-expiration-runner.sh"

  # N8-18: convert elevationEnd (UTC) to the device's LOCAL time before embedding in
  # StartCalendarInterval — launchd fires at local wall-clock time, not UTC.
  EXPIRE_LOCAL=$(timeout 5 python3 -c "
from datetime import datetime
import sys
try:
    dt = datetime.fromisoformat(sys.argv[1].replace('Z', '+00:00'))
    local_dt = dt.astimezone()
    print(local_dt.strftime('%H %M'))
except:
    sys.exit(1)
" "$ELEVATION_END" 2>/dev/null)
  EXPIRE_HOUR=$(echo "$EXPIRE_LOCAL" | awk '{print $1}')
  EXPIRE_MINUTE=$(echo "$EXPIRE_LOCAL" | awk '{print $2}')

  # N5-02/N6-11: validate numeric and within valid calendar range before embedding in plist
  if ! echo "$EXPIRE_HOUR" | grep -qE '^[0-9]+$' || ! echo "$EXPIRE_MINUTE" | grep -qE '^[0-9]+$' \
     || [ "$EXPIRE_HOUR" -gt 23 ] || [ "$EXPIRE_MINUTE" -gt 59 ]; then
    echo "elevation-start: EXPIRE_HOUR/EXPIRE_MINUTE failed validation: hour=$EXPIRE_HOUR minute=$EXPIRE_MINUTE — skipping expiration plist" >&2
  else

  # Write a dedicated expiration runner script so the iru run lock can be respected.
  # The inline plist command approach cannot wait on the lock.
  cat > "$EXPIRATION_RUNNER_SCRIPT" << EXPRUNNER_EOF
#!/bin/bash
PLIST="/Library/LaunchDaemons/com.kitchman.admin-expiration-runner.plist"
SCRIPT="/usr/local/bin/iru-expiration-runner.sh"
IRU_RUN_LOCK="/var/run/iru-run.lock"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

acquire_iru_run_lock() {
  local waited=0
  while ! (set -C; echo \$\$ > "\$IRU_RUN_LOCK") 2>/dev/null; do
    if [ \$waited -ge 120 ]; then
      echo "\$(ts) expiration-runner: iru run lock timed out after \${waited}s — proceeding"
      break
    fi
    local lock_pid
    lock_pid=\$(cat "\$IRU_RUN_LOCK" 2>/dev/null)
    if [ -n "\$lock_pid" ] && ! kill -0 "\$lock_pid" 2>/dev/null; then
      echo "\$(ts) expiration-runner: stale lock (PID \$lock_pid is dead) — removing"
      rm -f "\$IRU_RUN_LOCK"
      continue
    fi
    echo "\$(ts) expiration-runner: iru run in progress (locked by PID \$lock_pid) — waiting..."
    sleep 1
    waited=\$((waited + 1))
  done
}

release_iru_run_lock() {
  rm -f "\$IRU_RUN_LOCK"
}

echo "\$(ts) expiration-runner: waiting 5s for log-collection tag propagation..."
sleep 1
acquire_iru_run_lock
trap '' TERM
echo "\$(ts) expiration-runner: running iru run..."
/usr/local/bin/kandji run --reset-daily >> /var/log/iru-elevation.log 2>&1
echo "\$(ts) expiration-runner: iru run exited with code \$?"
release_iru_run_lock
launchctl unload "\$PLIST" 2>/dev/null
rm -f "\$PLIST" "\$SCRIPT"
EXPRUNNER_EOF

  chmod 700 "$EXPIRATION_RUNNER_SCRIPT"

  cat > "$EXPIRATION_RUNNER_PLIST" << RUNNER_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.kitchman.admin-expiration-runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$EXPIRATION_RUNNER_SCRIPT</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$EXPIRE_HOUR</integer>
    <key>Minute</key>
    <integer>$EXPIRE_MINUTE</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/var/log/iru-elevation.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/iru-elevation.log</string>
</dict>
</plist>
RUNNER_EOF

  chmod 644 "$EXPIRATION_RUNNER_PLIST"
  launchctl load "$EXPIRATION_RUNNER_PLIST"
  echo "elevation-start: expiration runner scheduled for ${EXPIRE_HOUR}:${EXPIRE_MINUTE} UTC"

  fi  # end N5-02 numeric validation guard
fi

# ---------------------------------------------------------------------------
# Install network monitor LaunchDaemon — revokes access if network drops
# or if IT has revoked access early via the backend
# ---------------------------------------------------------------------------
MONITOR_SCRIPT="/usr/local/bin/iru-admin-network-monitor.sh"
PLIST_PATH="/Library/LaunchDaemons/com.kitchman.admin-network-monitor.plist"
API_STATUS_ENDPOINT="https://1mng27frfb.execute-api.us-east-1.amazonaws.com/Prod/status"

# Write the monitor script — interpolate requestId at install time; API key read from keychain at runtime
cat > "$MONITOR_SCRIPT" << MONITOR_EOF
#!/bin/bash
PRIVILEGES_CLI="/Applications/Privileges.app/Contents/MacOS/PrivilegesCLI"
PLIST_PATH="/Library/LaunchDaemons/com.kitchman.admin-network-monitor.plist"
REVOKE_PENDING_FLAG="/var/tmp/iru-revoke-network-pending"
LOG_TAG="admin-network-monitor"
REQUEST_ID="$REQUEST_ID"
SERIAL="$SERIAL"
STATUS_ENDPOINT="$API_STATUS_ENDPOINT"
REVOKE_ENDPOINT="https://1mng27frfb.execute-api.us-east-1.amazonaws.com/Prod/revoke-network-loss"
# N6-09: fetch API key on each run rather than at daemon startup so key rotation takes effect
# without restarting the daemon on every device
API_KEY=\$(security find-generic-password -a "iru-temp-admin" -s "iru-temp-admin-api" -w /Library/Keychains/System.keychain 2>/dev/null)
if [ -z "\$API_KEY" ]; then
  echo "\$(ts) \$LOG_TAG: API key not found in keychain — skipping this cycle"
  exit 0
fi

ts() { date '+%Y-%m-%d %H:%M:%S'; }

check_network() {
  local status
  status=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" https://captive.apple.com 2>/dev/null)
  [ "$status" = "200" ]
}

revoke_admin() {
  local reason="\$1"
  CURRENT_USER=\$(stat -f "%Su" /dev/console)
  if [ -n "\$CURRENT_USER" ] && [ "\$CURRENT_USER" != "root" ]; then
    if [ -f "\$PRIVILEGES_CLI" ]; then
      CURRENT_USER_UID=\$(id -u "\$CURRENT_USER")
      launchctl asuser "\$CURRENT_USER_UID" sudo -u "\$CURRENT_USER" "\$PRIVILEGES_CLI" --remove 2>/dev/null \
        && echo "\$(ts) \$LOG_TAG: admin revoked via PrivilegesCLI (\$reason)" \
        || echo "\$(ts) \$LOG_TAG: PrivilegesCLI --remove returned non-zero"
    fi
    /usr/local/bin/kandji display-alert \
      --title "Admin Access Revoked" \
      --message "\$reason" \
      --no-wait
  fi
}

cleanup_daemon() {
  launchctl unload "\$PLIST_PATH" 2>/dev/null
  rm -f "\$PLIST_PATH" "\$REVOKE_PENDING_FLAG"
}

# Enforcement loop — called immediately when network loss is first detected, and
# on subsequent daemon invocations while the flag is still set. Polls admin group
# every 1s, checks network every 60s until backend is notified or 2h TTL expires.
run_offline_enforcement_loop() {
  local CREATED
  CREATED=\$(cat "\$REVOKE_PENDING_FLAG" 2>/dev/null || echo 0)
  local LAST_NETWORK_CHECK=0

  while true; do
    local NOW
    NOW=\$(date +%s)

    # Enforce standard user on every iteration
    IS_ADMIN=\$(dseditgroup -o checkmember -m "\$CURRENT_USER" admin 2>/dev/null | grep -c "yes" || true)
    if [ "\$IS_ADMIN" -gt 0 ]; then
      echo "\$(ts) \$LOG_TAG: user re-granted admin while offline — re-revoking"
      if [ -f "\$PRIVILEGES_CLI" ]; then
        CURRENT_USER_UID=\$(id -u "\$CURRENT_USER")
        launchctl asuser "\$CURRENT_USER_UID" sudo -u "\$CURRENT_USER" "\$PRIVILEGES_CLI" --remove 2>/dev/null || true
      fi
      dscl . -delete /Groups/admin GroupMembership "\$CURRENT_USER" 2>/dev/null || true
      echo "\$(ts) \$LOG_TAG: admin re-revoked for \$CURRENT_USER"
    fi

    # Abandon after 2 hours
    if [ \$((NOW - CREATED)) -gt 7200 ]; then
      echo "\$(ts) \$LOG_TAG: revoke-pending TTL exceeded (2h) — cleaning up"
      cleanup_daemon
      exit 0
    fi

    # Check network every 60s
    if [ \$((NOW - LAST_NETWORK_CHECK)) -ge 60 ]; then
      LAST_NETWORK_CHECK=\$NOW
      if check_network; then
        echo "\$(ts) \$LOG_TAG: network restored — notifying backend of network-loss revocation"
        REVOKE_PAYLOAD=\$(python3 -c "
import json, sys
print(json.dumps({'requestId': sys.argv[1], 'serial': sys.argv[2]}))
" "\$REQUEST_ID" "\$SERIAL")
        HTTP_STATUS=\$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
          -X POST "\$REVOKE_ENDPOINT" \
          -H "Content-Type: application/json" \
          -H "x-api-key: \$API_KEY" \
          -d "\$REVOKE_PAYLOAD" 2>/dev/null)
        echo "\$(ts) \$LOG_TAG: revoke-network-loss response HTTP \$HTTP_STATUS"
        if [ "\$HTTP_STATUS" = "200" ]; then
          echo "\$(ts) \$LOG_TAG: backend notified, cleaning up"
          cleanup_daemon
          exit 0
        else
          echo "\$(ts) \$LOG_TAG: backend notification failed (HTTP \$HTTP_STATUS), will retry in 60s"
        fi
      else
        echo "\$(ts) \$LOG_TAG: still offline — continuing enforcement loop"
      fi
    fi

    sleep 1
  done
}

IRU_RUN_LOCK="/var/run/iru-run.lock"

# Acquire the iru run lock — waits up to 120s if another iru run is in progress.
# N8-08: PID written to lock file; dead-holder detected immediately without waiting 120s.
# Uses /var/run/ so stale locks are cleared automatically on reboot.
acquire_iru_run_lock() {
  local waited=0
  while ! (set -C; echo \$\$ > "\$IRU_RUN_LOCK") 2>/dev/null; do
    if [ \$waited -ge 120 ]; then
      echo "\$(ts) \$LOG_TAG: iru run lock timed out after \${waited}s — proceeding"
      break
    fi
    local lock_pid
    lock_pid=\$(cat "\$IRU_RUN_LOCK" 2>/dev/null)
    if [ -n "\$lock_pid" ] && ! kill -0 "\$lock_pid" 2>/dev/null; then
      echo "\$(ts) \$LOG_TAG: stale lock (PID \$lock_pid is dead) — removing"
      rm -f "\$IRU_RUN_LOCK"
      continue
    fi
    echo "\$(ts) \$LOG_TAG: iru run in progress (locked by PID \$lock_pid) — waiting..."
    sleep 1
    waited=\$((waited + 1))
  done
}

release_iru_run_lock() {
  rm -f "\$IRU_RUN_LOCK"
}

CURRENT_USER=\$(stat -f "%Su" /dev/console)
if [ -z "\$CURRENT_USER" ] || [ "\$CURRENT_USER" = "root" ]; then
  exit 0
fi

# If a stale revoke-pending flag exists from a previous daemon instance, enter
# the offline enforcement loop immediately before doing anything else.
if [ -f "\$REVOKE_PENDING_FLAG" ]; then
  run_offline_enforcement_loop
fi

IS_ADMIN=\$(dseditgroup -o checkmember -m "\$CURRENT_USER" admin 2>/dev/null | grep -c "yes")
if [ "\$IS_ADMIN" -eq 0 ]; then
  echo "\$(ts) \$LOG_TAG: \$CURRENT_USER is no longer admin, cleaning up"
  cleanup_daemon
  exit 0
fi

echo "\$(ts) \$LOG_TAG: starting persistent monitor loop for \$CURRENT_USER"

# Persistent main loop — runs for the lifetime of the elevation session.
# Admin check:   every 1s  (catches immediate re-elevation via Privileges app)
# Network check: every 5s  (detects network loss within 5 seconds)
# Status check:  every 60s (detects IT revocation / expiration from backend)
LAST_NETWORK_CHECK=0
LAST_STATUS_CHECK=0

while true; do
  NOW=\$(date +%s)

  # Re-read current user each cycle in case of console user change
  CURRENT_USER=\$(stat -f "%Su" /dev/console)
  if [ -z "\$CURRENT_USER" ] || [ "\$CURRENT_USER" = "root" ]; then
    echo "\$(ts) \$LOG_TAG: no console user — cleaning up"
    cleanup_daemon
    exit 0
  fi

  # Re-read API key each cycle so key rotation takes effect without restart
  API_KEY=\$(security find-generic-password -a "iru-temp-admin" -s "iru-temp-admin-api" -w /Library/Keychains/System.keychain 2>/dev/null)

  # Admin group check — every cycle (1s)
  IS_ADMIN=\$(dseditgroup -o checkmember -m "\$CURRENT_USER" admin 2>/dev/null | grep -c "yes")
  if [ "\$IS_ADMIN" -eq 0 ]; then
    echo "\$(ts) \$LOG_TAG: \$CURRENT_USER is no longer admin — cleaning up"
    cleanup_daemon
    exit 0
  fi

  # Network check — every 5s
  if [ \$((NOW - LAST_NETWORK_CHECK)) -ge 5 ]; then
    LAST_NETWORK_CHECK=\$NOW
    if ! check_network; then
      echo "\$(ts) \$LOG_TAG: network lost — revoking admin for \$CURRENT_USER"
      revoke_admin "Your temporary admin access was revoked because network connectivity was lost."
      date +%s > "\$REVOKE_PENDING_FLAG"
      echo "\$(ts) \$LOG_TAG: pending flag set — entering 1s enforcement loop"
      run_offline_enforcement_loop
    fi
  fi

  # Backend status check — every 60s
  if [ \$((NOW - LAST_STATUS_CHECK)) -ge 60 ] && [ -n "\$REQUEST_ID" ] && [ -n "\$STATUS_ENDPOINT" ]; then
    LAST_STATUS_CHECK=\$NOW
    STATUS_TMPFILE=\$(mktemp /tmp/iru-status-XXXXXX)
    chmod 600 "\$STATUS_TMPFILE"
    STATUS_HTTP=\$(curl -s -o "\$STATUS_TMPFILE" -w "%{http_code}" --max-time 10 \
      -H "x-api-key: \$API_KEY" \
      "\${STATUS_ENDPOINT}?requestId=\${REQUEST_ID}&serial=\${SERIAL}" 2>/dev/null)
    case "\$STATUS_HTTP" in
      200)
        BACKEND_STATUS=\$(python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" < "\$STATUS_TMPFILE" 2>/dev/null)
        echo "\$(ts) \$LOG_TAG: backend status=\$BACKEND_STATUS"
        if [ "\$BACKEND_STATUS" = "expired" ] || [ "\$BACKEND_STATUS" = "denied" ]; then
          echo "\$(ts) \$LOG_TAG: backend reports revoked — revoking admin immediately"
          revoke_admin "Your temporary admin access was revoked by IT."
          rm -f "\$STATUS_TMPFILE"
          trap '' TERM
          sleep 1
          acquire_iru_run_lock
          echo "\$(ts) \$LOG_TAG: running iru run to pick up log-collection tag..."
          /usr/local/bin/kandji run --reset-daily >> /var/log/iru-elevation.log 2>&1
          echo "\$(ts) \$LOG_TAG: iru run exited with code \$?"
          release_iru_run_lock
          IS_ADMIN=\$(dseditgroup -o checkmember -m "\$CURRENT_USER" admin 2>/dev/null | grep -c "yes")
          if [ "\$IS_ADMIN" -gt 0 ]; then
            echo "\$(ts) \$LOG_TAG: admin not yet removed after first iru run — waiting 10s before retry..."
            sleep 10
            acquire_iru_run_lock
            echo "\$(ts) \$LOG_TAG: retry iru run (revocation not yet confirmed)..."
            /usr/local/bin/kandji run --reset-daily >> /var/log/iru-elevation.log 2>&1
            echo "\$(ts) \$LOG_TAG: retry iru run exited with code \$?"
            release_iru_run_lock
            IS_ADMIN=\$(dseditgroup -o checkmember -m "\$CURRENT_USER" admin 2>/dev/null | grep -c "yes")
            if [ "\$IS_ADMIN" -gt 0 ]; then
              echo "\$(ts) \$LOG_TAG: WARNING — user still admin after retry"
            else
              echo "\$(ts) \$LOG_TAG: revocation confirmed after retry"
            fi
          else
            echo "\$(ts) \$LOG_TAG: revocation confirmed"
          fi
          cleanup_daemon
          exit 0
        fi
        ;;
      401|403)
        echo "\$(ts) \$LOG_TAG: auth error \$STATUS_HTTP from backend — revoking access (fail-secure)"
        revoke_admin "Your temporary admin access was revoked due to an authorization error."
        rm -f "\$STATUS_TMPFILE"
        cleanup_daemon
        exit 0
        ;;
      000)
        echo "\$(ts) \$LOG_TAG: status check returned HTTP 000 — treating as network loss"
        revoke_admin "Your temporary admin access was revoked because network connectivity was lost."
        date +%s > "\$REVOKE_PENDING_FLAG"
        echo "\$(ts) \$LOG_TAG: pending flag set — entering 1s enforcement loop"
        rm -f "\$STATUS_TMPFILE"
        run_offline_enforcement_loop
        ;;
      *)
        echo "\$(ts) \$LOG_TAG: status check returned HTTP \$STATUS_HTTP — transient error, will retry in 60s"
        ;;
    esac
    rm -f "\$STATUS_TMPFILE"
  fi

  sleep 1
done
MONITOR_EOF

chmod 700 "$MONITOR_SCRIPT"

# Write the LaunchDaemon plist — runs every 60 seconds
cat > "$PLIST_PATH" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.kitchman.admin-network-monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$MONITOR_SCRIPT</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/iru-elevation.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/iru-elevation.log</string>
</dict>
</plist>
PLIST_EOF

chmod 644 "$PLIST_PATH"
# Load the LaunchDaemon
launchctl load "$PLIST_PATH"
echo "elevation-start: network monitor LaunchDaemon installed and loaded"

echo "elevation-start: setup complete — expiration runner and network monitor are active"
