// Slack API helpers
const crypto = require('crypto');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const IT_CHANNEL_ID = process.env.SLACK_IT_CHANNEL_ID;

// Fail loudly at Lambda cold-start if required secrets are missing
if (!SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN environment variable is required');
if (!SLACK_SIGNING_SECRET) throw new Error('SLACK_SIGNING_SECRET environment variable is required');
const SLACK_API = 'https://slack.com/api';

// Escape Slack mrkdwn special characters in user-provided strings.
// Prevents link injection (<URL|text>), mentions, and formatting manipulation.
function escapeSlack(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function slackRequest(method, endpoint, body) {
  const url = `${SLACK_API}${endpoint}`;
  const isGet = method === 'GET';

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8'
    }
  };
  if (!isGet && body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!data.ok) {
    console.error(`Slack API error on ${endpoint}:`, data.error);
    throw new Error(`Slack API error (${data.error})`);
  }
  return data;
}

// Verify Slack request signature (HMAC-SHA256)
function verifySlackSignature(headers, rawBody) {
  const timestamp = headers['x-slack-request-timestamp'] || headers['X-Slack-Request-Timestamp'];
  const signature = headers['x-slack-signature'] || headers['X-Slack-Signature'];

  if (!timestamp || !signature) {
    throw new Error('Missing Slack signature headers');
  }

  // Reject stale requests (> 5 minutes)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    throw new Error('Slack request timestamp too old — possible replay attack');
  }

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET);
  hmac.update(sigBase);
  const computed = `v0=${hmac.digest('hex')}`;

  if (!crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature))) {
    throw new Error('Invalid Slack signature');
  }
}

const CATEGORY_DISPLAY = {
  install:   '📦 Install / Software',
  debug:     '🔍 Debug / Diagnose',
  config:    '⚙️ Config / Settings',
  security:  '🔒 Security',
  developer: '🛠 Developer Tools',
  other:     '📝 Other'
};

