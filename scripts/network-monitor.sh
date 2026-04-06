#!/bin/bash
# Network connectivity monitor for temporary admin elevation
# Installed as a LaunchDaemon by elevation-start.sh
# Revokes admin privileges immediately if network connectivity is lost

PRIVILEGES_CLI="/Applications/Privileges.app/Contents/MacOS/PrivilegesCLI"
META_FILE="/var/tmp/admin-elevation-meta.json"
PLIST_PATH="/Library/LaunchDaemons/com.kitchman.admin-network-monitor.plist"
LOG_TAG="admin-network-monitor"

# Check network connectivity by pinging a reliable internal or public host
check_network() {
  # Try pinging 8.8.8.8 three times with a 2 second timeout each
  ping -c 3 -t 2 8.8.8.8 &>/dev/null
  return $?
}

# Get the currently logged-in user
CURRENT_USER=$(stat -f "%Su" /dev/console)

if [ -z "$CURRENT_USER" ] || [ "$CURRENT_USER" = "root" ]; then
  echo "$LOG_TAG: no user logged in, exiting"
  exit 0
fi

# Check if user is still an admin — if not, we can clean up
IS_ADMIN=$(dseditgroup -o checkmember -m "$CURRENT_USER" admin 2>/dev/null | grep -c "yes")
if [ "$IS_ADMIN" -eq 0 ]; then
  echo "$LOG_TAG: $CURRENT_USER is no longer an admin, removing LaunchDaemon"
  launchctl unload "$PLIST_PATH" 2>/dev/null
  rm -f "$PLIST_PATH"
  exit 0
fi

# Check network — revoke if disconnected
if ! check_network; then
  echo "$LOG_TAG: network unreachable — revoking admin privileges for $CURRENT_USER"

  CURRENT_USER_UID=$(id -u "$CURRENT_USER")

  # Revoke via PrivilegesCLI
  if [ -f "$PRIVILEGES_CLI" ]; then
    launchctl asuser "$CURRENT_USER_UID" sudo -u "$CURRENT_USER" "$PRIVILEGES_CLI" --remove
    echo "$LOG_TAG: PrivilegesCLI --remove executed"
  fi

  # Notify the user
  launchctl asuser "$CURRENT_USER_UID" sudo -u "$CURRENT_USER" osascript \
    -e 'display alert "Admin Access Revoked" message "Your temporary admin access was revoked because network connectivity was lost. Admin access requires an active network connection." as critical' 2>/dev/null

  # Remove the LaunchDaemon — access is gone, no need to keep monitoring
  launchctl unload "$PLIST_PATH" 2>/dev/null
  rm -f "$PLIST_PATH"

  echo "$LOG_TAG: LaunchDaemon removed after revocation"
else
  echo "$LOG_TAG: network OK, $CURRENT_USER remains admin"
fi
