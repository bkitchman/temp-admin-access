#!/bin/bash
# sync-scripts.sh — push local script changes to the Iru tenant
#
# Required env var:
#   IRU_WRITE_API_TOKEN  — Iru API token with write access
#
# Usage:
#   ./sync-scripts.sh                    # sync all scripts
#   ./sync-scripts.sh provision-api-key  # sync one script by name (partial match)

set -euo pipefail

cd "$(dirname "$0")"

SCRIPTS_DIR="../scripts"
IRU_BASE_URL="https://kitchman.api.kandji.io"

if [ -z "${IRU_WRITE_API_TOKEN:-}" ]; then
  echo "ERROR: IRU_WRITE_API_TOKEN is not set" >&2
  exit 1
fi

source ./iru-library-ids.conf

FILTER="${1:-}"
SUCCESS=0
FAILURE=0

for entry in "${SCRIPT_IDS[@]}"; do
  filename="${entry%%:*}"
  rest="${entry#*:}"
  library_id="${rest%%:*}"
  display_name="${rest#*:}"

  # Apply filter if provided
  if [ -n "$FILTER" ] && [[ "$filename" != *"$FILTER"* ]]; then
    continue
  fi

  script_path="$SCRIPTS_DIR/$filename"
  if [ ! -f "$script_path" ]; then
    echo "WARN: $filename not found at $script_path — skipping"
    continue
  fi

  echo -n "Pushing $display_name ($filename)... "

  RESPONSE=$(curl -s -X PATCH \
    "${IRU_BASE_URL}/api/v1/library/custom-scripts/${library_id}" \
    -H "Authorization: Bearer ${IRU_WRITE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"script\": $(python3 -c "import json,sys; print(json.dumps(open(sys.argv[1]).read()))" "$script_path")}")

  NAME=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('name',''))" 2>/dev/null)

  if [ -n "$NAME" ]; then
    echo "OK"
    SUCCESS=$((SUCCESS + 1))
  else
    echo "FAILED"
    echo "  Response: $(echo "$RESPONSE" | head -c 200)"
    FAILURE=$((FAILURE + 1))
  fi
done

echo ""
echo "Done — $SUCCESS succeeded, $FAILURE failed"
[ "$FAILURE" -eq 0 ] || exit 1
