// Nudge the IT Slack channel for requests that are still pending approval.
// Invoked by EventBridge Scheduler on a configurable interval.
// Automatically denies the request as `expired_unanswered` after the configured timeout.
// `expired_unanswered` is intentionally excluded from AI risk scoring — no-response is not
// a behavioural signal, just an administrative timeout.
const dynamo = require('../shared/dynamo');
const slack = require('../shared/slack');
const scheduler = require('../shared/scheduler');

exports.handler = async (event) => {
  const { requestId, nudgeCount, requestCreatedAt } = event;

  if (!requestId) {
    console.error('handlePendingNudge: missing requestId in event payload');
    return;
  }

  try {
    const request = await dynamo.getRequest(requestId);
    if (!request) {
      console.log(`handlePendingNudge: request ${requestId} not found — skipping`);
      return;
    }

    // Idempotency guard: only act on requests still in pending state
    if (request.status !== 'pending') {
      console.log(`handlePendingNudge: request ${requestId} is ${request.status} — skipping`);
      return;
    }

    const autoDenyHours    = parseInt(process.env.PENDING_AUTO_DENY_HOURS            || '24', 10);
    const phase1Hours      = parseInt(process.env.PENDING_NUDGE_PHASE1_HOURS         || '1',  10);
    const phase1Interval   = parseInt(process.env.PENDING_NUDGE_INTERVAL_MINUTES     || '10', 10);
    const phase2Interval   = parseInt(process.env.PENDING_NUDGE_PHASE2_INTERVAL_MINUTES || '60', 10);

    // Always use the DynamoDB value as the authoritative creation time — never trust
    // the caller's requestCreatedAt which comes from an EventBridge payload.
    const createdAt = request.createdAt;
    if (!createdAt) {
      console.error(`handlePendingNudge: request ${requestId} has no createdAt — skipping`);
      return;
    }

    // Validate nudgeCount: must be a non-negative integer within a sane bound.
    // Malformed payloads (direct invocations, corrupted schedules) should not cause
    // runaway re-scheduling or bypass the auto-deny deadline.
    const rawCount = typeof nudgeCount === 'number' ? nudgeCount : 0;
    if (rawCount < 0 || rawCount > 200) {
      console.error(`handlePendingNudge: invalid nudgeCount ${nudgeCount} for ${requestId} — skipping`);
      return;
    }
    const count = rawCount + 1;

    const elapsedMinutes  = (Date.now() - new Date(createdAt).getTime()) / 60000;

    // -----------------------------------------------------------------------
    // Auto-deny path: elapsed time has exceeded the configured limit
    // -----------------------------------------------------------------------
    if (autoDenyHours > 0 && elapsedMinutes >= autoDenyHours * 60) {
      try {
        await dynamo.updateRequest(requestId, {
          status:          'expired_unanswered',
          expiredAt:       new Date().toISOString(),
          autoDeniedAt:    new Date().toISOString()
        }, {
          expression: '#__status = :__pending',
          names:  { '#__status': 'status' },
          values: { ':__pending': 'pending' }
        });
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') {
          console.log(`handlePendingNudge: ${requestId} no longer pending during auto-deny — skipping`);
          return;
        }
        throw err;
      }

      await slack.postThreadReply(
        request.slackChannelId,
        request.slackThreadTs,
        `⏰ *Request expired* — the request from *${request.requestingUser}* on *${request.deviceHostname}* was automatically closed after ${autoDenyHours}h with no IT response. No further action required.`
      );

      if (request.slackUserId) {
        await slack.sendDM(
          request.slackUserId,
          `Your temporary admin access request for *${request.deviceHostname}* was automatically closed after ${autoDenyHours} hours with no response from IT. Please resubmit if you still need access.`
        );
      }

      console.log(`handlePendingNudge: auto-denied ${requestId} as expired_unanswered after ${Math.round(elapsedMinutes)} min`);
      return;
    }

    // -----------------------------------------------------------------------
    // Nudge path: post a thread reminder and schedule the next nudge
    // -----------------------------------------------------------------------
    const phase            = elapsedMinutes < phase1Hours * 60 ? 1 : 2;
    const currentInterval  = phase === 1 ? phase1Interval : phase2Interval;
    const elapsedHuman     = elapsedMinutes >= 60
      ? `${Math.floor(elapsedMinutes / 60)}h ${Math.round(elapsedMinutes % 60)}m`
      : `${Math.round(elapsedMinutes)}m`;

    await slack.postThreadReply(
      request.slackChannelId,
      request.slackThreadTs,
      `⏳ *Pending review* — the request from *${request.requestingUser}* on *${request.deviceHostname}* is still awaiting IT approval (${elapsedHuman} elapsed, nudge #${count}).`
    );

    // Determine next nudge interval — switch to phase 2 if next invocation crosses the boundary
    const nextElapsedMinutes = elapsedMinutes + currentInterval;
    const nextInterval = nextElapsedMinutes >= phase1Hours * 60 ? phase2Interval : currentInterval;

    // Calculate the absolute time for the next nudge
    let nextNudgeAt;
    if (autoDenyHours > 0 && nextElapsedMinutes >= autoDenyHours * 60) {
      // Pin the final invocation exactly to the auto-deny deadline so it fires the auto-deny path
      nextNudgeAt = new Date(new Date(createdAt).getTime() + autoDenyHours * 60 * 60 * 1000);
    } else {
      nextNudgeAt = new Date(Date.now() + nextInterval * 60 * 1000);
    }

    // Hard cap: if auto-deny is disabled and nudges somehow accumulate, stop at 200.
    // This prevents runaway scheduling in misconfigured or stuck-pending requests.
    if (count > 200) {
      console.warn(`handlePendingNudge: nudge count ${count} exceeds hard cap for ${requestId} — not rescheduling`);
      return;
    }

    // Only schedule if the next time is meaningfully in the future (>30s)
    if (nextNudgeAt.getTime() > Date.now() + 30000) {
      const nudgeArn = process.env.HANDLE_PENDING_NUDGE_FUNCTION_ARN;
      if (nudgeArn) {
        await scheduler.createOneTimeSchedule({
          name:           `nudge-${requestId}`,
          invokeAt:       nextNudgeAt.toISOString(),
          targetLambdaArn: nudgeArn,
          payload:        { requestId, nudgeCount: count, requestCreatedAt: createdAt }
        });
        console.log(`handlePendingNudge: nudge #${count} sent for ${requestId}; next in ${nextInterval}min at ${nextNudgeAt.toISOString()}`);
      }
    } else {
      console.log(`handlePendingNudge: nudge #${count} sent for ${requestId}; next nudge too close or past auto-deny — not rescheduling`);
    }
  } catch (err) {
    console.error(`handlePendingNudge: error for ${requestId}:`, err.message);
  }
};
