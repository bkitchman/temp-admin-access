#!/bin/bash
# Kandji Library Custom Script — Provision API Key
# Scope: All devices (run once at enrollment)
# Run: At install
#
# Stores the temp-admin API key in the macOS system keychain.
# Only root processes can retrieve it — standard and admin users cannot.

KEYCHAIN="/Library/Keychains/System.keychain"
SERVICE="kandji-temp-admin-api"
ACCOUNT="kandji-temp-admin"
API_KEY="e88870499d05c3071c13cf149eae16e0d14875d9c18d6598b65ee7a42d31ec5c"

# Remove any existing entry first to allow clean re-provisioning
security delete-generic-password \
  -a "$ACCOUNT" \
  -s "$SERVICE" \
  "$KEYCHAIN" 2>/dev/null

# Store the key — -T /usr/bin/security allows the security binary to retrieve it
# non-interactively (required for Kandji scripts running without a GUI session).
# The System keychain is root-only, so standard users still cannot access it.
security add-generic-password \
  -a "$ACCOUNT" \
  -s "$SERVICE" \
  -w "$API_KEY" \
  -T /usr/bin/security \
  "$KEYCHAIN"

if [ $? -eq 0 ]; then
  echo "provision-api-key: API key stored successfully in system keychain"
else
  echo "provision-api-key: ERROR — failed to store API key in system keychain" >&2
  exit 1
fi
