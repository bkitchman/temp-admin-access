const iru = require('../shared/iru');
const slack = require('../shared/slack');
const dynamo = require('../shared/dynamo');
const scheduler = require('../shared/scheduler');

exports.handler = async (event) => {
  // N3-01: extract actor identity forwarded by handleSlackAction for audit logging
  const { actionId, requestId, actorSlackUserId, actorSlackUsername, approvedDuration } = event;

  if (!requestId || !actionId) {
    console.error('processSlackAction: missing actionId or requestId', event);
    return;
  }

  const actor = { actorSlackUserId: actorSlackUserId ?? null, actorSlackUsername: actorSlackUsername ?? null };

  try {
    const request = await dynamo.getRequest(requestId);
    if (!request) {
      console.error('processSlackAction: request not found:', requestId);
      return;
    }

    if (actionId === 'lock_device') {
      // Lock can be used on an active OR already-revoked session (independent emergency action)
      if (!['approved', 'expired'].includes(request.status)) {
        console.warn(`processSlackAction: lock_device requested but status is ${request.status}, skipping`);
        return;
      }
      await handleLockDevice(request, requestId, actor);
      return;
    }

    if (actionId === 'revoke_request') {
      if (request.status !== 'approved') {
        console.warn(`processSlackAction: revoke requested but status is ${request.status}, skipping`);
        return;
      }
      await handleRevoke(request, requestId, actor);
      return;
    }

    if (request.status !== 'pending') {
      console.warn(`processSlackAction: request ${requestId} already in status: ${request.status}, skipping`);
      return;
    }

    if (actionId === 'deny_request') {
      await handleDeny(request, requestId, actor);
    } else {
      const approveMatch = actionId.match(/^approve_(\d+)$/);
      if (approveMatch) {
        const resolvedDuration = approvedDuration ?? parseInt(approveMatch[1], 10);
        if (![5, 10, 15, 30].includes(resolvedDuration)) {
          console.error(`processSlackAction: invalid duration in actionId: ${actionId}`);
          return;
        }
        await handleApprove(request, requestId, actor, resolvedDuration);
      }
    }
  } catch (err) {
    console.error('processSlackAction error:', err);
  }
};

async function handleDeny(request, requestId, actor) {
  // N3-02: conditional write — only deny if still pending (prevents race with approve)
  try {
    await dynamo.updateRequest(requestId, {
      status: 'denied',
      deniedAt: new Date().toISOString(),
      ...actor
    }, {
      expression: '#__status = :__pending',
      names: { '#__status': 'status' },
      values: { ':__pending': 'pending' }
    });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.warn(`handleDeny: request ${requestId} already processed (race condition), skipping`);
      return;
    }
    throw err;
  }

  const deniedDmNote = request.slackUserId
    ? `DM sent to <@${request.slackUserId}>.`
    : `No Slack user found for *${request.requestingUser}*${request.requestingUserEmail ? ` (${request.requestingUserEmail})` : ''} — DM not sent.`;

  await slack.postThreadReply(
    request.slackChannelId,
    request.slackThreadTs,
    `❌ *Denied* — access request from *${request.requestingUser}* on *${request.deviceHostname}* was rejected. ${deniedDmNote}`
  );

  if (request.slackUserId) {
    await slack.sendDM(
      request.slackUserId,
      `Your temporary admin access request for *${request.deviceHostname}* was denied by IT. If you have questions, please reach out to the IT team.`
    );
  }
}

async function handleRevoke(request, requestId, actor) {
  // N3-02: conditional write — only revoke if still approved (prevents double-revoke race)
  try {
    await dynamo.updateRequest(requestId, {
      status: 'expired',
      expiredAt: new Date().toISOString(),
      revokedEarly: true,
      ...actor
    }, {
      expression: '#__status = :__approved',
      names: { '#__status': 'status' },
      values: { ':__approved': 'approved' }
    });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.warn(`handleRevoke: request ${requestId} already processed (race condition), skipping`);
      return;
    }
    throw err;
  }

  // Cancel the existing EventBridge schedules so they don't double-fire
  if (request.warningSchedulerArn) {
    try { await scheduler.deleteSchedule(`warning-${requestId}`); } catch (e) {
      console.warn('handleRevoke: could not delete warning schedule:', e.message);
    }
  }
  if (request.expirationSchedulerArn) {
    try { await scheduler.deleteSchedule(`expiration-${requestId}`); } catch (e) {
      console.warn('handleRevoke: could not delete expiration schedule:', e.message);
    }
  }

  // Remove elevation tag immediately (use stored tag name; fall back to 30-min tag for older requests)
  const tagToRemoveRevoke = request.assignedElevationTag || process.env.IRU_ELEVATION_TAG_30MIN;
  await iru.removeTagByName(request.iruDeviceId, tagToRemoveRevoke);

  // Assign log collection tag — the network monitor on the device detects the
  // revocation via /status polling and calls `iru run` to pick it up immediately.
  await iru.assignLogCollectionTag(request.iruDeviceId);

  // Update Slack thread — DM to user is sent by receiveLog once sudo logs are in hand
  await slack.postThreadReply(
    request.slackChannelId,
    request.slackThreadTs,
    `⛔ *Access revoked early* for *${request.requestingUser}* on *${request.deviceHostname}* by IT admin. Collecting sudo log…`
  );

  console.log(`handleRevoke: access revoked for request ${requestId}`);
}

