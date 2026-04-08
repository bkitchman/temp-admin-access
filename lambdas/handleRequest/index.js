const { v4: uuidv4 } = require('uuid');
const iru = require('../shared/iru');
const slack = require('../shared/slack');
const dynamo = require('../shared/dynamo');
const scheduler = require('../shared/scheduler');
const { isValidEmail } = require('../shared/validate');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambdaClient = new LambdaClient({});

// Async-invoke computeRiskScore to refresh risk score after a new request is created.
// Fire-and-forget — errors are logged but do not affect the request flow.
async function triggerRiskScoreRefresh(username) {
  const arn = process.env.COMPUTE_RISK_SCORE_FUNCTION_ARN;
  if (!arn) return;
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: arn,
      InvocationType: 'Event',
      Payload: JSON.stringify({ username })
    }));
    console.log(`handleRequest: triggered risk score refresh for "${username}"`);
  } catch (err) {
    console.warn(`handleRequest: failed to trigger risk score refresh for "${username}":`, err.message);
  }
}

// Classify request reason into a category for IT visibility and trend analysis.
// N6-03: use .includes() instead of regex — avoids ReDoS on untrusted input.
const REASON_KEYWORDS = {
  install:   ['install', 'package', 'brew', 'npm', 'pip', '.dmg', '.pkg', 'software', 'upgrade', 'download'],
  debug:     ['debug', 'diagnose', 'troubleshoot', 'investigate', 'error', 'crash', 'trace', 'analyze'],
  config:    ['config', 'configure', 'setting', 'preference', 'permission', 'setup', 'network', 'certificate'],
  security:  ['security', 'scan', 'pentest', 'audit', 'firewall', 'vpn'],
  developer: ['docker', 'xcode', 'homebrew', 'sdk', 'toolchain', 'compiler', 'runtime', 'framework']
};
function classifyReason(reason) {
  const text = reason.toLowerCase();
  for (const [category, words] of Object.entries(REASON_KEYWORDS)) {
    if (words.some(w => text.includes(w))) return category;
  }
  return 'other';
}

