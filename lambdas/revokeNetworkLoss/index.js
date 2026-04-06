const iru = require('../shared/iru');
const slack = require('../shared/slack');
const dynamo = require('../shared/dynamo');
const { isValidUUID } = require('../shared/validate');

exports.handler = async (event) => {
  try {
    const apiKey = event.headers?.['x-api-key'] ?? event.headers?.['X-Api-Key'];
    if (!apiKey || apiKey !== process.env.SELF_SERVICE_API_KEY) {
      return respond(401, { error: 'Unauthorized' });
    }

    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch {
      return respond(400, { error: 'Invalid JSON body' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return respond(400, { error: 'Invalid JSON body' });
    }

    // N4-01: require serial so each device can only revoke its own session
    const { requestId, serial } = body;
    if (!requestId || !serial) {
      return respond(400, { error: 'Missing required fields: requestId, serial' });
    }
    if (!isValidUUID(requestId)) {
      return respond(400, { error: 'Invalid requestId format' });
    }

    const request = await dynamo.getRequest(requestId);
    if (!request) {
      return respond(404, { error: 'Request not found' });
    }

    // N4-01: validate serial matches the device that owns this request
    if (request.deviceSerial !== serial) {
      console.warn(`revokeNetworkLoss: serial mismatch for request ${requestId}`);
      return respond(403, { error: 'Forbidden' });
    }

    if (request.status !== 'approved') {
      console.warn(`revokeNetworkLoss: request ${requestId} already in status ${request.status}, skipping`);
      return respond(200, { message: 'Already handled' });
    }

    // Remove elevation tag and assign log collection tag.
    // The network monitor on the device calls `iru run` to pick up the tag immediately.
    await iru.removeElevationTag(request.iruDeviceId);
    await iru.assignLogCollectionTag(request.iruDeviceId);

    // N4-05: conditional write — only expire if still approved (prevents double-revoke race)
    try {
      await dynamo.updateRequest(requestId, {
        status: 'expired',
        expiredAt: new Date().toISOString(),
        revokedEarly: true,
        revokedByNetworkLoss: true
      }, {
        expression: '#__status = :__approved',
        names: { '#__status': 'status' },
        values: { ':__approved': 'approved' }
      });
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        console.warn(`revokeNetworkLoss: request ${requestId} already processed (race condition), skipping`);
        return respond(200, { message: 'Already handled' });
      }
      throw err;
    }

    // N4-09: escape user-controlled fields before embedding in Slack messages
    const safeUser = slack.escapeSlack(request.requestingUser);
    const safeHostname = slack.escapeSlack(request.deviceHostname);

    // DM to user is sent by receiveLog once sudo logs are in hand
    await slack.postThreadReply(
      request.slackChannelId,
      request.slackThreadTs,
      `⚠️ *Access revoked* for *${safeUser}* on *${safeHostname}* due to network connectivity loss. Collecting sudo log…`
    );

    console.log(`revokeNetworkLoss: handled for request ${requestId}`);
    return respond(200, { message: 'Revocation recorded' });
  } catch (err) {
    console.error('revokeNetworkLoss error:', err);
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
