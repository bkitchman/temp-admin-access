# AGENTS.md — AI Agent Guide

This file is intended for AI coding assistants (Claude Code, Cursor, GitHub Copilot, etc.) helping a user set up, configure, or modify this project. Read this before making any changes.

---

## What This Project Does

A self-service temporary local admin access system for macOS endpoints managed by Kandji MDM. Users request access via a Kandji Self Service script, an IT admin approves in Slack, the device is elevated for 30 minutes, and a sudo audit log is shipped back to Slack on expiration.

There are three distinct layers:
1. **Backend** — AWS Lambda functions + API Gateway + DynamoDB + EventBridge (in `lambdas/` and `infrastructure/`)
2. **Device scripts** — bash scripts that run on macOS endpoints via Kandji Library Items (in `scripts/`)
3. **MDM configuration** — Kandji tags, SAP Privileges profile, and Self Service presentation

---

## Project Layout

```
lambdas/
  handleRequest/        POST /request — Self Service submission
  handleSlackAction/    POST /slack/actions — Slack signature verification
  processSlackAction/   Async: approve/deny/revoke, Kandji tags, EventBridge
  handleElevationStart/ POST /start — device starts 30-min timer
  sendWarning/          EventBridge T+25 — 5-min warning DM
  handleExpiration/     EventBridge T+30 — tag removal, log collection trigger
  revokeNetworkLoss/    POST /revoke-network-loss
  getStatus/            GET /status — device polls for early revocation
  handleSlashCommand/   POST /slack/slash — /admin-status command
  receiveLog/           POST /log — receives and uploads sudo log to Slack
  shared/
    dynamo.js           DynamoDB helpers (getRequest, putRequest, updateRequest)
    slack.js            Slack API helpers (postApprovalMessage, sendDM, uploadLogToThread, etc.)
    kandji.js           Kandji API helpers (addTag, removeTag, lockDevice, etc.)
    scheduler.js        EventBridge Scheduler helpers
    validate.js         Input validation utilities

infrastructure/
  template.yaml         AWS SAM template — defines all Lambda functions, API GW, DynamoDB, IAM
  samconfig.toml        SAM deployment config — NO real secrets, placeholders only
  deploy.sh             Build + deploy helper (handles .aws-sam cache clearing)
  privileges-config.mobileconfig  SAP Privileges MDM profile template

scripts/
  provision-api-key.sh    Run once per device: stores API key in system keychain
  self-service-request.sh Kandji Self Service script (user-facing)
  elevation-start.sh      Runs on device when elevation tag is assigned
  collect-sudo-log.sh     Runs on device when log-collection tag is assigned

docs/
  aws-setup.md            AWS SAM deployment guide
  gcp-setup.md            GCP Cloud Functions adaptation guide
  azure-setup.md          Azure Functions adaptation guide
  kandji-setup.md         Kandji Library Items, tags, and script upload guide
  slack-app-setup.md      Slack app creation, OAuth scopes, and interactivity setup
```

---

## Setup Order

When helping a user set up this project from scratch, follow this order exactly — steps have dependencies:

1. **Install dependencies** — `cd lambdas && npm install`
2. **Create the Slack app** — needs to exist before deploy so you have the bot token and signing secret. See `docs/slack-app-setup.md`. The Interactivity URL and Slash Command URL can only be filled in after step 4.
3. **Get a Kandji API token** — `docs/kandji-setup.md` step 5-6.
4. **Deploy to AWS** — `cd infrastructure && sam build && sam deploy --guided`. See `docs/aws-setup.md`.
5. **Fill in Slack URLs** — take the `SlackActionsEndpoint` and `SlashCommandEndpoint` from SAM Outputs and paste into the Slack app.
6. **Update API endpoints in scripts** — take `RequestEndpoint`, `StatusEndpoint`, `ElevationStartEndpoint`, `LogEndpoint` from SAM Outputs and update the hardcoded URLs at the top of the three scripts.
7. **Configure Kandji** — create tags, upload Privileges profile, upload scripts. See `docs/kandji-setup.md`.
8. **Provision API key on devices** — run `provision-api-key.sh` on managed devices.

---

## Secrets and Configuration

### What never goes in source files
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `KANDJI_API_TOKEN`
- `SELF_SERVICE_API_KEY`

### Where secrets live
- **Backend**: passed as SAM `--parameter-overrides` or stored in AWS SSM Parameter Store with `SecureString` type. The `samconfig.toml` file contains only non-secret values.
- **Device scripts**: the `SELF_SERVICE_API_KEY` is stored in `/Library/Keychains/System.keychain` via `provision-api-key.sh`. Scripts read it at runtime with `security find-generic-password`. Never hardcoded.

### Generating a self-service API key
```bash
openssl rand -hex 32
```
Use this as the `SelfServiceApiKey` SAM parameter. Store it in the keychain on devices via `provision-api-key.sh`.

---

## Deploying Changes

### Lambda code changes
```bash
cd infrastructure
./deploy.sh          # build + deploy without confirmation
./deploy.sh --confirm  # pause to review changeset
```