// Post interactive approval message to IT channel
// Returns { channel, ts } to store as the thread anchor
async function postApprovalMessage({ requestId, username, hostname, serial, reason, reasonCategory, duration }) {
  const safeUsername = escapeSlack(username);
  const safeHostname = escapeSlack(hostname);
  const safeSerial = escapeSlack(serial);
  const safeReason = escapeSlack(reason);
  const categoryLabel = CATEGORY_DISPLAY[reasonCategory] || CATEGORY_DISPLAY.other;

  // Generate the 4 approval duration buttons
  const DURATIONS = [5, 10, 15, 30];
  const approvalButtons = DURATIONS.map(d => ({
    type: 'button',
    text: { type: 'plain_text', text: `✅ ${d} min`, emoji: true },
    style: d === duration ? 'primary' : undefined,
    action_id: `approve_${d}`,
    value: requestId,
    confirm: {
      title: { type: 'plain_text', text: 'Approve Access?' },
      text: { type: 'mrkdwn', text: `Grant *${safeUsername}* temporary admin on *${safeHostname}* for *${d} minutes*?` },
      confirm: { type: 'plain_text', text: 'Approve' },
      deny: { type: 'plain_text', text: 'Cancel' }
    }
  }));

  const denyButton = {
    type: 'button',
    text: { type: 'plain_text', text: '❌ Deny', emoji: true },
    style: 'danger',
    action_id: 'deny_request',
    value: requestId
  };

  const data = await slackRequest('POST', '/chat.postMessage', {
    channel: IT_CHANNEL_ID,
    text: `Admin access request from ${safeUsername} on ${safeHostname}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🔐 Temporary Admin Access Request', emoji: true }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Requesting User:*\n${safeUsername}` },
          { type: 'mrkdwn', text: `*Device Hostname:*\n${safeHostname}` },
          { type: 'mrkdwn', text: `*Serial Number:*\n${safeSerial}` },
          { type: 'mrkdwn', text: `*Category:*\n${categoryLabel}` }
        ]
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Requested Duration:*\n⏱ ${duration} minutes` }
      },
      {
        // N6-04: plain_text prevents mrkdwn formatting injection (*bold*, _italic_, <URL|text>)
        // safeReason is still escaped for defense-in-depth
        type: 'section',
        text: { type: 'plain_text', text: `Reason: ${safeReason}`, emoji: false }
      },
      { type: 'divider' },
      {
        type: 'actions',
        elements: [...approvalButtons, denyButton]
      }
    ]
  });

  return { channel: data.channel, ts: data.ts };
}

// Replace the content of a posted message
async function updateThreadMessage(channel, ts, text) {
  return slackRequest('POST', '/chat.update', { channel, ts, text });
}

// Update the original approval message to its final completed state once sudo logs
// have been collected. Replaces all action buttons and shows the outcome + log status.
// outcome: 'expired' | 'revoked_early' | 'locked' | 'network_loss'
async function updateApprovalMessageCompleted({ channel, ts, username, hostname, serial, reason, outcome }) {
  const safeUsername = escapeSlack(username);
  const safeHostname = escapeSlack(hostname);
  const safeSerial = escapeSlack(serial);
  const safeReason = escapeSlack(reason);

  const OUTCOME_META = {
    locked:       { header: '🔒 Admin Access Request — Device Locked',        timeline: '✅ Approved → 🔒 Device locked → 📋 Sudo log collected' },
    network_loss: { header: '⚠️ Admin Access Request — Revoked (Network Loss)', timeline: '✅ Approved → ⚠️ Revoked (network loss) → 📋 Sudo log collected' },
    revoked_early:{ header: '⛔ Admin Access Request — Revoked Early',          timeline: '✅ Approved → ⛔ Revoked by IT → 📋 Sudo log collected' },
    expired:      { header: '🔒 Admin Access Request — Completed',              timeline: '✅ Approved → ⏱ Session expired → 📋 Sudo log collected' }
  };
  const meta = OUTCOME_META[outcome] || OUTCOME_META.expired;

  return slackRequest('POST', '/chat.update', {
    channel,
    ts,
    text: `Admin access request from ${safeUsername} — ${outcome}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: meta.header, emoji: true }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*User:*\n${safeUsername}` },
          { type: 'mrkdwn', text: `*Device:*\n${safeHostname}` },
          { type: 'mrkdwn', text: `*Serial:*\n${safeSerial}` },
          { type: 'mrkdwn', text: `*Reason:*\n${safeReason}` }
        ]
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: meta.timeline }
        ]
      }
    ]
  });
}

// Post a reply in the thread anchored at ts
async function postThreadReply(channel, ts, text) {
  return slackRequest('POST', '/chat.postMessage', {
    channel,
    thread_ts: ts,
    text
  });
}

// Post a thread reply with a Revoke Access button
async function postRevokeButton({ channel, ts, requestId, username, hostname, expiresAt }) {
  const safeUsername = escapeSlack(username);
  const safeHostname = escapeSlack(hostname);
  const expiresEpoch = Math.floor(new Date(expiresAt).getTime() / 1000);
  return slackRequest('POST', '/chat.postMessage', {
    channel,
    thread_ts: ts,
    text: `Access active for ${safeUsername} on ${safeHostname}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🟢 *Access active* for *${safeUsername}* on *${safeHostname}*. Expires <!date^${expiresEpoch}^at {time}|at ${expiresAt}>.`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '⛔ Revoke Access Now', emoji: true },
            style: 'danger',
            action_id: 'revoke_request',
            value: requestId,
            confirm: {
              title: { type: 'plain_text', text: 'Revoke Access?' },
              text: { type: 'mrkdwn', text: `Immediately revoke admin access for *${safeUsername}* on *${safeHostname}*?` },
              confirm: { type: 'plain_text', text: 'Revoke' },
              deny: { type: 'plain_text', text: 'Cancel' }
            }
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '🔒 Lock Device', emoji: true },
            style: 'danger',
            action_id: 'lock_device',
            value: requestId,
            confirm: {
              title: { type: 'plain_text', text: 'Lock Device?' },
              text: { type: 'mrkdwn', text: `Lock *${safeHostname}* immediately via MDM? Contact IT to arrange unlock.` },
              confirm: { type: 'plain_text', text: 'Lock' },
              deny: { type: 'plain_text', text: 'Cancel' }
            }
          }
        ]
      }
    ]
  });
}

// Open a DM channel with a user and send a message
async function sendDM(slackUserId, text) {
  const openData = await slackRequest('POST', '/conversations.open', {
    users: slackUserId
  });
  const dmChannelId = openData.channel.id;
  return slackRequest('POST', '/chat.postMessage', {
    channel: dmChannelId,
    text
  });
}

// Upload a text file to a Slack thread using the v2 upload API
async function uploadLogToThread(channel, ts, filename, content) {
  const byteLength = Buffer.byteLength(content, 'utf8');
  console.log(`uploadLogToThread: filename=${filename} length=${byteLength}`);

  // Step 1: Get an upload URL
  const urlData = await slackRequest('GET',
    `/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${byteLength}`
  );
  console.log('uploadLogToThread: got upload URL');

  // Step 2: PUT file content to the upload URL
  const uploadResponse = await fetch(urlData.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: content
  });

  if (!uploadResponse.ok) {
    const errText = await uploadResponse.text();
    throw new Error(`Slack file PUT failed: ${uploadResponse.status} ${errText}`);
  }
  console.log('uploadLogToThread: file content uploaded');

  // Step 3: Finalize the upload. Do NOT pass channel_id + thread_ts together —
  // Slack silently ignores both when combined, leaving channels:[].
  const completeData = await slackRequest('POST', '/files.completeUploadExternal', {
    files: [{ id: urlData.file_id, title: filename }]
  });

  const file = completeData.files?.[0];
  console.log('uploadLogToThread: complete, file id=', file?.id, 'permalink=', file?.permalink);

  if (!file?.permalink) throw new Error('Slack upload complete but no permalink returned');

  // Step 4: Post the file permalink into the thread as a clickable link.
  await slackRequest('POST', '/chat.postMessage', {
    channel,
    thread_ts: ts,
    text: `📋 <${file.permalink}|${filename}> — sudo audit log for this session.`,
    unfurl_links: true
  });

  return completeData;
}

// Resolve a Slack user ID directly from an email address (e.g. from Iru $EMAIL variable).
// Requires the bot token to have the users:read.email OAuth scope.
async function lookupSlackUserByEmail(email) {
  try {
    const data = await slackRequest('GET', `/users.lookupByEmail?email=${encodeURIComponent(email)}`);
    const userId = data.user?.id || null;
    if (userId) {
      console.log(`lookupSlackUserByEmail: resolved ${email} -> ${userId}`);
    } else {
      console.warn(`lookupSlackUserByEmail: no user found for ${email} — DM will not be sent`);
    }
    return userId;
  } catch (err) {
    // users.lookupByEmail returns error:'users_not_found' if no match,
    // or error:'missing_scope' if the bot lacks users:read.email
    console.warn(`lookupSlackUserByEmail: lookup failed for ${email} — error: ${err.message}`);
    console.warn('lookupSlackUserByEmail: verify the bot token has the users:read.email OAuth scope');
    return null;
  }
}

// Attempt to resolve a Slack user ID from a macOS username.
// Assumes the user's work email is username@EMAIL_DOMAIN.
// Returns null if not found — DMs will be skipped gracefully.
async function lookupSlackUserId(username) {
  const emailDomain = process.env.EMAIL_DOMAIN;
  if (!emailDomain) {
    console.warn('lookupSlackUserId: EMAIL_DOMAIN not set, skipping');
    return null;
  }
  const email = `${username}@${emailDomain}`;
  try {
    const data = await slackRequest('GET', `/users.lookupByEmail?email=${encodeURIComponent(email)}`);
    console.log(`lookupSlackUserId: resolved ${email} -> ${data.user?.id ?? 'not found'}`);
    return data.user?.id || null;
  } catch (err) {
    console.warn(`lookupSlackUserId: failed for ${email}:`, err.message);
    return null;
  }
}

module.exports = {
  escapeSlack,
  verifySlackSignature,
  postApprovalMessage,
  updateThreadMessage,
  updateApprovalMessageCompleted,
  postThreadReply,
  postRevokeButton,
  sendDM,
  uploadLogToThread,
  lookupSlackUserId,
  lookupSlackUserByEmail
};
