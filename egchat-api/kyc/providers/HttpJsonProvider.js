const KYCProvider = require('./KYCProvider');

class HttpJsonProvider extends KYCProvider {
  constructor(name, { baseUrl, apiKey, timeoutMs = 15000 } = {}) {
    super(name);
    this.baseUrl = baseUrl || '';
    this.apiKey = apiKey || '';
    this.timeoutMs = timeoutMs;
  }

  get enabled() {
    return Boolean(this.baseUrl && this.apiKey);
  }

  async post(path, payload) {
    if (!this.enabled) throw new Error(`${this.name} no configurado`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload || {}),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${this.name} HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = HttpJsonProvider;
