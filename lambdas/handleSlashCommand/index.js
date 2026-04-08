const slack = require('../shared/slack');
const dynamo = require('../shared/dynamo');
const { isValidUUID } = require('../shared/validate');

const STATUS_EMOJI = { pending: '⏳', approved: '🟢', expired: '🔒', denied: '❌', expired_unanswered: '⏰', completed_by_user: '✅' };

// N6-02: Only allow designated IT admin Slack users to call this command.
// Set SLACK_IT_ADMIN_IDS to a comma-separated list of Slack user IDs (e.g. U012ABC,U034DEF).
// If the env var is empty or unset, access is denied to everyone (fail closed).
function isAuthorizedItAdmin(slackUserId) {
  const allowList = (process.env.SLACK_IT_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowList.length === 0) {
    console.warn('handleSlashCommand: SLACK_IT_ADMIN_IDS not configured — denying all access');
    return false;
  }
  return allowList.includes(slackUserId);
}

exports.handler = async (event) => {
  // 1. Verify Slack signature
  const rawBody = event.body ?? '';
  try {
    slack.verifySlackSignature(event.headers, rawBody);
  } catch (err) {
    console.warn('handleSlashCommand: signature verification failed:', err.message);
    return respond(401, { error: 'Unauthorized' });
  }

  // 2. Parse URL-encoded body (Slack slash commands send application/x-www-form-urlencoded)
  const params = new URLSearchParams(rawBody);
  const callerUserId = params.get('user_id') || '';
  const text = (params.get('text') || '').trim();

  // 3. N6-02: Authorize — only IT admins in the allow-list can use this command
  if (!isAuthorizedItAdmin(callerUserId)) {
    console.warn(`handleSlashCommand: unauthorized user ${callerUserId}`);
    return respond(200, {
      response_type: 'ephemeral',
      text: 'You are not authorized to use this command. Contact IT if you need access.'
    });
  }

  try {
    if (text && isValidUUID(text)) {
      // /admin-status <requestId> — look up a specific request
      const request = await dynamo.getRequest(text);
      if (!request) {
        return respond(200, { response_type: 'ephemeral', text: `No request found with ID \`${text}\`` });
      }
      return respond(200, formatRequestDetail(request));
    } else {
      // /admin-status — list all active (approved + pending) sessions
      const sessions = await dynamo.scanActiveRequests();
      return respond(200, formatSessionList(sessions));
    }
  } catch (err) {
    console.error('handleSlashCommand error:', err);
    return respond(200, { response_type: 'ephemeral', text: 'An error occurred. Please try again.' });
  }
};

function formatRequestDetail(req) {
  const emoji = STATUS_EMOJI[req.status] || '❓';
  const lines = [
    `*Status:* ${emoji} ${req.status}`,
    `*User:* ${slack.escapeSlack(req.requestingUser)}`,
    `*Hostname:* ${slack.escapeSlack(req.deviceHostname)}`,
    `*Serial:* ${slack.escapeSlack(req.deviceSerial)}`,
    `*Category:* ${req.reasonCategory || 'other'}`,
    `*Reason:* ${slack.escapeSlack(req.reason || '')}`,
    `*Created:* ${req.createdAt || '—'}`,
    req.approvedAt      ? `*Approved:* ${req.approvedAt}` : null,
    req.elevationEndTime ? `*Expires:* ${req.elevationEndTime}` : null,
    req.expiredAt       ? `*Expired:* ${req.expiredAt}` : null,
    req.actorSlackUserId ? `*Actor:* <@${req.actorSlackUserId}>` : null
  ].filter(Boolean).join('\n');

  return {
    response_type: 'ephemeral',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `🔐 Request ${req.requestId.slice(0, 8)}…`, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: lines } }
    ]
  };
}

function formatSessionList(sessions) {
  if (sessions.length === 0) {
    return { response_type: 'ephemeral', text: '✅ No active or pending admin access sessions.' };
  }

  // Sort: approved first, then pending; within each group, newest first
  sessions.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'approved' ? -1 : 1;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🔐 Active Admin Sessions (${sessions.length})`, emoji: true }
    }
  ];

  for (const req of sessions.slice(0, 10)) {
    const emoji = STATUS_EMOJI[req.status] || '❓';
    let timeInfo = '';
    if (req.elevationEndTime) {
      const epoch = Math.floor(new Date(req.elevationEndTime).getTime() / 1000);
      timeInfo = `expires <!date^${epoch}^at {time}|${req.elevationEndTime}>`;
    } else if (req.createdAt) {
      timeInfo = `requested ${req.createdAt.slice(0, 16)} UTC`;
    }
    const shortReason = slack.escapeSlack((req.reason || '').slice(0, 60));
    const shortId = req.requestId.slice(0, 8);

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${slack.escapeSlack(req.requestingUser)}* on *${slack.escapeSlack(req.deviceHostname)}*\n_${shortReason}_ · ${req.status} · ${timeInfo} · \`${shortId}…\``
      }
    });
  }

  if (sessions.length > 10) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_…and ${sessions.length - 10} more. Use \`/admin-status <requestId>\` for details._` }]
    });
  }

  return { response_type: 'ephemeral', blocks };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
