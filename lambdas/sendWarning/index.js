const dynamo = require('../shared/dynamo');
const slack = require('../shared/slack');
const { escapeSlack } = slack;

exports.handler = async (event) => {
  const { requestId } = event;

  if (!requestId) {
    console.error('sendWarning: missing requestId in event payload');
    return;
  }

  const request = await dynamo.getRequest(requestId);
  if (!request) {
    console.error('sendWarning: request not found:', requestId);
    return;
  }

  if (request.status !== 'approved') {
    console.warn(`sendWarning: request ${requestId} is not in approved status (${request.status}), skipping`);
    return;
  }

  // Kandji has no API to push on-device notifications directly.
  // Send a Slack DM instead — this is the primary warning channel.
  if (request.slackUserId) {
    await slack.sendDM(
      request.slackUserId,
      `⚠️ Your temporary admin access for *${escapeSlack(request.deviceHostname)}* expires in *5 minutes*. Save your work and prepare to close any elevated sessions.`
    );
  }

  // Also post to the IT thread for visibility
  await slack.postThreadReply(
    request.slackChannelId,
    request.slackThreadTs,
    `⚠️ 5-minute warning sent to *${escapeSlack(request.requestingUser)}*.`
  );

  console.log(`sendWarning: 5-minute warning sent for request ${requestId}`);
};
