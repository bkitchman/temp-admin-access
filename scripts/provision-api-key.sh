#!/bin/bash
# Iru Library Custom Script — Provision API Key
# Scope: All devices (run once at enrollment)
# Run: At install
#
# Stores the temp-admin API key in the macOS system keychain.
# Only root processes can retrieve it — standard and admin users cannot.

KEYCHAIN="/Library/Keychains/System.keychain"
SERVICE="iru-temp-admin-api"
ACCOUNT="iru-temp-admin"
API_KEY="YOUR_API_KEY_HERE"

if [ "$API_KEY" = "YOUR_API_KEY_HERE" ] || [ -z "$API_KEY" ]; then
  echo "provision-api-key: ERROR — API_KEY has not been set. Replace YOUR_API_KEY_HERE with your SelfServiceApiKey value before uploading to Iru." >&2
  exit 1
fi

# Remove any existing entry first to allow clean re-provisioning
security delete-generic-password \
  -a "$ACCOUNT" \
  -s "$SERVICE" \
  "$KEYCHAIN" 2>/dev/null

# Store the key — -T /usr/bin/security allows the security binary to retrieve it
# non-interactively (required for Iru scripts running without a GUI session).
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