### Kandji script changes
Scripts are managed with [kst](https://github.com/kandji-inc/kst). After editing files in `scripts/`:

```bash
# Copy updated scripts into the kst repo
cp scripts/self-service-request.sh "kst-repo/scripts/SAP_ 2-Request Admin Access/audit"
cp scripts/elevation-start.sh      "kst-repo/scripts/SAP_ 3-elevation-start/audit"
cp scripts/collect-sudo-log.sh     "kst-repo/scripts/SAP_ 4-collect-sudo-log/audit"

# Push to Kandji
cd kst-repo && kst script sync
```

kst requires `KST_TENANT` and `KST_TOKEN` environment variables.

---

## Key Design Decisions (read before modifying)

### Timer anchoring
The 30-minute EventBridge timer starts when **the device confirms elevation** (via `POST /start`), not when IT clicks Approve. This is intentional — it ensures users always get a full 30 minutes from the moment they actually have admin. Do not move the timer start to approval time.

### `kandji run --reset-daily`
All device daemon scripts use `kandji run --reset-daily`, not plain `kandji run`. The plain form skips Library Items the agent has already processed today. `--reset-daily` forces re-evaluation of all scoped items and is required for tag changes to be picked up immediately.

### No `blankPush`
The codebase has no `blankPush` calls. `blankPush` only triggers an MDM check-in, not Library Item processing — it cannot run custom scripts. Device-side `kandji run --reset-daily` is the only mechanism for picking up tag changes.

### `kandji run` deadlock prevention
`elevation-start.sh` runs **inside** a `kandji run` triggered by the approval monitor. Never add a `kandji run` call inside `elevation-start.sh` — it would deadlock waiting for the outer agent's lock.

### Mutex lock
A file-based lock at `/var/run/kandji-run.lock` prevents concurrent `kandji run` calls from the approval monitor, network monitor, and expiration runner daemons. The lock file stores the holding PID. Always use `acquire_kandji_run_lock` / `release_kandji_run_lock` before calling `kandji run --reset-daily`.

### Post-run verification with retry
After `kandji run --reset-daily`, daemons verify the expected state change occurred (user is admin, or user is no longer admin) via `dseditgroup`. If not confirmed, one retry fires after 120 seconds. This accommodates Kandji backend tag propagation latency (typically 30–120s).

### Async Lambda pattern
`handleSlackAction` verifies the Slack signature and immediately invokes `processSlackAction` asynchronously (`InvocationType: 'Event'`), then returns 200 to Slack within milliseconds. This is required because Slack requires a response within 3 seconds. Do not make `processSlackAction` synchronous.

### DynamoDB conditional writes
All status transitions use `ConditionExpression` to enforce valid state machine transitions atomically. Never remove or weaken these conditions — they prevent double-processing on concurrent Slack button clicks.

---

## Adding a New Lambda Function

1. Create `lambdas/<functionName>/index.js` with `exports.handler = async (event) => { ... }`
2. Add a `AWS::Serverless::Function` resource to `infrastructure/template.yaml`
3. Add the API Gateway event if it needs an HTTP endpoint
4. Grant only the minimum IAM permissions needed (follow the principle of least privilege — see existing functions for patterns)
5. Add the function name to the `deploy.sh` or SAM globals as needed

---

## Common Tasks

### "How do I add an IT admin who can use /admin-status?"
Add their Slack user ID (format: `U012ABC`) to the `SlackItAdminIds` SAM parameter (comma-separated). Redeploy.

### "How do I change the elevation duration from 30 to 60 minutes?"
Update the `elevationDurationMinutes` constant in `lambdas/handleElevationStart/index.js`. Also update the `DockToggleTimeout` in `infrastructure/privileges-config.mobileconfig` to match. Also update the `ExpirationInterval` in the Privileges MDM profile in Kandji.

### "How do I set up off-hours auto-approval?"
Set `OnCallSlackUserId` to the on-call admin's Slack user ID and configure `BusinessHoursUtcStart` / `BusinessHoursUtcEnd` as SAM parameters. Redeploy.

### "How do I reset a device for testing?"
```bash
# Run as root on the device
launchctl unload /Library/LaunchDaemons/com.kitchman.admin-approval-monitor.plist 2>/dev/null
launchctl unload /Library/LaunchDaemons/com.kitchman.admin-network-monitor.plist 2>/dev/null
launchctl unload /Library/LaunchDaemons/com.kitchman.admin-expiration-runner.plist 2>/dev/null
rm -f /Library/LaunchDaemons/com.kitchman.admin-{approval-monitor,network-monitor,expiration-runner}.plist
rm -f /usr/local/bin/kandji-{approval-monitor,admin-network-monitor,expiration-runner}.sh
rm -f /var/root/.kandji-elevation/meta.json
rm -f /var/tmp/kandji-approval-attempt /var/tmp/kandji-revoke-network-pending
rm -f /var/run/kandji-run.lock
rm -f /etc/sudoers.d/kandji-elevation-logging
rm -f /var/log/kandji-elevation.log /var/log/kandji-sudo-elevation.log
```
Also remove both Kandji tags from the device in the Kandji console.

---

## What NOT to Do

- **Do not hardcode secrets** in any source file, `samconfig.toml`, or Kandji script.
- **Do not add `kandji run` inside `elevation-start.sh`** — it causes a deadlock (the script runs inside a kandji run).
- **Do not use plain `kandji run`** — always use `kandji run --reset-daily`.
- **Do not remove DynamoDB `ConditionExpression` guards** — they prevent race conditions on concurrent approvals.
- **Do not move the timer start to approval time** — it must be anchored to device elevation confirmation.
- **Do not commit `samconfig.toml` with real values** — it is in `.gitignore` for this reason.
- **Do not commit `kst-repo/`** — it contains Kandji-specific sync state and is in `.gitignore`.

---

## Security Audit History

This project has undergone 10 iterative security audits. See `security-audit-report.html` for the full history. All findings are either fixed or formally accepted with documented rationale. Current state: **zero open findings**.

Before adding new features or making significant changes, run a security review of the affected code. Key areas to check:
- Input validation on any new API endpoint parameters
- Slack mrkdwn injection — all user-controlled strings must pass through `escapeSlack()` before embedding in Block Kit messages
- Shell variable injection in device scripts — validate and sanitize before embedding in heredocs or JSON
- IAM permissions — grant only what is needed for the specific operation
