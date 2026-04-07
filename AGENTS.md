# AGENTS.md — AI Agent Guide

This file is intended for AI coding assistants (Claude Code, Cursor, GitHub Copilot, etc.) helping a user set up, configure, or modify this project. Read this before making any changes.

---

## What This Project Does

A self-service temporary local admin access system for macOS endpoints managed by Iru MDM. Users request access via a Iru Self Service script, an IT admin approves in Slack (with an AI risk score and one-click dashboard link), the device is elevated for the approved duration, and a sudo audit log is shipped back and stored on session end.

There are four distinct layers:
1. **Backend** — AWS Lambda functions + API Gateway + DynamoDB + EventBridge + Bedrock (in `lambdas/` and `infrastructure/`)
2. **Dashboard** — Static S3/CloudFront site showing per-user request history and AI risk scores (in `dashboard/`)
3. **Device scripts** — bash scripts that run on macOS endpoints via Iru Library Items (in `scripts/`)
4. **MDM configuration** — Iru tags, SAP Privileges profile, and Self Service presentation

---

## Current Version

**v1.2.0 (pre-release)** — AI risk dashboard, sudo log storage, security hardening. See [CHANGELOG](#changelog) below.

The **stable** release is **v1.1.0**.

To work on a specific version:
```bash
git checkout v1.1.0   # stable
git checkout v1.2.0   # pre-release
```

---

## Project Layout

```
lambdas/
  handleRequest/        POST /request — Self Service submission
  handleSlackAction/    POST /slack/actions — Slack signature verification
  processSlackAction/   Async: approve/deny/revoke, Iru tags, EventBridge
  handleElevationStart/ POST /start — device starts timer
  sendWarning/          EventBridge T+(N-5) — 5-min warning DM
  handleExpiration/     EventBridge T+N — tag removal, log collection trigger
  revokeNetworkLoss/    POST /revoke-network-loss
  getStatus/            GET /status — device polls for early revocation
  handleSlashCommand/   POST /slack/slash — /admin-status command
  receiveLog/           POST /log — stores sudo log, triggers risk re-score
  computeRiskScore/     Async — calls Bedrock (Claude Haiku) to score user
  getRiskDashboard/     GET /dashboard — request history + risk scores for dashboard
  shared/
    dynamo.js           DynamoDB helpers (requests, risk scores, dashboard tokens)
    slack.js            Slack API helpers (postApprovalMessage, sendDM, etc.)
    iru.js              Iru API helpers (addTag, removeTag, lockDevice, etc.)
    scheduler.js        EventBridge Scheduler helpers (target ARN whitelist)
    validate.js         Input validation utilities
    bedrock.js          Amazon Bedrock (Claude) helpers

dashboard/
  index.html            IT admin risk dashboard — hosted on S3/CloudFront

infrastructure/
  template.yaml         AWS SAM template — Lambda, API GW, DynamoDB, S3, CloudFront, IAM
  deploy.sh             Build + deploy + dashboard upload helper
  sync-scripts.sh       Push device scripts to Iru via API
  iru-library-ids.conf  Maps script filenames to Iru library item IDs
  privileges-config.mobileconfig  SAP Privileges MDM profile template

scripts/
  provision-api-key.sh    Run once per device: stores API key in system keychain
  self-service-request.sh Iru Self Service script (user-facing)
  elevation-start.sh      Runs on device when elevation tag is assigned
  collect-sudo-log.sh     Runs on device when log-collection tag is assigned

docs/
  aws-setup.md            AWS SAM deployment guide
  gcp-setup.md            GCP Cloud Functions adaptation guide
  azure-setup.md          Azure Functions adaptation guide
  iru-setup.md            Iru Library Items, tags, and script upload guide
  slack-app-setup.md      Slack app creation, OAuth scopes, and interactivity setup
```

---

## Setup Order

When helping a user set up this project from scratch, follow this order exactly — steps have dependencies:

1. **Install dependencies** — `cd lambdas && npm install`
2. **Create the Slack app** — needs to exist before deploy so you have the bot token and signing secret. See `docs/slack-app-setup.md`. The Interactivity URL and Slash Command URL can only be filled in after step 4.
3. **Get an Iru API token** — `docs/iru-setup.md` steps 5–6.
4. **Set environment variables** — `IRU_API_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SELF_SERVICE_API_KEY`, `DASHBOARD_API_KEY` (v1.2.0+).
5. **Deploy to AWS** — `cd infrastructure && ./deploy.sh`. See `docs/aws-setup.md`.
6. **Fill in Slack URLs** — take `SlackActionsEndpoint` and `SlashCommandEndpoint` from deploy output, paste into the Slack app.
7. **Wire up dashboard link (v1.2.0+)** — add `export DASHBOARD_URL=https://<cloudfront-domain>` to `.zshrc`, then redeploy.
8. **Configure Iru** — create tags, upload Privileges profile, upload scripts. See `docs/iru-setup.md`.
9. **Sync device scripts** — `cd infrastructure && ./sync-scripts.sh`.
10. **Provision API key on devices** — run `provision-api-key.sh` on managed devices.

---

## Secrets and Configuration

### What never goes in source files
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `IRU_API_TOKEN`
- `SELF_SERVICE_API_KEY`
- `DASHBOARD_API_KEY`

### Where secrets live
- **Backend**: read from environment variables by `deploy.sh`, passed as SAM `--parameter-overrides`. The `samconfig.toml` file contains only non-secret values.
- **Device scripts**: the `SELF_SERVICE_API_KEY` is stored in `/Library/Keychains/System.keychain` via `provision-api-key.sh`. Scripts read it at runtime with `security find-generic-password`. Never hardcoded.

### Generating keys
```bash
openssl rand -hex 32
```
Use for both `SelfServiceApiKey` and `DashboardApiKey`.

---

## Deploying Changes

### Lambda code + infrastructure changes
```bash
cd infrastructure
./deploy.sh          # build + deploy without confirmation
./deploy.sh --confirm  # pause to review changeset
```

### Device script changes
```bash
cd infrastructure
./sync-scripts.sh              # sync all scripts
./sync-scripts.sh collect-sudo  # sync one script by name (partial match)
```

`sync-scripts.sh` requires `IRU_WRITE_API_TOKEN` to be set (separate write-access token from the read-only `IRU_API_TOKEN` used by Lambdas).

---

## Key Design Decisions (read before modifying)

### Timer anchoring
The EventBridge timer starts when **the device confirms elevation** (via `POST /start`), not when IT clicks Approve. This ensures users always get the full approved duration from the moment they actually have admin. Do not move the timer start to approval time.

### Schedule creation after conditional write
EventBridge schedules are created **after** the DynamoDB conditional write succeeds in `handleElevationStart`. This prevents duplicate schedules if two concurrent `/start` calls race past the initial check. Do not move schedule creation before the write.

### `iru run --reset-daily`
All device daemon scripts use `iru run --reset-daily`, not plain `iru run`. The plain form skips Library Items the agent has already processed today. `--reset-daily` forces re-evaluation of all scoped items and is required for tag changes to be picked up immediately.

### No `blankPush`
The codebase has no `blankPush` calls. `blankPush` only triggers an MDM check-in, not Library Item processing — it cannot run custom scripts.

### `iru run` deadlock prevention
`elevation-start.sh` runs **inside** a `iru run` triggered by the approval monitor. Never add a `iru run` call inside `elevation-start.sh` — it would deadlock waiting for the outer agent's lock.

### Mutex lock
A file-based lock at `/var/run/iru-run.lock` prevents concurrent `iru run` calls from multiple daemons. The lock file stores the holding PID. Always use `acquire_iru_run_lock` / `release_iru_run_lock` before calling `iru run --reset-daily`.

### Async Lambda pattern
`handleSlackAction` verifies the Slack signature and immediately invokes `processSlackAction` asynchronously (`InvocationType: 'Event'`), then returns 200 to Slack within milliseconds. Slack requires a response within 3 seconds. Do not make `processSlackAction` synchronous.

### DynamoDB conditional writes
All status transitions use `ConditionExpression` to enforce valid state machine transitions atomically. Never remove or weaken these conditions — they prevent double-processing on concurrent Slack button clicks.

### Dashboard token session model
Dashboard links in Slack messages contain a single-use UUID token (7-day TTL). The first request sets `firstUsedAt`; subsequent requests within 30 minutes reuse the session. After 30 minutes the token expires. Tokens are stored in `admin-access-dashboard-tokens` DynamoDB table.

### EventBridge target ARN whitelist
`scheduler.js` validates `targetLambdaArn` against an explicit allowlist (`SEND_WARNING_FUNCTION_ARN`, `HANDLE_EXPIRATION_FUNCTION_ARN`) before creating schedules. Never bypass this check.

---

## DynamoDB Tables

| Table | Key | Purpose |
|---|---|---|
| `admin-access-requests` | `requestId` (UUID) | Full request lifecycle, sudo log content, Slack thread IDs |
| `admin-access-risk-scores` | `username` | Cached AI risk scores (48-hour TTL) |
| `admin-access-dashboard-tokens` | `token` (UUID) | Single-use session tokens for dashboard Slack links (7-day TTL) |

---

## Adding a New Lambda Function

1. Create `lambdas/<functionName>/index.js` with `exports.handler = async (event) => { ... }`
2. Add a `AWS::Serverless::Function` resource to `infrastructure/template.yaml`
3. Add the API Gateway event if it needs an HTTP endpoint
4. Grant only the minimum IAM permissions needed (follow the principle of least privilege — see existing functions for patterns)
5. Use hardcoded table name strings (not `!Ref`) when referencing existing tables from new functions to avoid CloudFormation EarlyValidation hook failures

---

## Common Tasks

### "How do I add an IT admin who can use /admin-status?"
Add their Slack user ID (format: `U012ABC`) to the `SlackItAdminIds` SAM parameter (comma-separated). Redeploy.

### "How do I change the elevation duration options?"
Update the `ALLOWED_DURATIONS` array in `lambdas/handleRequest/index.js`. Add or remove the corresponding Iru elevation tag parameters in `infrastructure/template.yaml`. Update the AppKit form in `scripts/self-service-request.sh`.

### "How do I set up off-hours auto-approval?"
Set `OnCallSlackUserId` to the on-call admin's Slack user ID and configure `BusinessHoursUtcStart` / `BusinessHoursUtcEnd` as environment variables (valid values: 0–23). Redeploy.

### "How do I reset a device for testing?"
```bash
# Run as root on the device
launchctl unload /Library/LaunchDaemons/com.kitchman.admin-approval-monitor.plist 2>/dev/null
launchctl unload /Library/LaunchDaemons/com.kitchman.admin-network-monitor.plist 2>/dev/null
launchctl unload /Library/LaunchDaemons/com.kitchman.admin-expiration-runner.plist 2>/dev/null
rm -f /Library/LaunchDaemons/com.kitchman.admin-{approval-monitor,network-monitor,expiration-runner}.plist
rm -f /usr/local/bin/iru-{approval-monitor,admin-network-monitor,expiration-runner}.sh
rm -f /var/root/.iru-elevation/meta.json
rm -f /var/tmp/iru-approval-attempt /var/tmp/iru-revoke-network-pending
rm -f /var/run/iru-run.lock
rm -f /etc/sudoers.d/iru-elevation-logging
rm -f /var/log/iru-elevation.log /var/log/iru-sudo-elevation.log
```
Also remove both Iru tags from the device in the Iru console.

### "How do I wipe all usage data for testing?"
```bash
# Wipe all three DynamoDB tables
python3 << 'EOF'
import subprocess, json
tables = {
    'admin-access-requests': 'requestId',
    'admin-access-risk-scores': 'username',
    'admin-access-dashboard-tokens': 'token',
}
for table, pk in tables.items():
    result = subprocess.run(['aws', 'dynamodb', 'scan', '--table-name', table, '--output', 'json'], capture_output=True, text=True)
    items = json.loads(result.stdout).get('Items', [])
    for i in range(0, len(items), 25):
        batch = items[i:i+25]
        subprocess.run(['aws', 'dynamodb', 'batch-write-item', '--request-items', json.dumps({table: [{'DeleteRequest': {'Key': {pk: item[pk]}}} for item in batch]})], capture_output=True)
    print(f"{table}: {len(items)} items deleted")
EOF
```

---

## What NOT to Do

- **Do not hardcode secrets** in any source file, `samconfig.toml`, or Iru script.
- **Do not add `iru run` inside `elevation-start.sh`** — it causes a deadlock.
- **Do not use plain `iru run`** — always use `iru run --reset-daily`.
- **Do not remove DynamoDB `ConditionExpression` guards** — they prevent race conditions on concurrent approvals.
- **Do not move the timer start to approval time** — it must be anchored to device elevation confirmation.
- **Do not create EventBridge schedules before the DynamoDB conditional write** — duplicate schedules will fire twice.
- **Do not commit `samconfig.toml` with real values** — it is in `.gitignore`.
- **Do not commit `kst-repo/`** — it contains Iru-specific sync state.
- **Do not use `Resource: '*'` in IAM policies** — scope to specific ARNs.
- **Do not log Iru API response bodies** — they may contain device or user PII.

---

## Security Audit History

This project has undergone two full security audits. All findings are either fixed or formally accepted with documented rationale. Current state: **zero open findings**.

Before adding new features or making significant changes, review the affected code for:
- Input validation on any new API endpoint parameters
- Slack mrkdwn injection — all user-controlled strings must pass through `escapeSlack()` before embedding in Block Kit messages
- Shell variable injection in device scripts — validate and sanitize before embedding in heredocs or JSON
- IAM permissions — grant only what is needed for the specific operation
- XSS in dashboard HTML — all user-controlled fields must pass through `esc()` before `innerHTML`

---

## Changelog

### v1.2.0 (pre-release)
- AI risk dashboard on S3/CloudFront with single-use Slack session tokens
- Sudo log stored in DynamoDB; viewable in dashboard per session
- AI risk scoring uses actual sudo commands (not just counts); re-scored after each log arrives
- Security fixes: schedule creation race, Bedrock IAM scope, CORS wildcard, XSS escaping, token session window, HTTPS enforcement, EventBridge ARN whitelist, log show timeout, Bedrock timeout, business hours validation

### v1.1.0 (stable)
- Native AppKit request form replacing AppleScript dialog
- Duration selection (5/10/15/30 min) and reason categories
- Network enforcement daemon — admin revoked if device goes offline
- Off-hours auto-approval with configurable on-call Slack user
- IT device lock (MDM lock via Slack button)
- Early revocation from Slack thread

### v1.0.0
- Initial release: Slack-approval workflow, EventBridge expiration, sudo log collection, System Keychain API key storage
