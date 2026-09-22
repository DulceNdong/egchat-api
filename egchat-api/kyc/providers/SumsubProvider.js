const HttpJsonProvider = require('./HttpJsonProvider');

class SumsubProvider extends HttpJsonProvider {
  constructor(options = {}) {
    super('sumsub', {
      baseUrl: options.baseUrl || process.env.SUMSUB_API_URL,
      apiKey: options.apiKey || process.env.SUMSUB_API_KEY,
      timeoutMs: Number(process.env.KYC_BIOMETRY_TIMEOUT || 15) * 1000,
    });
  }

  async ocrDocument(payload) {
    const data = await this.post('/resources/applicants/ocr', payload);
    return { provider: this.name, documentType: payload.documentType, side: payload.side, imageUrl: payload.imageUrl, confidence: Number(data.confidence ?? 0), extracted: data.extracted || {}, raw: data };
  }

  async faceMatch(payload) {
    const data = await this.post('/resources/applicants/face-match', payload);
    return { provider: this.name, faceMatchScore: Number(data.score ?? 0), passed: Boolean(data.passed) };
  }

  async liveness(payload) {
    const data = await this.post('/resources/applicants/liveness', payload);
    return { provider: this.name, livenessScore: Number(data.score ?? 0), passed: Boolean(data.passed) };
  }

  async screenSanctions(payload) {
    const data = await this.post('/resources/applicants/screening', payload);
    return { provider: this.name, sanctionsHit: Boolean(data.sanctionsHit), pepHit: Boolean(data.pepHit), riskSignals: data.riskSignals || [], matches: data.matches || [] };
  }
}

module.exports = SumsubProvider;
