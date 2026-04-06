const dynamo = require('../shared/dynamo');
const { isValidUUID } = require('../shared/validate');

exports.handler = async (event) => {
  try {
    // Validate API key
    const apiKey = event.headers?.['x-api-key'] ?? event.headers?.['X-Api-Key'];
    if (!apiKey || apiKey !== process.env.SELF_SERVICE_API_KEY) {
      return respond(401, { error: 'Unauthorized' });
    }

    const requestId = event.queryStringParameters?.requestId;
    const serial = event.queryStringParameters?.serial;
    if (!requestId || !serial) {
      return respond(400, { error: 'Missing required query parameters: requestId, serial' });
    }
    if (!isValidUUID(requestId)) {
      return respond(400, { error: 'Invalid requestId format' });
    }

    const request = await dynamo.getRequest(requestId);
    if (!request) {
      return respond(404, { error: 'Request not found' });
    }

    if (request.deviceSerial !== serial) {
      console.warn(`getStatus: serial mismatch for request ${requestId}: expected ${request.deviceSerial}, got ${serial}`);
      return respond(403, { error: 'Forbidden' });
    }

    return respond(200, { status: request.status });
  } catch (err) {
    console.error('getStatus error:', err);
    return respond(500, { error: 'Internal server error' });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
