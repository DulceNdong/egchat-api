function createRateLimit({ windowMs = 60_000, max = 100, keyGenerator } = {}) {
  const hits = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = keyGenerator ? keyGenerator(req) : (req.user?.id || req.ip || req.headers['x-forwarded-for'] || 'anonymous');
    const bucket = hits.get(key) || { count: 0, resetAt: now + windowMs };

    if (bucket.resetAt <= now) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }

    bucket.count += 1;
    hits.set(key, bucket);

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Demasiadas peticiones. Inténtalo más tarde.' });
    }

    next();
  };
}

const ipRateLimit = createRateLimit({ windowMs: 60_000, max: 100, keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown' });
const userRateLimit = createRateLimit({ windowMs: 60_000, max: 20, keyGenerator: (req) => req.user?.id || req.ip || 'anonymous' });

module.exports = { createRateLimit, ipRateLimit, userRateLimit };
