# AWS Setup Guide

## Prerequisites

- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) configured with credentials
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- Node.js 20.x

---

## 1. Install Lambda Dependencies

All Lambda functions share a single `node_modules` directory at `lambdas/`:

```bash
cd lambdas
npm install
cd ..
```

---

## 2. Build

```bash
cd infrastructure
sam build
```

SAM packages the `lambdas/` directory (set as `CodeUri` in `template.yaml`) for all functions.

---

## 3. First Deploy (guided)

```bash
sam deploy --guided
```

This prompts for all parameter values and saves them to `samconfig.toml`. At minimum you need:

| Parameter | Where to get it |
|---|---|
| `SlackBotToken` | Slack app OAuth & Permissions → Bot Token |
| `SlackSigningSecret` | Slack app Basic Information → App Credentials |
| `SlackItChannelId` | Right-click channel in Slack → View channel details |
| `KandjiApiToken` | Kandji Settings → Access → API Token |
| `KandjiBaseUrl` | Kandji Settings → Access → API URL |
| `SelfServiceApiKey` | Generate a random string: `openssl rand -hex 32` |
| `EmailDomain` | Your company's email domain, e.g. `company.com` |

### Recommended: use SSM Parameter Store for secrets

Store sensitive values in SSM so they are never in `samconfig.toml` or source control:

```bash
aws ssm put-parameter --name /admin-access/slack-bot-token \
  --value "xoxb-..." --type SecureString

aws ssm put-parameter --name /admin-access/slack-signing-secret \
  --value "your-signing-secret" --type SecureString

aws ssm put-parameter --name /admin-access/kandji-api-token \
  --value "your-kandji-token" --type SecureString

aws ssm put-parameter --name /admin-access/self-service-api-key \
  --value "$(openssl rand -hex 32)" --type SecureString
```

Then pass them at deploy time:
```bash
sam deploy --parameter-overrides \
  "SlackBotToken=$(aws ssm get-parameter --name /admin-access/slack-bot-token --with-decryption --query Parameter.Value --output text)" \
  "SlackSigningSecret=$(aws ssm get-parameter --name /admin-access/slack-signing-secret --with-decryption --query Parameter.Value --output text)" \
  ...
```

---

## 4. Subsequent Deploys

```bash
cd infrastructure
./deploy.sh          # build + deploy (no confirmation prompt)
./deploy.sh --confirm  # build + deploy (pause to review changeset)
```

Or manually:
```bash
sam build && sam deploy
```

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

You can retrieve them at any time:
```bash
aws cloudformation describe-stacks \
  --stack-name temp-admin-access \
  --query 'Stacks[0].Outputs'
```

---

## 6. Resources Created

The SAM template creates:

| Resource | Type | Purpose |
|---|---|---|
| `admin-access-requests` | DynamoDB Table | Request state store with TTL (90 days) and KMS encryption |
| `admin-access-eventbridge-scheduler-role` | IAM Role | Allows EventBridge Scheduler to invoke `sendWarning` and `handleExpiration` |
| `admin-access-handleRequest` | Lambda | Receives Self Service POST, posts Slack approval |
| `admin-access-handleSlackAction` | Lambda | Verifies Slack signature, async-invokes processSlackAction |
| `admin-access-processSlackAction` | Lambda | Approve/deny/revoke logic, Kandji tags, EventBridge schedules |
| `admin-access-handleElevationStart` | Lambda | Starts 30-min timer when device confirms elevation |
| `admin-access-sendWarning` | Lambda | Sends 5-minute warning DM (EventBridge T+25) |
| `admin-access-handleExpiration` | Lambda | Removes tag, assigns log-collection tag (EventBridge T+30) |
| `admin-access-revokeNetworkLoss` | Lambda | Records network-loss revocation |
| `admin-access-getStatus` | Lambda | Returns request status for device polling |
| `admin-access-handleSlashCommand` | Lambda | Handles `/admin-status` slash command |
| `admin-access-receiveLog` | Lambda | Receives sudo log, uploads to Slack thread |

---

## 7. Monitoring

All Lambdas log to CloudWatch Logs at `/aws/lambda/admin-access-<functionName>`.

```bash
# Tail a specific function
aws logs tail /aws/lambda/admin-access-handleSlackAction --follow

# Tail all functions (requires log group prefix)
aws logs tail /aws/lambda/admin-access-receiveLog --follow
```

---

## 8. Tear Down

```bash
cd infrastructure
sam delete --stack-name temp-admin-access
```

This removes all Lambda functions, API Gateway, DynamoDB table, and IAM roles. EventBridge schedules with `ActionAfterCompletion: DELETE` clean themselves up automatically after firing.
