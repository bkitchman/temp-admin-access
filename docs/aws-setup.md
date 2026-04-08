# AWS Setup Guide

> **Version note:** This guide covers the current codebase. For version-specific setup:
> - **v1.1.0 (stable):** Steps 1–7 below; skip the dashboard steps (8–9).
> - **v1.2.0 (pre-release):** All steps including dashboard setup.
>
> To deploy a specific version: `git checkout v1.1.0` before running any commands.

---

## Prerequisites

- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) configured with credentials
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) (`brew install aws-sam-cli`)
- Node.js 20.x
- Amazon Bedrock enabled in your AWS account with access to `us.anthropic.claude-sonnet-4-20250514-v1:0` *(v1.2.0+ only)*

---

## 1. Install Lambda Dependencies

All Lambda functions share a single `node_modules` directory at `lambdas/`:

```bash
cd lambdas
npm install
cd ..
```

---

## 2. Set Environment Variables

`deploy.sh` reads secrets from environment variables — never stored in files.

```bash
# Required
export IRU_API_TOKEN="..."
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_SIGNING_SECRET="..."
export SELF_SERVICE_API_KEY="$(openssl rand -hex 32)"
export DASHBOARD_API_KEY="$(openssl rand -hex 32)"   # v1.2.0+ only

# Optional (defaults shown)
export IRU_BASE_URL="https://your-tenant.api.kandji.io"
export SLACK_IT_CHANNEL_ID="C0XXXXXXXXX"
export EMAIL_DOMAIN="company.com"
export ON_CALL_SLACK_USER_ID=""   # enables off-hours auto-approval
```

Add these to your `.zshrc` / `.bashrc` so they persist across sessions.

---

## 3. First Deploy

```bash
cd infrastructure
./deploy.sh
```

`deploy.sh` runs `sam build`, `sam deploy`, and (v1.2.0+) uploads the dashboard to S3.

For v1.1.0 and earlier, use `sam deploy --guided` for the first run to generate `samconfig.toml`:

```bash
cd infrastructure
sam build
sam deploy --guided \
  --parameter-overrides \
    SlackBotToken="$SLACK_BOT_TOKEN" \
    SlackSigningSecret="$SLACK_SIGNING_SECRET" \
    IruApiToken="$IRU_API_TOKEN" \
    SelfServiceApiKey="$SELF_SERVICE_API_KEY" \
    SlackItChannelId="$SLACK_IT_CHANNEL_ID" \
    EmailDomain="$EMAIL_DOMAIN"
```

---

## 4. SAM Parameters Reference

| Parameter | Required | Default | Description |
|---|---|---|---|
| `IruApiToken` | ✓ | — | Iru API token (Settings → Access → API Token) |
| `IruBaseUrl` | ✓ | — | Iru tenant API base URL |
| `SlackBotToken` | ✓ | — | Slack bot OAuth token (`xoxb-...`) |
| `SlackSigningSecret` | ✓ | — | Slack app signing secret |
| `SlackItChannelId` | ✓ | — | Slack channel ID for IT approval messages |
| `SelfServiceApiKey` | ✓ | — | Shared key stored in device System Keychain |
| `DashboardApiKey` | ✓ (v1.2.0+) | — | API key for direct admin access to the dashboard |
| `EmailDomain` | ✓ | — | Company email domain for Slack user lookup |
| `IruElevationTag5Min` | ✓ | `temp-admin-elevation-5min` | Iru tag for 5-min sessions |
| `IruElevationTag10Min` | ✓ | `temp-admin-elevation-10min` | Iru tag for 10-min sessions |
| `IruElevationTag15Min` | ✓ | `temp-admin-elevation-15min` | Iru tag for 15-min sessions |
| `IruElevationTag30Min` | ✓ | `temp-admin-elevation-30min` | Iru tag for 30-min sessions |
| `IruLogCollectionTag` | ✓ | `temp-admin-log-collection` | Iru tag that triggers sudo log collection |
| `OnCallSlackUserId` | — | — | Slack user ID for off-hours auto-approval |
| `BusinessHoursUtcStart` | — | `13` | Business hours start in UTC (0–23) |
| `BusinessHoursUtcEnd` | — | `23` | Business hours end in UTC (0–23) |
| `DashboardUrl` | — (v1.2.0+) | — | CloudFront URL — set after first deploy |
| `BedrockModelId` | — (v1.2.0+) | `us.anthropic.claude-sonnet-4-20250514-v1:0` | Bedrock cross-region inference profile for risk scoring |

---

## 5. Post-Deploy: Collect API URLs

After the first deploy, SAM prints the API Gateway URLs in the Outputs section:

