const { CostExplorerClient, GetCostAndUsageCommand } = require('@aws-sdk/client-cost-explorer');
const slack = require('../shared/slack');

// Cost Explorer is a global service — must use us-east-1
const ce = new CostExplorerClient({ region: 'us-east-1' });

const TAG_KEY   = 'Project';
const TAG_VALUE = 'temp-admin-access';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Shorten verbose AWS service names for Slack display
const SERVICE_LABELS = {
  'AWS Lambda':                    'Lambda',
  'Amazon DynamoDB':               'DynamoDB',
  'Amazon Bedrock':                'Bedrock',
  'Amazon CloudFront':             'CloudFront',
  'Amazon API Gateway':            'API Gateway',
  'AWS Key Management Service':    'KMS',
  'Amazon Simple Storage Service': 'S3',
  'AWS CloudFormation':            'CloudFormation',
  'Amazon EventBridge':            'EventBridge',
  'AWS Secrets Manager':           'Secrets Manager',
};

function shortServiceName(name) {
  return SERVICE_LABELS[name] || name;
}

function isAuthorizedItAdmin(slackUserId) {
  const allowList = (process.env.SLACK_IT_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowList.length === 0) {
    console.warn('getCostReport: SLACK_IT_ADMIN_IDS not configured — denying all access');
    return false;
  }
  return allowList.includes(slackUserId);
}

function getDateRanges() {
  const now   = new Date();
  const year  = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-indexed
  const day   = now.getUTCDate();

  const pad = n => String(n).padStart(2, '0');

  // MTD: first of this month → today (end is exclusive, so today gives us through yesterday)
  const mtdStart = `${year}-${pad(month)}-01`;
  const mtdEnd   = `${year}-${pad(month)}-${pad(day)}`;
  const mtdHasData = mtdStart < mtdEnd; // false on the 1st of the month

  // Last data day label (yesterday)
  const lastDay = day - 1;
  const mtdLabel = mtdHasData
    ? `${MONTHS[month-1]} 1\u2013${MONTHS[month-1]} ${lastDay}, ${year}`
    : `${MONTHS[month-1]} ${year} (no data yet)`;

  // Previous month
  let prevYear = year, prevMonth = month - 1;
  if (prevMonth === 0) { prevMonth = 12; prevYear--; }
  const prevStart = `${prevYear}-${pad(prevMonth)}-01`;
  const prevEnd   = mtdStart; // first of current month (exclusive end = full previous month)
  const prevLabel = `${MONTHS[prevMonth-1]} ${prevYear}`;

  return { mtdStart, mtdEnd, mtdHasData, mtdLabel, prevStart, prevEnd, prevLabel };
}

async function fetchCosts(startDate, endDate) {
  const result = await ce.send(new GetCostAndUsageCommand({
    TimePeriod:  { Start: startDate, End: endDate },
    Granularity: 'MONTHLY',
    Filter: {
      Tags: { Key: TAG_KEY, Values: [TAG_VALUE] }
    },
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    Metrics: ['UnblendedCost'],
  }));

  const rows = [];
  let total  = 0;

  for (const period of result.ResultsByTime || []) {
    for (const group of period.Groups || []) {
      const name   = group.Keys[0];
      const amount = parseFloat(group.Metrics.UnblendedCost.Amount);
      if (amount > 0.00001) {
        rows.push({ name: shortServiceName(name), amount });
        total += amount;
      }
    }
  }

  rows.sort((a, b) => b.amount - a.amount);
  return { rows, total };
}

function formatAmount(n) {
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
}

function buildServiceTable(rows, total) {
  if (rows.length === 0) return '_No costs recorded_';
  const lines = rows.map(r => `• ${r.name}: *${formatAmount(r.amount)}*`);
  lines.push(`*Total: ${formatAmount(total)}*`);
  return lines.join('\n');
}

exports.handler = async (event) => {
  const rawBody = event.body ?? '';

  // 1. Verify Slack signature
  try {
    slack.verifySlackSignature(event.headers, rawBody);
  } catch (err) {
    console.warn('getCostReport: signature verification failed:', err.message);
    return respond(401, { error: 'Unauthorized' });
  }

  // 2. Parse body
  const params      = new URLSearchParams(rawBody);
  const callerUserId = params.get('user_id') || '';

  // 3. Authorize — IT admins only
  if (!isAuthorizedItAdmin(callerUserId)) {
    console.warn(`getCostReport: unauthorized user ${callerUserId}`);
    return respond(200, {
      response_type: 'ephemeral',
      text: 'You are not authorized to use this command. Contact IT if you need access.',
    });
  }

  try {
    const { mtdStart, mtdEnd, mtdHasData, mtdLabel, prevStart, prevEnd, prevLabel } = getDateRanges();

    const [mtd, prev] = await Promise.all([
      mtdHasData ? fetchCosts(mtdStart, mtdEnd) : Promise.resolve({ rows: [], total: 0 }),
      fetchCosts(prevStart, prevEnd),
    ]);

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '💰 Admin Access — AWS Cost Report', emoji: true },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*📅 Month to date (${mtdLabel})*\n${buildServiceTable(mtd.rows, mtd.total)}`,
          },
          {
            type: 'mrkdwn',
            text: `*📅 Previous month (${prevLabel})*\n${buildServiceTable(prev.rows, prev.total)}`,
          },
        ],
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: 'ℹ️ Month-to-date figures reflect costs through yesterday. Cost Explorer data has a ~24-hour lag. Costs are filtered to the `Project: temp-admin-access` tag.',
        }],
      },
    ];

    return respond(200, { response_type: 'ephemeral', blocks });
  } catch (err) {
    console.error('getCostReport error:', err);
    return respond(200, {
      response_type: 'ephemeral',
      text: `Error fetching cost data: ${err.message}`,
    });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
