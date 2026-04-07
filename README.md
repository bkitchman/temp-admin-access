# temp-admin-access

A self-service, Slack-approved, time-limited local admin elevation workflow for macOS endpoints managed by Iru MDM.

Users request access through Iru Self Service, choose a duration (5, 10, 15, or 30 minutes) and a reason category, an IT admin approves or denies via Slack, the device is elevated using [SAP Privileges](https://github.com/SAP/macOS-enterprise-privileges) for exactly the approved duration, every `sudo` command is captured, and an AI-powered risk score is shown to IT in the approval message.

> Zero persistent privilege. No IT babysitting. Full audit trail.

---

## Versions

| Version | Status | Summary |
|---|---|---|
| [v1.2.0](https://github.com/bkitchman/temp-admin-access/releases/tag/v1.2.0) | **Pre-release** | AI risk dashboard, sudo log storage, security hardening |
| [v1.1.0](https://github.com/bkitchman/temp-admin-access/releases/tag/v1.1.0) | **Stable** | Network enforcement, AppKit form, duration/category selection |
| [v1.0.0](https://github.com/bkitchman/temp-admin-access/releases/tag/v1.0.0) | Legacy | Initial release |

To deploy a specific version:
```bash
git clone https://github.com/bkitchman/temp-admin-access.git
cd temp-admin-access
git checkout v1.1.0   # or v1.0.0 / v1.2.0
```

---

## How It Works

```
User (Self Service) → picks duration (5/10/15/30 min) + reason category
                    → API Gateway → Slack approval message
                                    (includes AI risk score + one-click dashboard link)
                                         ↓ IT clicks Approve
                    duration-specific Iru tag assigned → device polls /status
                                         ↓ tag detected
                              elevation-start.sh → PrivilegesCLI --add
                              backend starts N-min EventBridge timer
                                         ↓ T+(N-5)  [skipped for 5-min sessions]
                              5-minute warning DM to user
                                         ↓ T+N
                              expiration: duration tag removed, log-collection tag assigned
                              collect-sudo-log.sh → ships log to /log endpoint
                              backend stores log, re-scores user via Bedrock, uploads to Slack
```

1. **User requests access** — Self Service script shows a native AppKit window; user picks duration and reason category; device POSTs to API Gateway.
2. **IT gets an interactive Slack message** — includes user, hostname, serial, reason, AI risk score (Low/Medium/High/Critical), and a one-click dashboard link.
3. **IT clicks Approve** — duration-specific Iru tag assigned; device polls `/status` every 20s and triggers `iru run --reset-daily` on detection.
4. **Device runs `elevation-start.sh`** — grants admin via `PrivilegesCLI --add`, enables sudoers logging, notifies backend to start the timer, installs the network monitor daemon.
5. **Network monitor** — LaunchDaemon polls connectivity every 5s; revokes admin immediately if the device goes offline (preventing log evasion).
6. **EventBridge sends a 5-minute warning DM** at T+(N-5) — skipped for 5-minute sessions.
7. **On expiration** — the duration tag is removed; the log-collection tag triggers `collect-sudo-log.sh`, which ships the sudo log to the backend. The backend stores it, re-evaluates the user's AI risk score, and posts the log to the Slack thread.

---

## Architecture

Fully serverless — no always-on infrastructure.

| Component | Role |
|---|---|
| **API Gateway + Lambda** | 12 functions: request intake, Slack action handling, device confirmation, status polling, log receipt, expiration, risk scoring, dashboard API |
| **DynamoDB** | Three tables: request lifecycle, AI risk scores, dashboard session tokens |
| **EventBridge Scheduler** | One-time schedules per session for T+(N-5) warning and T+N expiration; auto-delete after firing |
| **Amazon Bedrock** | Claude Haiku evaluates actual sudo commands and assigns a risk score (Low/Medium/High/Critical) with key findings |
| **S3 + CloudFront** | Static IT admin risk dashboard — private bucket with Origin Access Control |
| **Iru MDM** | Five tags act as a signal layer — four duration-specific elevation tags, one log-collection tag |
| **SAP Privileges** | Controlled, time-limited admin elevation via Iru configuration profile |
| **System Keychain** | API key stored at device setup via `provision-api-key.sh`; retrieved at runtime, never hardcoded |

---

## Project Layout

```
lambdas/
  handleRequest/          POST /request — Self Service submission
  handleSlackAction/      POST /slack/actions — Slack signature verification (async hand-off)
  processSlackAction/     Async: approve/deny/revoke, Iru tags, EventBridge
  handleElevationStart/   POST /start — device confirms elevation, starts timer
  sendWarning/            EventBridge T+(N-5) — 5-min warning DM
  handleExpiration/       EventBridge T+N — tag removal, log collection trigger
  revokeNetworkLoss/      POST /revoke-network-loss
  getStatus/              GET /status — device polls for approval/revocation
  handleSlashCommand/     POST /slack/slash — /admin-status slash command
  receiveLog/             POST /log — stores sudo log, triggers risk re-score
  computeRiskScore/       Async — calls Bedrock to evaluate user's command history
  getRiskDashboard/       GET /dashboard — returns request history + risk scores
  shared/
    dynamo.js             DynamoDB helpers
    slack.js              Slack API helpers
    iru.js                Iru API helpers
    scheduler.js          EventBridge Scheduler helpers (target ARN whitelist)
    validate.js           Input validation
    bedrock.js            Amazon Bedrock (Claude) helpers

infrastructure/
  template.yaml           AWS SAM template — Lambdas, API GW, DynamoDB, S3, CloudFront, IAM
  deploy.sh               Build + deploy + dashboard upload helper
  sync-scripts.sh         Push device scripts to Iru via API
  privileges-config.mobileconfig  SAP Privileges MDM profile template

scripts/
  provision-api-key.sh    Run once per device — stores API key in system keychain
  self-service-request.sh Iru Self Service script (user-facing)
  elevation-start.sh      Runs on device when elevation tag is assigned
  collect-sudo-log.sh     Runs on device when log-collection tag is assigned

dashboard/
  index.html              IT admin risk dashboard (hosted on S3/CloudFront)

docs/
  aws-setup.md            AWS SAM deployment guide
  gcp-setup.md            GCP Cloud Functions adaptation guide
  azure-setup.md          Azure Functions adaptation guide
  iru-setup.md            Iru Library Items, tags, and MDM profile setup
  slack-app-setup.md      Slack app creation and configuration
```

---

## Prerequisites

- AWS account with SAM CLI installed (`brew install aws-sam-cli`)
- Iru MDM tenant with API access
- Slack workspace with permission to create a Slack app
- macOS endpoints managed by Iru
- Amazon Bedrock access enabled in your AWS account (for AI risk scoring — v1.2.0+)

---

## Setup

Follow these steps in order — each has dependencies on the previous.

**1. Install Lambda dependencies**
```bash
cd lambdas && npm install
```

**2. Create the Slack app**
See [`docs/slack-app-setup.md`](docs/slack-app-setup.md). You need the bot token and signing secret before deploying. Interactivity and Slash Command URLs are filled in after deploy.

**3. Get an Iru API token**
See [`docs/iru-setup.md`](docs/iru-setup.md) steps 5–6.

**4. Set required environment variables**
```bash
export IRU_API_TOKEN="..."
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_SIGNING_SECRET="..."
export SELF_SERVICE_API_KEY="$(openssl rand -hex 32)"
export DASHBOARD_API_KEY="$(openssl rand -hex 32)"   # v1.2.0+
```

**5. Deploy to AWS**
```bash
cd infrastructure && ./deploy.sh
```
See [`docs/aws-setup.md`](docs/aws-setup.md) for full parameter reference and first-deploy instructions.

**6. Fill in Slack URLs**
Take `SlackActionsEndpoint` and `SlashCommandEndpoint` from the deploy output and paste into your Slack app's Interactivity and Slash Commands settings.

**7. Wire up the dashboard link (v1.2.0+)**
After the first deploy, add the CloudFront URL to your shell and redeploy:
```bash
export DASHBOARD_URL=https://<your-cloudfront-domain>.cloudfront.net
cd infrastructure && ./deploy.sh
```

**8. Configure Iru**
Create the five tags, upload the four duration-specific Privileges MDM profiles, and upload device scripts. See [`docs/iru-setup.md`](docs/iru-setup.md).

**9. Sync device scripts to Iru**
```bash
cd infrastructure && ./sync-scripts.sh
```

**10. Provision API key on devices**
```bash
sudo ./scripts/provision-api-key.sh
```
Run once per managed device (or deploy via Iru).

---

## Secrets

Secrets are never stored in source files. Pass them as environment variables read by `deploy.sh`.

| Secret | Where it lives |
|---|---|
| `SLACK_BOT_TOKEN` | Environment variable / `.zshrc` |
| `SLACK_SIGNING_SECRET` | Environment variable / `.zshrc` |
| `IRU_API_TOKEN` | Environment variable / `.zshrc` |
| `SELF_SERVICE_API_KEY` | Environment variable + system keychain on each device |
| `DASHBOARD_API_KEY` | Environment variable / `.zshrc` (v1.2.0+) |

`samconfig.toml` is gitignored and contains only non-sensitive defaults.

---

## Deploying Changes

**Lambda + infrastructure changes:**
```bash
cd infrastructure && ./deploy.sh
```

**Device script changes:**
```bash
cd infrastructure && ./sync-scripts.sh
```

---

## Key Design Decisions

**Timer anchored to device elevation** — The N-minute window starts when the device confirms elevation via `POST /start`, not when IT clicks Approve. Users always get the full approved duration from the moment they actually have admin.

**`iru run --reset-daily`** — All device daemons use `--reset-daily` to force re-evaluation of scoped Library Items. Plain `iru run` skips items already processed today.

**Async Lambda pattern** — Slack requires a response within 3 seconds. `handleSlackAction` verifies the signature and immediately invokes `processSlackAction` asynchronously, then returns 200.

**DynamoDB conditional writes** — All status transitions use `ConditionExpression` to enforce valid state machine transitions atomically, preventing double-processing on concurrent Slack button clicks.

**Schedule creation after DynamoDB write** — EventBridge schedules are only created after the conditional write succeeds, preventing duplicate schedules from concurrent `/start` calls.

**No `blankPush`** — `blankPush` only triggers an MDM check-in; it cannot run custom scripts. Device-side `iru run --reset-daily` is the only reliable mechanism.

---

## Cloud Alternatives

The backend is AWS-native but the logic is portable. See the docs for adaptation guides:
- [GCP Cloud Functions](docs/gcp-setup.md)
- [Azure Functions](docs/azure-setup.md)

---

## License

MIT
