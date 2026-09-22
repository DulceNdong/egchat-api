const HttpJsonProvider = require('./HttpJsonProvider');

class ComplyAdvantageProvider extends HttpJsonProvider {
  constructor(options = {}) {
    super('comply_advantage', {
      baseUrl: options.baseUrl || process.env.COMPLY_ADVANTAGE_API_URL,
      apiKey: options.apiKey || process.env.COMPLY_ADVANTAGE_API_KEY,
      timeoutMs: Number(process.env.KYC_SCREENING_TIMEOUT || 15) * 1000,
    });
  }

  async screenSanctions({ fullName, nationality }) {
    const data = await this.post('/searches', { search_term: fullName, filters: { country_codes: nationality ? [nationality] : undefined } });
    const matches = data.matches || data.results || [];
    return {
      provider: this.name,
      sanctionsHit: matches.some((m) => String(m.match_types || m.types || '').toLowerCase().includes('sanction')),
      pepHit: matches.some((m) => String(m.match_types || m.types || '').toLowerCase().includes('pep')),
      riskSignals: matches.map((m) => m.match_types || m.types).filter(Boolean),
      matches,
    };
  }
}

module.exports = ComplyAdvantageProvider;