| Output key | Use |
|---|---|
| `RequestEndpoint` | Paste into `scripts/self-service-request.sh` as `API_ENDPOINT` |
| `SlackActionsEndpoint` | Paste into Slack App → Interactivity → Request URL |
| `SlashCommandEndpoint` | Paste into Slack App → Slash Commands → Request URL |
| `ElevationStartEndpoint` | Paste into `scripts/elevation-start.sh` as `API_ENDPOINT` |
| `StatusEndpoint` | Paste into `scripts/self-service-request.sh` as `STATUS_ENDPOINT` |
| `LogEndpoint` | Paste into `scripts/collect-sudo-log.sh` as `API_ENDPOINT` |
| `DashboardUrl` | CloudFront URL for the IT admin dashboard *(v1.2.0+)* |
| `DashboardEndpoint` | Dashboard API endpoint *(v1.2.0+)* |

Retrieve at any time:
```bash
aws cloudformation describe-stacks \
  --stack-name temp-admin-access \
  --query 'Stacks[0].Outputs'
```

---

## 6. Wire Up Dashboard Link (v1.2.0+ only)

After the first deploy, add the CloudFront URL to your environment and redeploy so the Slack approval messages include the dashboard link:

```bash
export DASHBOARD_URL=https://<your-cloudfront-domain>.cloudfront.net
cd infrastructure && ./deploy.sh
```

Add `export DASHBOARD_URL=...` to your `.zshrc` so it persists.

---

## 7. Subsequent Deploys

```bash
cd infrastructure
./deploy.sh            # build + deploy (no confirmation prompt)
./deploy.sh --confirm  # build + deploy (pause to review changeset)
```

---

## 8. Resources Created

The SAM template creates:

| Resource | Type | Purpose |
|---|---|---|
| `admin-access-requests` | DynamoDB Table | Request state, sudo log content, 90-day TTL, KMS encryption |
| `admin-access-risk-scores` | DynamoDB Table | Cached AI risk scores, 48-hour TTL *(v1.2.0+)* |
| `admin-access-dashboard-tokens` | DynamoDB Table | Single-use dashboard session tokens, 7-day TTL *(v1.2.0+)* |
| `admin-access-dashboard-<accountId>` | S3 Bucket | Dashboard static files (private) *(v1.2.0+)* |
| `DashboardOAC` | CloudFront OAC | Origin Access Control for S3 *(v1.2.0+)* |
| `DashboardDistribution` | CloudFront Distribution | HTTPS dashboard CDN *(v1.2.0+)* |
| `admin-access-eventbridge-scheduler-role` | IAM Role | Allows EventBridge Scheduler to invoke `sendWarning` and `handleExpiration` |
| `admin-access-handleRequest` | Lambda | Receives Self Service POST, generates dashboard token, posts Slack approval |
| `admin-access-handleSlackAction` | Lambda | Verifies Slack signature, async-invokes processSlackAction |
| `admin-access-processSlackAction` | Lambda | Approve/deny/revoke logic, Iru tags, EventBridge schedules |
| `admin-access-handleElevationStart` | Lambda | Starts timer when device confirms elevation |
| `admin-access-sendWarning` | Lambda | Sends 5-minute warning DM |
| `admin-access-handleExpiration` | Lambda | Removes duration tag, assigns log-collection tag |
| `admin-access-revokeNetworkLoss` | Lambda | Records network-loss revocation |
| `admin-access-getStatus` | Lambda | Returns request status for device polling |
| `admin-access-handleSlashCommand` | Lambda | Handles `/admin-status` slash command |
| `admin-access-receiveLog` | Lambda | Stores sudo log, triggers risk re-score |
| `admin-access-computeRiskScore` | Lambda | Calls Bedrock to evaluate user risk *(v1.2.0+)* |
| `admin-access-getRiskDashboard` | Lambda | Dashboard API endpoint *(v1.2.0+)* |

---

## 9. Monitoring

All Lambdas log to CloudWatch Logs at `/aws/lambda/admin-access-<functionName>`.

```bash
# Tail a specific function
aws logs tail /aws/lambda/admin-access-handleRequest --follow

# Check recent errors
aws logs tail /aws/lambda/admin-access-receiveLog --since 1h
```

---

## 10. Tear Down

```bash
# Empty the dashboard S3 bucket first (v1.2.0+ only)
aws s3 rm s3://admin-access-dashboard-$(aws sts get-caller-identity --query Account --output text) --recursive

cd infrastructure
sam delete --stack-name temp-admin-access
```

This removes all Lambda functions, API Gateway, DynamoDB tables, S3 bucket, CloudFront distribution, and IAM roles. EventBridge schedules with `ActionAfterCompletion: DELETE` clean themselves up automatically after firing.
