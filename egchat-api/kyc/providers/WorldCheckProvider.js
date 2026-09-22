const HttpJsonProvider = require('./HttpJsonProvider');

class WorldCheckProvider extends HttpJsonProvider {
  constructor(options = {}) {
    super('world_check', {
      baseUrl: options.baseUrl || process.env.WORLD_CHECK_API_URL,
      apiKey: options.apiKey || process.env.WORLD_CHECK_API_KEY,
      timeoutMs: Number(process.env.KYC_SCREENING_TIMEOUT || 15) * 1000,
    });
  }

  async screenSanctions({ fullName, nationality }) {
    const data = await this.post('/screening/cases', { name: fullName, country: nationality });
    const matches = data.matches || data.results || [];
    return {
      provider: this.name,
      sanctionsHit: matches.some((m) => String(m.category || '').toLowerCase().includes('sanction')),
      pepHit: matches.some((m) => String(m.category || '').toLowerCase().includes('pep')),
      riskSignals: matches.map((m) => m.category).filter(Boolean),
      matches,
    };
  }
}

module.exports = WorldCheckProvider;
