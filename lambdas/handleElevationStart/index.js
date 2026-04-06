const dynamo = require('../shared/dynamo');
const slack = require('../shared/slack');
const scheduler = require('../shared/scheduler');
const { isValidUUID } = require('../shared/validate');

exports.handler = async (event) => {
  try {
    // 1. Validate API key
    const apiKey = event.headers?.['x-api-key'] ?? event.headers?.['X-Api-Key'];
    if (!apiKey || apiKey !== process.env.SELF_SERVICE_API_KEY) {
      return respond(401, { error: 'Unauthorized' });
    }

    // 2. Parse body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch {
      return respond(400, { error: 'Invalid JSON body' });
    }
    // N5-05: reject non-object bodies (arrays, bare strings, null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return respond(400, { error: 'Invalid JSON body' });
    }

    // N5-01: require serial so only the owning device can start its own timer
    const { requestId, serial } = body;
    if (!requestId || !serial) {
      return respond(400, { error: 'Missing required fields: requestId, serial' });
    }
    if (!isValidUUID(requestId)) {
      return respond(400, { error: 'Invalid requestId format' });
    }

    // 3. Fetch request from DynamoDB
    const request = await dynamo.getRequest(requestId);
    if (!request) {
      console.error('handleElevationStart: request not found:', requestId);
      return respond(404, { error: 'Request not found' });
    }

    // N5-01: validate serial matches the device that owns this request
    if (request.deviceSerial !== serial) {
      console.warn(`handleElevationStart: serial mismatch for request ${requestId}`);
      return respond(403, { error: 'Forbidden' });
    }

    if (request.status !== 'approved') {
      console.warn(`handleElevationStart: request ${requestId} is in status ${request.status}, skipping`);
      return respond(200, { message: 'Already processed' });
    }

    // If already started (device re-ran the script), return the existing elevationEnd
    if (request.elevationStartTime) {
      console.warn(`handleElevationStart: request ${requestId} already has elevationStartTime, returning existing end time`);
      return respond(200, { message: 'Already started', elevationEnd: request.elevationEndTime });
    }

    // 4. Use now as the true elevation start time — this is when the device confirmed elevation
    const now = new Date();
    const elevationStartTime = now.toISOString();
    const warningTime = new Date(now.getTime() + 25 * 60 * 1000);
    const expirationTime = new Date(now.getTime() + 30 * 60 * 1000);
    const elevationEndTime = expirationTime.toISOString();

    // 5. Create EventBridge schedules from actual elevation start time
    const warningSchedulerArn = await scheduler.createOneTimeSchedule({
      name: `warning-${requestId}`,
      invokeAt: warningTime.toISOString(),
      targetLambdaArn: process.env.SEND_WARNING_FUNCTION_ARN,
      payload: { requestId }
    });

    const expirationSchedulerArn = await scheduler.createOneTimeSchedule({
      name: `expiration-${requestId}`,
      invokeAt: expirationTime.toISOString(),
      targetLambdaArn: process.env.HANDLE_EXPIRATION_FUNCTION_ARN,
      payload: { requestId, elevationStartTime, elevationEndTime }
    });

    // 6. Update DynamoDB with actual times and scheduler ARNs.
    //    N3-02: conditional write — attribute_not_exists guards against a race where two
    //    concurrent invocations both pass the elevationStartTime check above.
    try {
      await dynamo.updateRequest(requestId, {
        elevationStartTime,
        elevationEndTime,
        warningSchedulerArn,
        expirationSchedulerArn,
        deviceConfirmedAt: elevationStartTime
      }, {
        expression: 'attribute_not_exists(#elevationStartTime)',
        names: { '#elevationStartTime': 'elevationStartTime' },
        values: {}
      });
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        console.warn(`handleElevationStart: timer already set for ${requestId} (race condition), returning existing end time`);
        const existing = await dynamo.getRequest(requestId);
        return respond(200, { message: 'Already started', elevationEnd: existing?.elevationEndTime });
      }
      throw err;
    }

    // 7. Post accurate expiry time and Revoke button to Slack thread
    await slack.postRevokeButton({
      channel: request.slackChannelId,
      ts: request.slackThreadTs,
      requestId,
      username: request.requestingUser,
      hostname: request.deviceHostname,
      expiresAt: elevationEndTime
    });

    console.log(`handleElevationStart: timer started for request ${requestId} at ${elevationStartTime}`);
    return respond(200, { message: 'Timer started', elevationEnd: elevationEndTime });
  } catch (err) {
    console.error('handleElevationStart error:', err);
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
