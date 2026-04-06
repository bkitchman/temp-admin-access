const slack = require('../shared/slack');
const { escapeSlack } = slack;
const dynamo = require('../shared/dynamo');
const iru = require('../shared/iru');
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return respond(400, { error: 'Invalid JSON body' });
    }

    const { requestId, serial, logContent } = body;
    if (!requestId || !serial || logContent === undefined) {
      return respond(400, { error: 'Missing required fields: requestId, serial, logContent' });
    }
    if (!isValidUUID(requestId)) {
      return respond(400, { error: 'Invalid requestId format' });
    }
    if (typeof logContent !== 'string' || logContent.length > 100_000) {
      return respond(400, { error: 'logContent exceeds maximum allowed size of 100KB' });
    }
    // N8-11: reject non-UTF-8 content — re-encode round-trip catches lone surrogates and
    // other invalid sequences that would corrupt Slack rendering downstream.
    // (The previous check was a tautological no-op.)
    if (Buffer.from(logContent, 'utf8').toString('utf8') !== logContent) {
      return respond(400, { error: 'logContent must be valid UTF-8' });
    }

    // 3. Fetch the request from DynamoDB to get the Slack thread details
    const request = await dynamo.getRequest(requestId);
    if (!request) {
      console.error('receiveLog: request not found:', requestId);
      return respond(404, { error: 'Request not found' });
    }

    // Verify the serial matches the device that made the original request
    if (request.deviceSerial !== serial) {
      console.warn(`receiveLog: serial mismatch for request ${requestId}: expected ${request.deviceSerial}, got ${serial}`);
      return respond(403, { error: 'Forbidden' });
    }

    // 4. Post log content directly as a code block in the thread.
    //    N4-02: escape user-controlled fields — logContent can contain shell redirections
    //    (<, >, &) which Slack interprets as mrkdwn link syntax.
    const isEmpty = !logContent.trim() || logContent.startsWith('No sudo commands were recorded');
    const safeUser = escapeSlack(request.requestingUser);
    const slackText = isEmpty
      ? `📋 *Sudo log for ${safeUser}:* No sudo commands were recorded during the elevation window.`
      : `📋 *Sudo log for ${safeUser}:*\n\`\`\`\n${escapeSlack(logContent)}\n\`\`\``;

    await slack.postThreadReply(
      request.slackChannelId,
      request.slackThreadTs,
      slackText
    );

    // 5. Remove the log collection tag — cleanup, prevents script re-running
    await iru.removeLogCollectionTag(request.iruDeviceId);
    console.log(`receiveLog: removed log collection tag from device ${request.iruDeviceId}`);

    // 6. Update the original approval message to its final completed state — removes all buttons
    const outcome = request.lockedByIT ? 'locked'
      : request.revokedByNetworkLoss ? 'network_loss'
      : request.revokedEarly ? 'revoked_early'
      : 'expired';
    try {
      await slack.updateApprovalMessageCompleted({
        channel: request.slackChannelId,
        ts: request.slackThreadTs,
        username: request.requestingUser,
        hostname: request.deviceHostname,
        serial: request.deviceSerial,
        reason: request.reason,
        outcome
      });
    } catch (slackErr) {
      console.error('receiveLog: failed to update original approval message:', slackErr.message);
      // Non-fatal — log is already posted to the thread
    }

    // 7. DM the user now that logs are in hand — delayed from revocation time
    //    so the user isn't notified until the audit trail is secured.
    if (request.slackUserId) {
      let dmText;
      if (request.lockedByIT) {
        dmText = `Your device *${escapeSlack(request.deviceHostname)}* has been locked by IT. Please contact IT to receive the unlock PIN.`;
      } else if (request.revokedByNetworkLoss) {
        dmText = `Your temporary admin access for *${escapeSlack(request.deviceHostname)}* was revoked because the device lost network connectivity. Your standard user permissions have been restored.`;
      } else if (request.revokedEarly) {
        dmText = `Your temporary admin access for *${escapeSlack(request.deviceHostname)}* was revoked early by IT. Your standard user permissions have been restored.`;
      } else {
        dmText = `Your temporary admin access for *${escapeSlack(request.deviceHostname)}* has expired. Your standard user permissions have been restored.`;
      }
      await slack.sendDM(request.slackUserId, dmText);
    }

    console.log(`receiveLog: log uploaded for request ${requestId}`);
    return respond(200, { message: 'Log received and uploaded' });
  } catch (err) {
    console.error('receiveLog error:', err);
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
