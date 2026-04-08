#!/bin/bash
# Iru Library Custom Script — Provision API Key
# Scope: All devices (run once at enrollment)
# Run: At install
#
# Stores the temp-admin API key in the macOS system keychain.
# Only root processes can retrieve it — standard and admin users cannot.
#
# SETUP: In the Iru Library Item editor, add a Script Variable named API_KEY
# and paste your SelfServiceApiKey value there. The key is never stored in
# this script file or in git.

KEYCHAIN="/Library/Keychains/System.keychain"
SERVICE="iru-temp-admin-api"
ACCOUNT="iru-temp-admin"

# API_KEY is injected by Iru at runtime via the Library Item script variable.
# If not set, fail loudly so the issue is visible in Iru run logs.
if [ -z "${API_KEY:-}" ]; then
  echo "provision-api-key: ERROR — API_KEY script variable is not set in the Iru Library Item." >&2
  echo "provision-api-key: Go to the Library Item → Script → Variables and add API_KEY = <SelfServiceApiKey value>." >&2
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