// Returns true when current UTC time is outside configured business hours.
// N6-08: fail closed — invalid config disables off-hours (does NOT auto-approve).
function isOffHours() {
  const start = parseInt(process.env.BUSINESS_HOURS_UTC_START || '13', 10);
  const end = parseInt(process.env.BUSINESS_HOURS_UTC_END || '23', 10);
  if (isNaN(start) || isNaN(end) || start < 0 || end > 23 || start >= end) {
    console.warn('handleRequest: BUSINESS_HOURS config invalid — off-hours auto-approval disabled');
    return false; // fail closed: do NOT auto-approve on bad config
  }
  const hour = new Date().getUTCHours();
  return hour < start || hour >= end;
}

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

    const { serial, hostname, username, reason, email, duration, requestCategory } = body;
    if (!serial || !hostname || !username || !reason) {
      return respond(400, { error: 'Missing required fields: serial, hostname, username, reason' });
    }

    // Enforce field length limits
    const LIMITS = { serial: 20, hostname: 255, username: 64, reason: 500, email: 254 };
    for (const [field, max] of Object.entries(LIMITS)) {
      if (body[field] && body[field].length > max) {
        return respond(400, { error: `${field} exceeds maximum length of ${max}` });
      }
    }

    // Validate serial format — uppercase alphanumeric, 8–14 chars (matches shell script validation)
    if (!/^[A-Z0-9]{8,14}$/.test(serial)) {
      return respond(400, { error: 'Invalid serial number format' });
    }

    // Validate email format if provided
    if (email && !isValidEmail(email)) {
      return respond(400, { error: 'Invalid email format' });
    }

    // Validate duration
    const ALLOWED_DURATIONS = [5, 10, 15, 30];
    const parsedDuration = parseInt(duration, 10);
    if (!duration || !ALLOWED_DURATIONS.includes(parsedDuration)) {
      return respond(400, { error: 'duration must be one of: 5, 10, 15, 30' });
    }

    // Classify reason — use caller-provided category if valid, otherwise auto-classify
    const ALLOWED_CATEGORIES = ['install', 'debug', 'config', 'security', 'developer', 'other'];
    const reasonCategory = (requestCategory && ALLOWED_CATEGORIES.includes(requestCategory))
      ? requestCategory
      : classifyReason(reason);

    // 3. Look up device in Iru by serial number
    const device = await iru.getDeviceBySerial(serial);
    const iruDeviceId = device.device_id;
    console.log('Resolved iruDeviceId:', iruDeviceId);

    // 4. Generate request ID
    const requestId = uuidv4();

    // 5. Resolve the user's Slack ID using their email (provided by Iru $EMAIL variable)
    const slackUserId = email ? await slack.lookupSlackUserByEmail(email) : null;

    // 5b. Look up cached risk score for this user (best-effort — never blocks the request)
    let cachedRiskScore = null;
    try {
      cachedRiskScore = await dynamo.getRiskScore(username);
      if (cachedRiskScore) {
        console.log(`handleRequest: cached risk score for "${username}": ${cachedRiskScore.score} (${cachedRiskScore.level})`);
      }
    } catch (err) {
      console.warn(`handleRequest: could not fetch risk score for "${username}":`, err.message);
    }

    // 5c. Generate a single-use dashboard token for this request's Slack link
    let dashboardUrl = null;
    if (process.env.DASHBOARD_URL) {
      const dashboardToken = uuidv4();
      const tokenTtl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days
      try {
        await dynamo.putDashboardToken({
          token: dashboardToken,
          requestId,
          username,
          createdAt: new Date().toISOString(),
          ttl: tokenTtl
        });
        dashboardUrl = `${process.env.DASHBOARD_URL}?user=${encodeURIComponent(username)}&token=${dashboardToken}`;
      } catch (err) {
        console.warn(`handleRequest: could not store dashboard token for "${username}":`, err.message);
      }
    }

    // 6. Post interactive approval message to the IT Slack channel
    const { channel: slackChannelId, ts: slackThreadTs } = await slack.postApprovalMessage({
      requestId,
      username,
      hostname,
      serial,
      reason,
      reasonCategory,
      duration: parsedDuration,
      riskScore: cachedRiskScore,
      dashboardUrl
    });

    // 7. Persist the request in DynamoDB with status: pending
    await dynamo.putRequest({
      requestId,
      slackChannelId,
      slackThreadTs,
      slackUserId: slackUserId ?? null,
      requestingUserEmail: email ?? null,
      iruDeviceId,
      deviceSerial: serial,
      deviceHostname: hostname,
      requestingUser: username,
      reason,
      reasonCategory,
      requestedDuration: parsedDuration,
      status: 'pending',
      createdAt: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60  // 90 days from now
    });

    // Off-hours approval delegation: if outside business hours and an on-call admin is
    // configured, automatically approve without requiring IT to be at a screen.
    // N8-10: evaluate isOffHours() once and store the decision — prevents a boundary-second
    // race where two invocations of the same request evaluate different off-hours values.
    const offHours = isOffHours();
    const onCallUserId = process.env.ON_CALL_SLACK_USER_ID;
    const processSlackActionArn = process.env.PROCESS_SLACK_ACTION_FUNCTION_ARN;

    // Schedule the first pending-request nudge unless this request will be auto-approved.
    // Skip when auto-deny is disabled (PENDING_AUTO_DENY_HOURS=0) to avoid orphaned schedules.
    const autoDenyHours = parseInt(process.env.PENDING_AUTO_DENY_HOURS || '24', 10);
    const nudgeArn = process.env.HANDLE_PENDING_NUDGE_FUNCTION_ARN;
    const nudgeIntervalMinutes = parseInt(process.env.PENDING_NUDGE_INTERVAL_MINUTES || '10', 10);
    const willAutoApprove = !!(onCallUserId && processSlackActionArn && offHours);
    if (nudgeArn && autoDenyHours > 0 && !willAutoApprove) {
      const firstNudgeAt = new Date(Date.now() + nudgeIntervalMinutes * 60 * 1000);
      try {
        await scheduler.createOneTimeSchedule({
          name:            `nudge-${requestId}`,
          invokeAt:        firstNudgeAt.toISOString(),
          targetLambdaArn: nudgeArn,
          payload:         { requestId, nudgeCount: 0, requestCreatedAt: new Date().toISOString() }
        });
        console.log(`handleRequest: scheduled first nudge for ${requestId} at ${firstNudgeAt.toISOString()}`);
      } catch (err) {
        console.warn(`handleRequest: could not schedule nudge for ${requestId}:`, err.message);
      }
    }

    if (onCallUserId && processSlackActionArn && offHours) {
      console.log(`handleRequest: off-hours — auto-approving ${requestId} via on-call ${onCallUserId}`);
      try {
        await slack.postThreadReply(
          slackChannelId,
          slackThreadTs,
          `🤖 *Off-hours auto-approval* — this request was received outside business hours and has been automatically approved by the on-call admin <@${onCallUserId}>.`
        );
        await lambdaClient.send(new InvokeCommand({
          FunctionName: processSlackActionArn,
          InvocationType: 'Event',
          Payload: JSON.stringify({
            actionId: `approve_${parsedDuration}`,
            requestId,
            actorSlackUserId: onCallUserId,
            actorSlackUsername: process.env.ON_CALL_SLACK_USERNAME || 'On-Call IT Admin',
            approvedDuration: parsedDuration
          })
        }));
      } catch (err) {
        console.error('handleRequest: off-hours auto-approval failed:', err.message);
        // N8-20: notify IT in the Slack thread so the request isn't silently stuck in pending
        try {
          await slack.postThreadReply(
            slackChannelId,
            slackThreadTs,
            `⚠️ Off-hours auto-approval failed — manual IT review required. (${err.message})`
          );
        } catch (notifyErr) {
          console.error('handleRequest: failed to post auto-approval failure notice:', notifyErr.message);
        }
      }
    }

    // Async-invoke computeRiskScore to refresh the cached score for next time
    await triggerRiskScoreRefresh(username);

    return respond(200, { message: 'Request submitted successfully', requestId });
  } catch (err) {
    console.error('handleRequest error:', err);
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
