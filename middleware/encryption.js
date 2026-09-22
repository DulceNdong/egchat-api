const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = 5 * 60;

const getKey = () => {
  const raw = process.env.KYC_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || '';
  return crypto.createHash('sha256').update(raw).digest();
};

function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? null), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decryptJson(token) {
  const payload = Buffer.from(String(token || ''), 'base64url');
  if (payload.length < 29) throw new Error('Invalid encrypted payload');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function signUrl(path, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const expires = Math.floor(Date.now() / 1000) + Number(ttlSeconds || DEFAULT_TTL_SECONDS);
  const normalizedPath = String(path || '');
  const signature = crypto
    .createHmac('sha256', getKey())
    .update(`${normalizedPath}.${expires}`)
    .digest('base64url');
  const separator = normalizedPath.includes('?') ? '&' : '?';
  return `${normalizedPath}${separator}expires=${expires}&signature=${signature}`;
}

function verifySignedUrl(path, expires, signature) {
  const exp = Number(expires);
  if (!path || !exp || !signature) return false;
  if (Math.floor(Date.now() / 1000) > exp) return false;
  const expected = crypto
    .createHmac('sha256', getKey())
    .update(`${path}.${exp}`)
    .digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
}

module.exports = { encryptJson, decryptJson, signUrl, verifySignedUrl };
