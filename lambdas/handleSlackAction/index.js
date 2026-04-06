const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const slack = require('../shared/slack');

const lambdaClient = new LambdaClient({});

exports.handler = async (event) => {
  // 1. Verify Slack signature — must happen before anything else
  const rawBody = event.body ?? '';
  try {
    slack.verifySlackSignature(event.headers, rawBody);
  } catch (err) {
    console.warn('Slack signature verification failed:', err.message);
    return respond(401, 'Unauthorized');
  }

  // 2. Parse the URL-encoded Slack interaction payload
  const params = new URLSearchParams(rawBody);
  let payload;
  try {
    payload = JSON.parse(params.get('payload'));
  } catch {
    return respond(400, 'Invalid payload');
  }

  const action = payload.actions?.[0];
  if (!action) return respond(200, '');

  // 3. Invoke processSlackAction asynchronously — fire and forget.
  //    InvocationType: 'Event' returns immediately without waiting for the result.
  //    Include the actor's Slack identity for audit logging (N3-01).
  await lambdaClient.send(new InvokeCommand({
    FunctionName: process.env.PROCESS_SLACK_ACTION_FUNCTION_ARN,
    InvocationType: 'Event',
    Payload: JSON.stringify({
      actionId: action.action_id,
      requestId: action.value,
      actorSlackUserId: payload.user?.id ?? null,
      actorSlackUsername: payload.user?.name ?? null
    })
  }));

  // 4. Return 200 to Slack immediately — well within the 3-second deadline
  return respond(200, '');
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  };
}
