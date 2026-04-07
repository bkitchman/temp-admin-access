// GET /dashboard — returns admin access history and AI risk scores for the dashboard UI.
// Protected by DASHBOARD_API_KEY (separate from the device-facing SELF_SERVICE_API_KEY).
// Optional query param: ?user=username to scope to a single user's history.
const dynamo = require('../shared/dynamo');

exports.handler = async (event) => {
  try {
    const apiKey = event.headers?.['x-api-key'] ?? event.headers?.['X-Api-Key'];
    if (!apiKey || apiKey !== process.env.DASHBOARD_API_KEY) {
      return respond(401, { error: 'Unauthorized' });
    }

    const userFilter = event.queryStringParameters?.user || null;

    // Fetch all requests and risk scores in parallel
    const [allRequests, allScores] = await Promise.all([
      dynamo.scanAllRequests(),
      dynamo.scanAllRiskScores()
    ]);

    // Index risk scores by username for O(1) lookup
    const scoresByUser = {};
    for (const s of allScores) {
      scoresByUser[s.username] = s;
    }

    // Group requests by user
    const requestsByUser = {};
    for (const r of allRequests) {
      const u = r.requestingUser || 'unknown';
      if (!requestsByUser[u]) requestsByUser[u] = [];
      requestsByUser[u].push(sanitizeRequest(r));
    }

    // If filtering to one user, return detailed view
    if (userFilter) {
      const requests = (requestsByUser[userFilter] || [])
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      return respond(200, {
        user: userFilter,
        riskScore: scoresByUser[userFilter] || null,
        requests,
        totalRequests: requests.length
      });
    }

    // Full dashboard: one summary entry per user, sorted by risk score desc
    const users = Object.keys(requestsByUser).map(username => {
      const reqs = requestsByUser[username];
      const score = scoresByUser[username] || null;
      const approved = reqs.filter(r => ['approved', 'expired'].includes(r.status));
      const denied = reqs.filter(r => r.status === 'denied');
      const networkRevocations = reqs.filter(r => r.revokedByNetworkLoss);
      const lastRequest = reqs.sort((a, b) =>
        (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
      return {
        username,
        riskScore: score,
        totalRequests: reqs.length,
        approvedCount: approved.length,
        deniedCount: denied.length,
        networkRevocations: networkRevocations.length,
        lastRequestAt: lastRequest?.createdAt || null,
        lastRequestHostname: lastRequest?.deviceHostname || null
      };
    });

    // Sort by risk score desc (unscored users last), then by request count desc
    users.sort((a, b) => {
      const sa = a.riskScore?.score ?? -1;
      const sb = b.riskScore?.score ?? -1;
      if (sb !== sa) return sb - sa;
      return b.totalRequests - a.totalRequests;
    });

    return respond(200, {
      users,
      totalUsers: users.length,
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('getRiskDashboard error:', err);
    return respond(500, { error: 'Internal server error' });
  }
};

// Strip fields that should not leave the API (raw sudo log content, Slack IDs)
function sanitizeRequest(r) {
  return {
    requestId: r.requestId,
    createdAt: r.createdAt,
    status: r.status,
    deviceHostname: r.deviceHostname,
    deviceSerial: r.deviceSerial,
    reason: r.reason,
    reasonCategory: r.reasonCategory,
    requestedDuration: r.requestedDuration,
    approvedDuration: r.approvedDuration,
    approvedAt: r.approvedAt,
    expiredAt: r.expiredAt,
    revokedEarly: r.revokedEarly || false,
    revokedByNetworkLoss: r.revokedByNetworkLoss || false,
    lockedByIT: r.lockedByIT || false
  };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': process.env.DASHBOARD_CORS_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'x-api-key,content-type'
    },
    body: JSON.stringify(body)
  };
}
