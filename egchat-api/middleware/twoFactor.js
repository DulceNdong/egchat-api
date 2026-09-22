const crypto = require('crypto');

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function toBase32(buffer) {
  let bits = '';
  let output = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) {
    output += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return output;
}

function fromBase32(secret) {
  const clean = String(secret || '').replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = '';
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value >= 0) bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function generateSecret(bytes = 20) {
  return toBase32(crypto.randomBytes(bytes));
}

function getTotpCode(secret, step = Math.floor(Date.now() / 30000)) {
  const key = fromBase32(secret);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  msg.writeUInt32BE(step & 0xffffffff, 4);
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 1000000).padStart(6, '0');
}

function verifyTotp(secret, code, window = 1) {
  const normalized = String(code || '').replace(/\s+/g, '');
  const currentStep = Math.floor(Date.now() / 30000);
  for (let offset = -window; offset <= window; offset++) {
    if (getTotpCode(secret, currentStep + offset) === normalized) return true;
  }
  return false;
}

function otpauthUrl({ issuer = 'EGCHAT', label = 'admin', secret }) {
  const safeIssuer = encodeURIComponent(issuer);
  const safeLabel = encodeURIComponent(label);
  return `otpauth://totp/${safeIssuer}:${safeLabel}?secret=${secret}&issuer=${safeIssuer}&digits=6&period=30`;
}

module.exports = { generateSecret, getTotpCode, verifyTotp, otpauthUrl };
