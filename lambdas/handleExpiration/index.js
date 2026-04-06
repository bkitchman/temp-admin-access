const iru = require('../shared/iru');
const slack = require('../shared/slack');
const dynamo = require('../shared/dynamo');
const { isValidUUID } = require('../shared/validate');

exports.handler = async (event) => {
  const { requestId } = event;

  if (!requestId || !isValidUUID(requestId)) {
    console.error('handleExpiration: missing or invalid requestId in event payload:', requestId);
    return;
  }

  const request = await dynamo.getRequest(requestId);
  if (!request) {
    console.error('handleExpiration: request not found:', requestId);
    return;
  }

  if (request.status === 'expired') {
    console.warn(`handleExpiration: request ${requestId} already expired, skipping`);
    return;
  }

  // 1. Remove the elevation tag — critical path.
  //    If this fails, throw so EventBridge retries the whole expiration.
  await iru.removeElevationTag(request.iruDeviceId);
  console.log(`handleExpiration: removed elevation tag from device ${request.iruDeviceId}`);

  // 2. Assign log collection tag and trigger check-in.
  //    N5-03: wrap separately — if these fail, elevation is already revoked so we still
  //    mark the record expired and alert IT rather than leaving it stuck in 'approved'.
  try {
    await iru.assignLogCollectionTag(request.iruDeviceId);
    console.log(`handleExpiration: log collection tag assigned for request ${requestId}`);
  } catch (err) {
    console.error(`handleExpiration: log collection steps failed for ${requestId}:`, err.message);
    try {
      await slack.postThreadReply(
        request.slackChannelId,
        request.slackThreadTs,
        `⚠️ Access expired for *${slack.escapeSlack(request.requestingUser)}* on *${slack.escapeSlack(request.deviceHostname)}* but sudo log collection failed — manual collection may be required.`
      );
    } catch (slackErr) {
      console.error('handleExpiration: failed to post log-collection warning to Slack:', slackErr.message);
    }
    // Fall through — elevation is revoked, record must still be marked expired
  }

  // 3. Mark request as expired.
  //    N3-02: conditional write — prevents double-expiry race with a concurrent revoke.
  try {
    await dynamo.updateRequest(requestId, {
      status: 'expired',
      expiredAt: new Date().toISOString()
    }, {
      expression: '#__status <> :__expired',
      names: { '#__status': 'status' },
      values: { ':__expired': 'expired' }
    });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.warn(`handleExpiration: request ${requestId} already expired (race condition), skipping`);
      return;
    }
    throw err;
  }

  // 4. Post a thread reply — DM to user is sent by receiveLog once sudo logs are in hand
  //    Original message is updated by receiveLog after log collection completes.
  await slack.postThreadReply(
    request.slackChannelId,
    request.slackThreadTs,
    `🔒 *Access expired* for *${request.requestingUser}* on *${request.deviceHostname}*. Collecting sudo log…`
  );

  console.log(`handleExpiration: completed for request ${requestId}`);
};
