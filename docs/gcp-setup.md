# GCP Setup Guide

This guide covers adapting the backend to run on Google Cloud Platform. The Kandji scripts and Slack app configuration are **identical** to the AWS setup — only the backend infrastructure changes.

---

## Service Mapping

| AWS | GCP Equivalent |
|---|---|
| Lambda (Node.js) | Cloud Functions (2nd gen) or Cloud Run |
| API Gateway | Cloud Endpoints or API Gateway for Cloud Functions (built-in HTTP triggers) |
| DynamoDB | Firestore (Native mode) |
| EventBridge Scheduler | Cloud Scheduler + Pub/Sub or Cloud Tasks |
| SSM Parameter Store | Secret Manager |
| IAM roles per function | Service Accounts per Cloud Function |
| CloudWatch Logs | Cloud Logging |

---

## Prerequisites

- Google Cloud project with billing enabled
- [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed and authenticated
- [Node.js 20.x](https://nodejs.org/) for local development
- APIs enabled: Cloud Functions, Cloud Scheduler, Firestore, Secret Manager, Cloud Build

```bash
gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudscheduler.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com
```

---

## 1. Set Up Firestore

Firestore in Native mode replaces DynamoDB. Create the database in your preferred region:

```bash
gcloud firestore databases create --region=us-east1
```

The equivalent of the DynamoDB `admin-access-requests` table is a Firestore **collection** named `requests`. Each document ID is the `requestId` UUID. No schema migration is needed — Firestore is schemaless.

**DynamoDB TTL equivalent:** Firestore does not have built-in TTL. Options:
- Use Cloud Scheduler to run a cleanup function daily that deletes documents older than 90 days
- Or use a background Cloud Function triggered by Pub/Sub on a schedule

---

## 2. Store Secrets in Secret Manager

```bash
gcloud secrets create slack-bot-token --replication-policy=automatic
echo -n "xoxb-..." | gcloud secrets versions add slack-bot-token --data-file=-

gcloud secrets create slack-signing-secret --replication-policy=automatic
echo -n "your-signing-secret" | gcloud secrets versions add slack-signing-secret --data-file=-

gcloud secrets create kandji-api-token --replication-policy=automatic
echo -n "your-kandji-token" | gcloud secrets versions add kandji-api-token --data-file=-

gcloud secrets create self-service-api-key --replication-policy=automatic
echo -n "your-api-key" | gcloud secrets versions add self-service-api-key --data-file=-
```

---

## 3. Adapt the Lambda Code

The Lambda handler pattern (`exports.handler = async (event) => { ... }`) maps directly to Cloud Functions:

```js
// Lambda (AWS)
exports.handler = async (event) => {
  const body = JSON.parse(event.body);
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};

// Cloud Functions (GCP) — HTTP trigger
exports.handler = async (req, res) => {
  const body = req.body;
  res.status(200).json({ ok: true });
};
```

### Shared module changes

Replace AWS SDK calls with GCP equivalents:

**DynamoDB → Firestore:**
```js
// Before (dynamo.js)
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');

// After (firestore.js)
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();

async function getRequest(requestId) {
  const doc = await db.collection('requests').doc(requestId).get();
  return doc.exists ? doc.data() : null;
}

async function putRequest(data) {
  await db.collection('requests').doc(data.requestId).set(data);
}

async function updateRequest(requestId, updates) {
  await db.collection('requests').doc(requestId).update(updates);
}
```

**EventBridge Scheduler → Cloud Scheduler:**
```js
const { CloudSchedulerClient } = require('@google-cloud/scheduler');
const scheduler = new CloudSchedulerClient();

async function createOneTimeSchedule({ name, scheduledTime, targetUrl, payload }) {
  const [job] = await scheduler.createJob({
    parent: `projects/${PROJECT}/locations/${REGION}`,
    job: {
      name: `projects/${PROJECT}/locations/${REGION}/jobs/${name}`,
      httpTarget: {
        uri: targetUrl,
        httpMethod: 'POST',
        body: Buffer.from(JSON.stringify(payload)).toString('base64'),
        headers: { 'Content-Type': 'application/json' }
      },
      scheduleTime: { seconds: Math.floor(new Date(scheduledTime).getTime() / 1000) }
    }
  });
  return job.name;
}
```

> **Note:** Cloud Scheduler jobs fire on cron schedules, not at arbitrary one-time UTC timestamps like EventBridge Scheduler. The closest equivalent is to set a one-time job by creating it at request time with a schedule that fires once near the target time, or use **Cloud Tasks** which supports arbitrary future execution times and is a better direct replacement for EventBridge Scheduler.

**Cloud Tasks (recommended for one-time delays):**
```js
const { CloudTasksClient } = require('@google-cloud/tasks');
const client = new CloudTasksClient();

async function scheduleTask({ queue, targetUrl, payload, inSeconds }) {
  const task = {
    httpRequest: {
      httpMethod: 'POST',
      url: targetUrl,
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
      headers: { 'Content-Type': 'application/json' }
    },
    scheduleTime: {
      seconds: Math.floor(Date.now() / 1000) + inSeconds
    }
  };
  await client.createTask({ parent: queue, task });
}
```

---

## 4. Deploy Cloud Functions

Deploy each function individually. Example for `handleRequest`:

```bash
gcloud functions deploy handleRequest \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-east1 \
  --source=./lambdas/handleRequest \
  --entry-point=handler \
  --trigger-http \
  --allow-unauthenticated \
  --set-secrets="SLACK_BOT_TOKEN=slack-bot-token:latest,SLACK_SIGNING_SECRET=slack-signing-secret:latest,KANDJI_API_TOKEN=kandji-api-token:latest,SELF_SERVICE_API_KEY=self-service-api-key:latest" \
  --set-env-vars="SLACK_IT_CHANNEL_ID=C012AB3CD,KANDJI_BASE_URL=https://yourorg.api.kandji.io,EMAIL_DOMAIN=company.com"
```

Each function gets its own HTTPS trigger URL. Collect them after deploy — they replace the API Gateway URLs in your Slack app configuration and Kandji scripts.

---

## 5. Set Up API Gateway (optional)

If you want a single base URL instead of per-function URLs, use **Cloud API Gateway**:

```bash
gcloud api-gateway apis create admin-access-api --project=$PROJECT
gcloud api-gateway api-configs create v1 \
  --api=admin-access-api \
  --openapi-spec=api-spec.yaml \
  --project=$PROJECT
gcloud api-gateway gateways create admin-access-gateway \
  --api=admin-access-api \
  --api-config=v1 \
  --location=us-east1
```

The OpenAPI spec maps paths (`/request`, `/slack/actions`, etc.) to the individual Cloud Function URLs.

---

## 6. Configure Slack

After deploy, update the Slack app's **Interactivity Request URL** and **Slash Command URL** to point to your Cloud Function URLs (or API Gateway URL). Everything else in [docs/slack-app-setup.md](slack-app-setup.md) is identical.

---

## 7. Configure Kandji Scripts

In the three device shell scripts, update the hardcoded API endpoint URLs to your Cloud Function or API Gateway URLs. Everything else (keychain, PrivilegesCLI, log collection) is identical.

---

## Environment Variables Reference

All Lambda environment variables have direct GCP equivalents. Set them via `--set-env-vars` (non-secret) and `--set-secrets` (secret values from Secret Manager):

| Variable | Source |
|---|---|
| `SLACK_BOT_TOKEN` | Secret Manager |
| `SLACK_SIGNING_SECRET` | Secret Manager |
| `KANDJI_API_TOKEN` | Secret Manager |
| `SELF_SERVICE_API_KEY` | Secret Manager |
| `SLACK_IT_CHANNEL_ID` | Environment variable |
| `KANDJI_BASE_URL` | Environment variable |
| `KANDJI_ELEVATION_TAG` | Environment variable |
| `KANDJI_LOG_COLLECTION_TAG` | Environment variable |
| `EMAIL_DOMAIN` | Environment variable |
| `FIRESTORE_COLLECTION` | Environment variable (replaces `DYNAMODB_TABLE_NAME`) |
