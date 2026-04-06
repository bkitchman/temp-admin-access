# temp-admin-access

A self-service, Slack-approved, time-limited local admin elevation workflow for macOS endpoints managed by Iru MDM.

Users request access through Iru Self Service, choose a duration (5, 10, 15, or 30 minutes) and a reason category, an IT admin approves or denies via Slack with per-duration buttons, the device is elevated using [SAP Privileges](https://github.com/SAP/macOS-enterprise-privileges) for exactly the approved duration, and every `sudo` command during the session is captured and uploaded to the Slack thread on expiration.

> Zero persistent privilege. No IT babysitting. Full audit trail.

---

## How It Works

```
User (Self Service) → picks duration (5/10/15/30 min) + reason category
                    → API Gateway → Slack approval message with 4 duration buttons
                                         ↓ IT clicks Approve (any duration)
                    duration-specific Iru tag assigned → device polls /status
                                         ↓ tag detected
                              elevation-start.sh → PrivilegesCLI --add
                              backend starts N-min EventBridge timer
                                         ↓ T+(N-5)  [skipped for 5-min sessions]
                              5-minute warning DM to user
                                         ↓ T+N
                              expiration: duration tag removed, log-collection tag assigned
                              collect-sudo-log.sh → ships log to /log endpoint
                              backend uploads sudo log to Slack thread
```

1. **User requests access** — Iru Self Service script prompts for a reason, a duration (5/10/15/30 min), and a reason category; collects device identity; POSTs to API Gateway.
2. **IT gets an interactive Slack message** — includes user, hostname, serial, reason category, and four duration-labeled Approve buttons (IT can override the requested duration) plus a Deny button.
3. **IT clicks Approve** — a duration-specific Iru elevation tag is assigned; a background LaunchDaemon on the device polls `/status` every 20 seconds and triggers `iru run --reset-daily` on detection.
4. **Device runs `elevation-start.sh`** — grants admin via `PrivilegesCLI --add`, enables sudoers logging, notifies the backend to start the N-minute timer, installs the network monitor daemon.
5. **EventBridge sends a 5-minute warning DM** at T+(N-5) — skipped entirely for 5-minute sessions.
6. **On expiration** — the duration-specific tag is removed; the log-collection tag triggers `collect-sudo-log.sh`, which ships the session's `sudo` log back to the backend, which uploads it as a file attachment in the original Slack thread.

---

## Architecture

Fully serverless — no always-on infrastructure.

| Component | Role |
|---|---|
| **API Gateway + Lambda** | 9 functions: request intake, Slack action handling, device confirmation, status polling, log receipt, expiration |
| **DynamoDB** | Single-table: full request lifecycle, status, Slack thread IDs, actor identity for audit trail |
| **EventBridge Scheduler** | One-time schedules per session for T+25 warning and T+30 expiration; auto-delete after firing |
| **Iru MDM** | Five tags act as a signal layer — four duration-specific elevation tags (5/10/15/30 min) each scope their own SAP Privileges profile; log-collection tag triggers log shipping |
| **SAP Privileges** | Controlled, time-limited admin elevation via a Iru configuration profile |
| **System Keychain** | API key stored at device setup via `provision-api-key.sh`; retrieved at runtime by scripts, never hardcoded |

---

## Project Layout

```
lambdas/
  handleRequest/          POST /request — Self Service submission
  handleSlackAction/      POST /slack/actions — Slack signature verification (async hand-off)
  processSlackAction/     Async: approve/deny/revoke, Iru tags, EventBridge
  handleElevationStart/   POST /start — device confirms elevation, starts timer
  sendWarning/            EventBridge T+25 — 5-min warning DM
  handleExpiration/       EventBridge T+30 — tag removal, log collection trigger
  revokeNetworkLoss/      POST /revoke-network-loss
  getStatus/              GET /status — device polls for approval/revocation
  handleSlashCommand/     POST /slack/slash — /admin-status slash command
  receiveLog/             POST /log — receives and uploads sudo log to Slack
  shared/
    dynamo.js             DynamoDB helpers
    slack.js              Slack API helpers
    iru.js             Iru API helpers
    scheduler.js          EventBridge Scheduler helpers
    validate.js           Input validation

infrastructure/
  template.yaml           AWS SAM template — Lambdas, API GW, DynamoDB, IAM
  samconfig.toml          SAM deployment config (gitignored — contains no secrets)
  deploy.sh               Build + deploy helper
  privileges-config.mobileconfig  SAP Privileges MDM profile template

scripts/
  provision-api-key.sh    Run once per device — stores API key in system keychain
  self-service-request.sh Iru Self Service script (user-facing)
  elevation-start.sh      Runs on device when elevation tag is assigned
  collect-sudo-log.sh     Runs on device when log-collection tag is assigned

docs/
  aws-setup.md            AWS SAM deployment guide
  gcp-setup.md            GCP Cloud Functions adaptation guide
  azure-setup.md          Azure Functions adaptation guide
  iru-setup.md         Iru Library Items, tags, and MDM profile setup
  slack-app-setup.md      Slack app creation and configuration
```

---

## Prerequisites

- AWS account with SAM CLI installed (`brew install aws-sam-cli`)
- Iru MDM tenant with API access
- Slack workspace with permission to create a Slack app
- macOS endpoints managed by Iru

---

## Setup

Follow these steps in order — each has dependencies on the previous.

**1. Install Lambda dependencies**
```bash
cd lambdas && npm install
```

**2. Create the Slack app**
See [`docs/slack-app-setup.md`](docs/slack-app-setup.md). You need the bot token and signing secret before deploying. Interactivity and Slash Command URLs are filled in after deploy.

**3. Get a Iru API token**
See [`docs/iru-setup.md`](docs/iru-setup.md) steps 5–6.

**4. Deploy to AWS**
```bash
cd infrastructure
sam build
sam deploy --guided \
  --parameter-overrides \
    SlackBotToken="xoxb-..." \
    SlackSigningSecret="..." \
    IruApiToken="..." \
    SelfServiceApiKey="$(openssl rand -hex 32)"
```
See [`docs/aws-setup.md`](docs/aws-setup.md) for full parameter reference.

**5. Fill in Slack URLs**
Take `SlackActionsEndpoint` and `SlashCommandEndpoint` from SAM Outputs and paste into your Slack app's Interactivity and Slash Commands settings.

**6. Update API endpoints in device scripts**
Take `RequestEndpoint`, `StatusEndpoint`, `ElevationStartEndpoint`, and `LogEndpoint` from SAM Outputs and update the constants at the top of each script in `scripts/`.

**7. Configure Iru**
Create the five tags, upload the four duration-specific Privileges MDM profiles, and upload device scripts. See [`docs/iru-setup.md`](docs/iru-setup.md).

**8. Provision API key on devices**
```bash
sudo ./scripts/provision-api-key.sh
```
Run once per managed device (or deploy via Iru).

---

## Secrets

Secrets are never stored in source files. They are passed as SAM `--parameter-overrides` at deploy time or stored in AWS SSM Parameter Store with `SecureString` type.

| Secret | Where it lives |
|---|---|
| `SLACK_BOT_TOKEN` | SAM parameter override / SSM |
| `SLACK_SIGNING_SECRET` | SAM parameter override / SSM |
| `IRU_API_TOKEN` | SAM parameter override / SSM |
| `SELF_SERVICE_API_KEY` | SAM parameter + system keychain on each device |

`samconfig.toml` is gitignored and contains only non-sensitive defaults.

---

## Deploying Changes

**Lambda changes:**
```bash
cd infrastructure && ./deploy.sh
```

**Device script changes** (requires [kst](https://github.com/iru-inc/kst)):
```bash
cp scripts/self-service-request.sh "kst-repo/scripts/SAP_ 2-Request Admin Access/audit"
cp scripts/elevation-start.sh      "kst-repo/scripts/SAP_ 3-elevation-start/audit"
cp scripts/collect-sudo-log.sh     "kst-repo/scripts/SAP_ 4-collect-sudo-log/audit"
cd kst-repo && kst script sync
```

---

## Key Design Decisions

**Timer anchored to device elevation** — The N-minute window starts when the device confirms elevation via `POST /start`, not when IT clicks Approve. This ensures users always get the full approved duration from the moment they actually have admin.

**`iru run --reset-daily`** — All device daemons use `--reset-daily` to force re-evaluation of scoped Library Items. Plain `iru run` skips items already processed today and won't pick up tag changes.

**Async Lambda pattern** — Slack requires a response within 3 seconds. `handleSlackAction` verifies the signature and immediately invokes `processSlackAction` asynchronously, then returns 200. All heavy work happens in `processSlackAction`.

**DynamoDB conditional writes** — All status transitions use `ConditionExpression` to enforce valid state machine transitions atomically. This prevents double-processing on concurrent Slack button clicks.

**No `blankPush`** — `blankPush` only triggers an MDM check-in; it cannot run custom scripts. Device-side `iru run --reset-daily` is the only reliable mechanism for picking up tag changes immediately.

---

## Cloud Alternatives

The backend is AWS-native but the logic is portable. See the docs for adaptation guides:
- [GCP Cloud Functions](docs/gcp-setup.md)
- [Azure Functions](docs/azure-setup.md)

---

## License

MIT