async function handleLockDevice(request, requestId, actor) {
  // N3-02: conditional write — only proceed if status is approved or expired
  try {
    await dynamo.updateRequest(requestId, {
      status: 'expired',
      expiredAt: new Date().toISOString(),
      revokedEarly: true,
      lockedByIT: true,
      ...actor
    }, {
      expression: '#__status IN (:__approved, :__expired)',
      names: { '#__status': 'status' },
      values: { ':__approved': 'approved', ':__expired': 'expired' }
    });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.warn(`handleLockDevice: request ${requestId} already processed (race condition), skipping`);
      return;
    }
    throw err;
  }

  // Cancel schedules
  if (request.warningSchedulerArn) {
    try { await scheduler.deleteSchedule(`warning-${requestId}`); } catch (e) {
      console.warn('handleLockDevice: could not delete warning schedule:', e.message);
    }
  }
  if (request.expirationSchedulerArn) {
    try { await scheduler.deleteSchedule(`expiration-${requestId}`); } catch (e) {
      console.warn('handleLockDevice: could not delete expiration schedule:', e.message);
    }
  }

  // Lock device via MDM
  await iru.lockDevice(request.iruDeviceId);

  // Remove elevation tag and assign log collection tag.
  // The network monitor on the device detects the revocation via /status polling
  // and calls `iru run` to pick up the log-collection tag immediately.
  const tagToRemoveLock = request.assignedElevationTag || process.env.IRU_ELEVATION_TAG_30MIN;
  await iru.removeTagByName(request.iruDeviceId, tagToRemoveLock);
  await iru.assignLogCollectionTag(request.iruDeviceId);

  // Notify thread — DM to user is sent by receiveLog once sudo logs are in hand
  await slack.postThreadReply(
    request.slackChannelId,
    request.slackThreadTs,
    `🔒 *Device locked* — *${request.deviceHostname}* has been locked via MDM. The user will need to contact IT to unlock it.`
  );

  console.log(`handleLockDevice: device locked for request ${requestId}`);
}

async function handleApprove(request, requestId, actor, approvedDuration) {
  const now = new Date();

  // N3-02: conditional write first — only approve if still pending (prevents double-approve race).
  // N11-02: DynamoDB write must succeed before assigning the Iru tag. If we tag first and the
  // write races, the device is elevated but the session is untracked and will never expire.
  try {
    await dynamo.updateRequest(requestId, {
      status: 'approved',
      approvedAt: now.toISOString(),
      approvedDuration,
      assignedElevationTag: iru.getElevationTagForDuration(approvedDuration),
      ...actor
    }, {
      expression: '#__status = :__pending',
      names: { '#__status': 'status' },
      values: { ':__pending': 'pending' }
    });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.warn(`handleApprove: request ${requestId} already processed (race condition), skipping Iru tag`);
      return;
    }
    throw err;
  }

  // Assign the duration-specific elevation tag only after the state transition is committed.
  // The device-side approval monitor detects approval via /status polling and
  // calls `iru run` directly to pick up the tag immediately.
  await iru.assignElevationTagForDuration(request.iruDeviceId, approvedDuration);

  const approvedDmNote = request.slackUserId
    ? `DM sent to <@${request.slackUserId}>.`
    : `No Slack user found for *${request.requestingUser}*${request.requestingUserEmail ? ` (${request.requestingUserEmail})` : ''} — DM not sent.`;

  // Notify thread — timer details will follow when device confirms
  await slack.postThreadReply(
    request.slackChannelId,
    request.slackThreadTs,
    `✅ *Approved* — elevation command sent to *${request.deviceHostname}*. ${approvedDuration}-minute timer will start when the device confirms elevation. ${approvedDmNote}`
  );

  if (request.slackUserId) {
    await slack.sendDM(
      request.slackUserId,
      `Your temporary admin access request for *${request.deviceHostname}* was approved. You will be elevated automatically — no action needed.\n\n⏱ *Please allow up to 15–45 minutes* for your device to check in with Iru and apply the change. You'll receive another message here once elevation is confirmed and your ${approvedDuration}-minute timer starts.`
    );
  }
}
