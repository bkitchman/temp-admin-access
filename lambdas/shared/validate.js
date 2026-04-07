// Shared input validation helpers

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

function isValidUUID(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isValidEmail(value) {
  return typeof value === 'string' && EMAIL_RE.test(value);
}

module.exports = { isValidUUID, isValidEmail };
