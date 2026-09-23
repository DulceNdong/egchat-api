const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const revokedTokens = new Map();
const refreshTokens = new Map();

function verifyAccessToken(token, secrets) {
  const secretList = Array.isArray(secrets) ? secrets : [secrets];
  for (const secret of secretList.filter(Boolean)) {
    try {
      const payload = jwt.verify(token, secret);
      if (payload.jti && revokedTokens.has(payload.jti)) throw new Error('Token revoked');
      return payload;
    } catch {}
  }
  throw new Error('Token inválido o expirado');
}

function issueTokenPair(payload, secret, { accessTtl = '30m', refreshTtlMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const jti = crypto.randomUUID();
  const refreshToken = crypto.randomBytes(32).toString('base64url');
  const accessToken = jwt.sign({ ...payload, jti }, secret, { expiresIn: accessTtl });
  refreshTokens.set(refreshToken, { payload, expiresAt: Date.now() + refreshTtlMs });
  return { accessToken, refreshToken, expiresIn: accessTtl };
}

function rotateRefreshToken(refreshToken, secret, options) {
  const entry = refreshTokens.get(refreshToken);
  refreshTokens.delete(refreshToken);
  if (!entry || entry.expiresAt <= Date.now()) throw new Error('Refresh token inválido');
  return issueTokenPair(entry.payload, secret, options);
}

function revokeToken(jti) {
  if (!jti) return;
  revokedTokens.set(jti, Date.now());
}

function createAuthMiddleware(secrets) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.replace(/^Bearer\s+/i, '').trim() || req.headers['x-auth-token'];
    if (!token) return res.status(401).json({ message: 'Token requerido' });
    try {
      req.user = verifyAccessToken(token, secrets);
      next();
    } catch {
      res.status(401).json({ message: 'Token inválido o expirado' });
    }
  };
}

module.exports = { createAuthMiddleware, verifyAccessToken, issueTokenPair, rotateRefreshToken, revokeToken };
