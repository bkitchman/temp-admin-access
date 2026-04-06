const { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } = require('@aws-sdk/client-scheduler');

const scheduler = new SchedulerClient({});
const ROLE_ARN = process.env.EVENTBRIDGE_ROLE_ARN;

// Create a one-time EventBridge Scheduler rule to invoke a Lambda at a specific UTC time.
// `invokeAt` must be an ISO8601 datetime string (e.g. "2024-01-15T14:30:00").
// Returns the schedule ARN.
async function createOneTimeSchedule({ name, invokeAt, targetLambdaArn, payload }) {
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
