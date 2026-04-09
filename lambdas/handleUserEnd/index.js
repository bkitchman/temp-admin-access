// handleUserEnd — POST /end
// Called by the "End Admin Access" Self Service script when a user chooses
// to voluntarily finish their session before the timer expires.
// Uses the same SELF_SERVICE_API_KEY as /request and /log, with serial
// verification so a device can only end its own session.
const iru = require('../shared/iru');
const slack = require('../shared/slack');
const dynamo = require('../shared/dynamo');
const scheduler = require('../shared/scheduler');
const { isValidUUID } = require('../shared/validate');

exports.handler = async (event) => {
  // 1. Validate API key
  const apiKey = event.headers?.['x-api-key'] ?? event.headers?.['X-Api-Key'];
  if (!apiKey || apiKey !== process.env.SELF_SERVICE_API_KEY) {
    return respond(401, { error: 'Unauthorized' });
  }

  // 2. Parse and validate body
  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  const { requestId, serial } = body || {};
  if (!requestId || !serial) {
    return respond(400, { error: 'Missing required fields: requestId, serial' });
  }

  if (!isValidUUID(requestId)) return respond(400, { error: 'Invalid requestId format' });

  if (!/^[A-Z0-9]{8,14}$/.test(serial)) {
    return respond(400, { error: 'Invalid serial format' });
  }

  try {
    const request = await dynamo.getRequest(requestId);
    if (!request) {
      return respond(404, { error: 'Request not found' });
    }

    // Verify the requesting device owns this session — prevents cross-device abuse
    if (request.deviceSerial !== serial) {
      console.warn(`handleUserEnd: serial mismatch for request ${requestId} — expected ${request.deviceSerial}, got ${serial}`);
      return respond(403, { error: 'Forbidden' });
    }

    // Conditional write — only succeed if request is currently approved
    try {
      await dynamo.updateRequest(requestId, {
        status: 'completed_by_user',
        completedEarlyAt: new Date().toISOString(),
        completedEarlyByUser: true
      }, {
        expression: '#__status = :__approved',
        names: { '#__status': 'status' },
        values: { ':__approved': 'approved' }
      });
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        // Session already expired, denied, or ended — not an error from the user's perspective
        return respond(409, { error: `Session is not active (status: ${request.status})` });
      }
      throw err;
    }

    // Cancel EventBridge warning and expiration schedules — no longer needed
    for (const [label, key] of [['warning', request.warningSchedulerArn], ['expiration', request.expirationSchedulerArn]]) {
      if (key) {
        try { await scheduler.deleteSchedule(`${label}-${requestId}`); } catch (e) {
          console.warn(`handleUserEnd: could not delete ${label} schedule:`, e.message);
        }
      }
    }

    // Remove the elevation tag from Iru
    const tagToRemove = request.assignedElevationTag || process.env.IRU_ELEVATION_TAG_30MIN;
    await iru.removeTagByName(request.iruDeviceId, tagToRemove);

    // Assign log collection tag — collect the sudo log for the partial session
    await iru.assignLogCollectionTag(request.iruDeviceId);

    // Build a human-readable duration note if we know when elevation started
    let durationNote = '';
    if (request.elevationStartTime) {
      const elapsedMin = Math.round((Date.now() - new Date(request.elevationStartTime).getTime()) / 60000);
      durationNote = ` after ${elapsedMin} minute${elapsedMin !== 1 ? 's' : ''}`;
    }

    await slack.postThreadReply(
      request.slackChannelId,
      request.slackThreadTs,
      `✅ *Session ended by user* — *${request.requestingUser}* finished their session on *${request.deviceHostname}*${durationNote}. Collecting sudo log…`
    );

    console.log(`handleUserEnd: session completed early by user for request ${requestId}`);
    return respond(200, { message: 'Session ended successfully' });
  } catch (err) {
    console.error('handleUserEnd error:', err);
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
