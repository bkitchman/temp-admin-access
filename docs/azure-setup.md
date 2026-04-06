# Azure Setup Guide

This guide covers adapting the backend to run on Microsoft Azure. The Kandji scripts and Slack app configuration are **identical** to the AWS setup — only the backend infrastructure changes.

---

## Service Mapping

| AWS | Azure Equivalent |
|---|---|
| Lambda (Node.js) | Azure Functions (Node.js, Consumption plan) |
| API Gateway | API Management or Azure Functions HTTP triggers (built-in) |
| DynamoDB | Azure Cosmos DB (NoSQL API) |
| EventBridge Scheduler | Azure Logic Apps or Durable Functions with timers |
| SSM Parameter Store | Azure Key Vault |
| IAM roles per function | Managed Identities |
| CloudWatch Logs | Application Insights / Azure Monitor |

---

## Prerequisites

- Azure subscription with Owner or Contributor access
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) installed and authenticated
- [Azure Functions Core Tools](https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-local) v4
- [Node.js 20.x](https://nodejs.org/)

```bash
az login
az account set --subscription "your-subscription-id"
```

---

## 1. Create Core Resources

```bash
RESOURCE_GROUP="admin-access-rg"
LOCATION="eastus"
STORAGE_ACCOUNT="adminaccessstorage"  # must be globally unique, lowercase, no hyphens
FUNCTION_APP="admin-access-functions"  # must be globally unique
COSMOS_ACCOUNT="admin-access-cosmos"

# Resource group
az group create --name $RESOURCE_GROUP --location $LOCATION

# Storage account (required for Azure Functions)
az storage account create \
  --name $STORAGE_ACCOUNT \
  --location $LOCATION \
  --resource-group $RESOURCE_GROUP \
  --sku Standard_LRS

# Function App
az functionapp create \
  --resource-group $RESOURCE_GROUP \
  --consumption-plan-location $LOCATION \
  --runtime node \
  --runtime-version 20 \
  --functions-version 4 \
  --name $FUNCTION_APP \
  --storage-account $STORAGE_ACCOUNT
```

---

## 2. Set Up Cosmos DB

Cosmos DB in NoSQL (Core) API mode replaces DynamoDB. The document model maps directly.

```bash
# Create account
az cosmosdb create \
  --name $COSMOS_ACCOUNT \
  --resource-group $RESOURCE_GROUP \
  --default-consistency-level Session

# Create database
az cosmosdb sql database create \
  --account-name $COSMOS_ACCOUNT \
  --resource-group $RESOURCE_GROUP \
  --name admin-access

# Create container (equivalent to DynamoDB table)
az cosmosdb sql container create \
  --account-name $COSMOS_ACCOUNT \
  --resource-group $RESOURCE_GROUP \
  --database-name admin-access \
  --name requests \
  --partition-key-path /requestId \
  --default-ttl 7776000  # 90 days in seconds
```

The `--default-ttl` flag enables automatic document expiration, equivalent to DynamoDB TTL.

Get the connection string:
```bash
az cosmosdb keys list \
  --name $COSMOS_ACCOUNT \
  --resource-group $RESOURCE_GROUP \
  --type connection-strings
```

---

## 3. Store Secrets in Key Vault

```bash
KEYVAULT_NAME="admin-access-kv"

az keyvault create \
  --name $KEYVAULT_NAME \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION

az keyvault secret set --vault-name $KEYVAULT_NAME --name slack-bot-token --value "xoxb-..."
az keyvault secret set --vault-name $KEYVAULT_NAME --name slack-signing-secret --value "your-signing-secret"
az keyvault secret set --vault-name $KEYVAULT_NAME --name kandji-api-token --value "your-kandji-token"
az keyvault secret set --vault-name $KEYVAULT_NAME --name self-service-api-key --value "your-api-key"
az keyvault secret set --vault-name $KEYVAULT_NAME --name cosmos-connection-string --value "AccountEndpoint=..."
```

Enable the Function App's managed identity and grant it Key Vault access:
```bash
az functionapp identity assign \
  --name $FUNCTION_APP \
  --resource-group $RESOURCE_GROUP

PRINCIPAL_ID=$(az functionapp identity show \
  --name $FUNCTION_APP \
  --resource-group $RESOURCE_GROUP \
  --query principalId -o tsv)

az keyvault set-policy \
  --name $KEYVAULT_NAME \
  --object-id $PRINCIPAL_ID \
  --secret-permissions get list
```

Reference Key Vault secrets in Function App settings:
```bash
az functionapp config appsettings set \
  --name $FUNCTION_APP \
  --resource-group $RESOURCE_GROUP \
  --settings \
    "SLACK_BOT_TOKEN=@Microsoft.KeyVault(VaultName=$KEYVAULT_NAME;SecretName=slack-bot-token)" \
    "SLACK_SIGNING_SECRET=@Microsoft.KeyVault(VaultName=$KEYVAULT_NAME;SecretName=slack-signing-secret)" \
    "KANDJI_API_TOKEN=@Microsoft.KeyVault(VaultName=$KEYVAULT_NAME;SecretName=kandji-api-token)" \
    "SELF_SERVICE_API_KEY=@Microsoft.KeyVault(VaultName=$KEYVAULT_NAME;SecretName=self-service-api-key)" \
    "COSMOS_CONNECTION_STRING=@Microsoft.KeyVault(VaultName=$KEYVAULT_NAME;SecretName=cosmos-connection-string)" \
    "SLACK_IT_CHANNEL_ID=C012AB3CD" \
    "KANDJI_BASE_URL=https://yourorg.api.kandji.io" \
    "EMAIL_DOMAIN=company.com"
```

---

## 4. Adapt the Lambda Code

Azure Functions use a different handler pattern than Lambda:

```js
// Lambda (AWS)
exports.handler = async (event) => {
  const body = JSON.parse(event.body);
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};

// Azure Functions v4 (HTTP trigger)
const { app } = require('@azure/functions');

app.http('handleRequest', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'request',
  handler: async (request, context) => {
    const body = await request.json();
    return { status: 200, jsonBody: { ok: true } };
  }
});
```

### Shared module changes

**DynamoDB → Cosmos DB:**
```js
const { CosmosClient } = require('@azure/cosmos');
const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
const container = client.database('admin-access').container('requests');

async function getRequest(requestId) {
  const { resource } = await container.item(requestId, requestId).read();
  return resource || null;
}

async function putRequest(data) {
  await container.items.upsert({ ...data, id: data.requestId });
}

async function updateRequest(requestId, updates) {
  const { resource: existing } = await container.item(requestId, requestId).read();
  await container.item(requestId, requestId).replace({ ...existing, ...updates });
}
```

**EventBridge Scheduler → Azure Durable Functions (recommended):**

Azure Durable Functions with the `createTimer` API is the closest equivalent to EventBridge Scheduler for arbitrary future one-time execution:

```js
const df = require('durable-functions');

// Orchestrator — schedules warning at T+25 and expiration at T+30
df.app.orchestration('adminAccessTimer', function* (context) {
  const { requestId, elevationEnd } = context.df.getInput();
  const warningTime = new Date(new Date(elevationEnd).getTime() - 5 * 60 * 1000);

  // T+25: wait until warning time
  yield context.df.createTimer(warningTime);
  yield context.df.callActivity('sendWarning', { requestId });

  // T+30: wait until expiration time
  yield context.df.createTimer(new Date(elevationEnd));
  yield context.df.callActivity('handleExpiration', { requestId });
});
```

Start the orchestration from `handleElevationStart`:
```js
const client = df.getClient(context);
await client.startNew('adminAccessTimer', {
  input: { requestId, elevationEnd }
});
```

**Simple alternative — Logic Apps:**

If you prefer not to use Durable Functions, Azure Logic Apps can be configured to trigger a webhook at a future time with no code. Create a Logic App with an HTTP trigger, a Delay action (set to `elevationEnd - 30m` for the warning and `elevationEnd` for expiration), and an HTTP action to call the function URL.

---

## 5. Deploy Azure Functions

Structure your function app directory, then deploy:

```bash
cd lambdas
func azure functionapp publish $FUNCTION_APP --node
```

Each HTTP-triggered function gets a URL of the form:
```
https://<function-app>.azurewebsites.net/api/<route>
```

---

## 6. Set Up API Management (optional)

For a cleaner single base URL and to add rate limiting, create an API Management instance and import your function routes. The Basic tier is sufficient for this use case.

```bash
az apim create \
  --name admin-access-apim \
  --resource-group $RESOURCE_GROUP \
  --publisher-email admin@yourorg.com \
  --publisher-name "Your Org" \
  --sku-name Consumption
```

---

## 7. Configure Slack

After deploy, update the Slack app's **Interactivity Request URL** and **Slash Command URL** to point to your Azure Function URLs (or API Management URL). Everything else in [docs/slack-app-setup.md](slack-app-setup.md) is identical.

---

## 8. Configure Kandji Scripts

In the three device shell scripts, update the hardcoded API endpoint URLs to your Azure Function or API Management URLs. Everything else (keychain, PrivilegesCLI, log collection) is identical.

---

## Environment Variables Reference

| Variable | Source |
|---|---|
| `SLACK_BOT_TOKEN` | Key Vault reference |
| `SLACK_SIGNING_SECRET` | Key Vault reference |
| `KANDJI_API_TOKEN` | Key Vault reference |
| `SELF_SERVICE_API_KEY` | Key Vault reference |
| `COSMOS_CONNECTION_STRING` | Key Vault reference (replaces DynamoDB config) |
| `SLACK_IT_CHANNEL_ID` | App Setting |
| `KANDJI_BASE_URL` | App Setting |
| `KANDJI_ELEVATION_TAG` | App Setting |
| `KANDJI_LOG_COLLECTION_TAG` | App Setting |
| `EMAIL_DOMAIN` | App Setting |

---

## Cost Estimate

Azure Functions on the Consumption plan charges only for executions. At typical usage (a few hundred requests per month), the cost is effectively zero — well within the free tier of 1 million executions/month. Cosmos DB serverless is similarly low-cost at this request volume.
