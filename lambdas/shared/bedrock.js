// Amazon Bedrock helper — invoke Claude via the Bedrock runtime
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

// Send a user prompt to Claude via Bedrock and return the parsed JSON response.
// The prompt must instruct Claude to respond with raw JSON only.
async function invokeClaudeJson(prompt, maxTokens = 1024) {
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body)
  });

  const BEDROCK_TIMEOUT_MS = 45000;
  const response = await Promise.race([
    client.send(command),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Bedrock invocation timed out after 45s')), BEDROCK_TIMEOUT_MS)
    )
  ]);
  const responseText = new TextDecoder().decode(response.body);
  const parsed = JSON.parse(responseText);
  const text = parsed.content?.[0]?.text || '';

  // Strip markdown code fences if Claude wrapped its JSON response
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { invokeClaudeJson };
