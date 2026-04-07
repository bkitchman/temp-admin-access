// Compute an AI-powered security risk score for a user based on their admin access history.
// Invoked asynchronously from handleRequest after a new request is persisted.
// Writes the result to the admin-access-risk-scores DynamoDB table.
const dynamo = require('../shared/dynamo');
const bedrock = require('../shared/bedrock');

const RISK_SCORE_TTL_SECONDS = 48 * 60 * 60; // cache for 48 hours

exports.handler = async (event) => {
  const { username } = event;
  if (!username) {
    console.error('computeRiskScore: missing username in event payload');
    return;
  }

  try {
    console.log(`computeRiskScore: evaluating risk for user "${username}"`);
    const requests = await dynamo.scanRequestsByUser(username);
    const score = await evaluateRisk(username, requests);

    const now = new Date().toISOString();
    await dynamo.putRiskScore({
      username,
      score: score.score,
      level: score.level,
      keyFactors: score.keyFactors,
      summary: score.summary,
      requestCount: requests.length,
      lastEvaluatedAt: now,
      ttl: Math.floor(Date.now() / 1000) + RISK_SCORE_TTL_SECONDS
    });

    console.log(`computeRiskScore: stored score ${score.score} (${score.level}) for "${username}"`);
  } catch (err) {
    console.error(`computeRiskScore: failed for "${username}":`, err.message);
    // Non-fatal — risk scoring is best-effort, do not propagate errors
  }
};

async function evaluateRisk(username, requests) {
  if (requests.length === 0) {
    return {
      score: 5,
      level: 'low',
      keyFactors: ['No prior admin access history'],
      summary: 'First-time requester with no prior history to evaluate.'
    };
  }

  const now = Date.now();
  const days7 = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const days30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Build a sanitized history summary for Claude (no raw sudo logs to limit tokens)
  const historySummary = requests
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 50) // cap at 50 most recent requests
    .map(r => ({
      date: r.createdAt,
      status: r.status,
      category: r.reasonCategory,
      duration: r.requestedDuration,
      approvedDuration: r.approvedDuration,
      reason: (r.reason || '').slice(0, 200),
      sudoCommandCount: countSudoCommands(r.logContent),
      hasPrivilegeEscalation: detectPrivilegeEscalation(r.logContent),
      revokedByNetworkLoss: r.revokedByNetworkLoss || false,
      revokedEarly: r.revokedEarly || false,
      denied: r.status === 'denied'
    }));

  const recent7 = requests.filter(r => (r.createdAt || '') >= days7).length;
  const recent30 = requests.filter(r => (r.createdAt || '') >= days30).length;

  const prompt = buildPrompt(username, historySummary, recent7, recent30);

  const result = await bedrock.invokeClaudeJson(prompt);

  // Validate and clamp the response
  const score = Math.min(100, Math.max(0, Math.round(Number(result.score) || 0)));
  const level = scoreToLevel(score);
  const keyFactors = Array.isArray(result.keyFactors)
    ? result.keyFactors.slice(0, 4).map(f => String(f).slice(0, 150))
    : [];
  const summary = String(result.summary || '').slice(0, 300);

  return { score, level, keyFactors, summary };
}

function buildPrompt(username, history, recent7, recent30) {
  return `You are a security analyst evaluating the risk level of a user's temporary admin access requests on managed macOS devices.

User: ${username}
Total requests in history: ${history.length}
Requests in last 7 days: ${recent7}
Requests in last 30 days: ${recent30}

Request history (most recent first):
${JSON.stringify(history, null, 2)}

Based on this history, evaluate the security risk of granting this user another temporary admin session.

Risk factors to consider:
- High request frequency (3+ per week = elevated, 2+ per day = high)
- Categories: "security" and "debug" carry higher inherent risk than "install" or "config"
- Privilege escalation in sudo history (sudo bash, sudo su, sudo -s, sudoedit /etc/sudoers)
- Network-loss revocations may indicate evasion attempts
- Requests consistently at maximum duration (30 min)
- Vague or low-quality justifications
- History of denied requests
- Unusual timing patterns (e.g., repeated late-night/weekend requests)

Respond ONLY with valid JSON — no markdown, no explanation, just the JSON object:
{
  "score": <integer 0-100>,
  "level": "<low|medium|high|critical>",
  "keyFactors": ["<factor 1>", "<factor 2>", "<factor 3>"],
  "summary": "<1-2 sentence summary>"
}

Score guide: 0-30 = low, 31-60 = medium, 61-80 = high, 81-100 = critical.`;
}

function scoreToLevel(score) {
  if (score <= 30) return 'low';
  if (score <= 60) return 'medium';
  if (score <= 80) return 'high';
  return 'critical';
}

function countSudoCommands(logContent) {
  if (!logContent) return 0;
  const matches = logContent.match(/COMMAND=/g);
  return matches ? matches.length : 0;
}

function detectPrivilegeEscalation(logContent) {
  if (!logContent) return false;
  const escalationPatterns = [
    /COMMAND=.*\bsudo\s+-s\b/i,
    /COMMAND=.*\bsudo\s+bash\b/i,
    /COMMAND=.*\bsudo\s+su\b/i,
    /COMMAND=.*\bsudoedit\s+\/etc\/sudoers/i,
    /COMMAND=.*\bchmod\s+[0-9]*\s+\/etc\/sudoers/i,
    /COMMAND=.*\bvisudo\b/i
  ];
  return escalationPatterns.some(p => p.test(logContent));
}
