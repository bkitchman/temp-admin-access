const { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } = require('@aws-sdk/client-scheduler');

const scheduler = new SchedulerClient({});
const ROLE_ARN = process.env.EVENTBRIDGE_ROLE_ARN;

// Create a one-time EventBridge Scheduler rule to invoke a Lambda at a specific UTC time.
// `invokeAt` must be an ISO8601 datetime string (e.g. "2024-01-15T14:30:00").
// Returns the schedule ARN.
const ALLOWED_TARGET_ARNS = new Set([
  process.env.SEND_WARNING_FUNCTION_ARN,
  process.env.HANDLE_EXPIRATION_FUNCTION_ARN
].filter(Boolean));

async function createOneTimeSchedule({ name, invokeAt, targetLambdaArn, payload }) {
  // Validate format before slicing — a short or malformed string would produce a silent bad expression
  if (!invokeAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(invokeAt)) {
    throw new Error(`createOneTimeSchedule: invalid invokeAt format: ${invokeAt}`);
  }
  // Whitelist allowed target ARNs — prevents misuse if this module is called with untrusted input
  if (!ALLOWED_TARGET_ARNS.has(targetLambdaArn)) {
    throw new Error(`createOneTimeSchedule: targetLambdaArn not in allowed list`);
  }
  // Strip milliseconds — EventBridge at() expression requires exactly "yyyy-MM-ddTHH:mm:ss"
  const atExpression = invokeAt.slice(0, 19);

  const command = new CreateScheduleCommand({
    Name: name,
    ScheduleExpression: `at(${atExpression})`,
    ScheduleExpressionTimezone: 'UTC',
    FlexibleTimeWindow: { Mode: 'OFF' },
    Target: {
      Arn: targetLambdaArn,
      RoleArn: ROLE_ARN,
      Input: JSON.stringify(payload)
    },
    // Automatically delete the schedule after it fires
    ActionAfterCompletion: 'DELETE'
  });

  const result = await scheduler.send(command);
  return result.ScheduleArn;
}

// Delete a schedule by name (used for cleanup if a request is denied before firing)
async function deleteSchedule(name) {
  const command = new DeleteScheduleCommand({ Name: name });
  await scheduler.send(command);
}

module.exports = { createOneTimeSchedule, deleteSchedule };
