const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const TABLE = process.env.DYNAMODB_TABLE_NAME;
const RISK_TABLE = process.env.RISK_SCORES_TABLE_NAME;

// Write a new request item
async function putRequest(item) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: item
  }));
}

// Fetch a request by its ID
async function getRequest(requestId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { requestId }
  }));
  return result.Item || null;
}

// Patch specific fields on a request item.
// `updates` is a plain object: { status: 'approved', elevationStartTime: '...' }
// `condition` is optional: { expression, names, values } for atomic conditional writes.
//   Condition placeholders must not clash with update placeholders.
//   Recommended convention: prefix condition placeholders with '__' (e.g. ':__pending').
async function updateRequest(requestId, updates, condition = null) {
  const expressionParts = [];
  const attributeNames = {};
  const attributeValues = {};

  for (const [key, value] of Object.entries(updates)) {
    const nameKey = `#${key}`;
    const valueKey = `:${key}`;
    expressionParts.push(`${nameKey} = ${valueKey}`);
    attributeNames[nameKey] = key;
    attributeValues[valueKey] = value;
  }

  const params = {
    TableName: TABLE,
    Key: { requestId },
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ExpressionAttributeNames: attributeNames,
    ExpressionAttributeValues: attributeValues
  };

  if (condition) {
    params.ConditionExpression = condition.expression;
    Object.assign(params.ExpressionAttributeNames, condition.names || {});
    Object.assign(params.ExpressionAttributeValues, condition.values || {});
  }

  await ddb.send(new UpdateCommand(params));
}

// Scan for all requests with status 'approved' or 'pending' — used by the slash command
async function scanActiveRequests() {
  const result = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: '#s IN (:approved, :pending)',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':approved': 'approved', ':pending': 'pending' }
  }));
  return result.Items || [];
}

// Scan all requests made by a specific user (for risk scoring)
async function scanRequestsByUser(username) {
  const result = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: '#u = :username',
    ExpressionAttributeNames: { '#u': 'requestingUser' },
    ExpressionAttributeValues: { ':username': username }
  }));
  return result.Items || [];
}

// ----- Risk scores table -----

async function putRiskScore(item) {
  await ddb.send(new PutCommand({
    TableName: RISK_TABLE,
    Item: item
  }));
}

async function getRiskScore(username) {
  const result = await ddb.send(new GetCommand({
    TableName: RISK_TABLE,
    Key: { username }
  }));
  return result.Item || null;
}

// Scan all risk scores — used by the dashboard to get the full user list
async function scanAllRiskScores() {
  const result = await ddb.send(new ScanCommand({ TableName: RISK_TABLE }));
  return result.Items || [];
}

// Scan all completed requests — used by the dashboard to build per-user history
async function scanAllRequests() {
  const result = await ddb.send(new ScanCommand({ TableName: TABLE }));
  return result.Items || [];
}

module.exports = {
  putRequest, getRequest, updateRequest, scanActiveRequests,
  scanRequestsByUser, putRiskScore, getRiskScore, scanAllRiskScores, scanAllRequests
};
