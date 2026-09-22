const HttpJsonProvider = require('./HttpJsonProvider');

class SmileIdProvider extends HttpJsonProvider {
  constructor(options = {}) {
    super('smile_id', {
      baseUrl: options.baseUrl || process.env.SMILE_ID_API_URL,
      apiKey: options.apiKey || process.env.SMILE_ID_API_KEY,
      timeoutMs: Number(process.env.KYC_OCR_TIMEOUT || 15) * 1000,
    });
    this.partnerId = options.partnerId || process.env.SMILE_ID_PARTNER_ID;
  }

  async ocrDocument(payload) {
    const data = await this.post('/document/ocr', { ...payload, partner_id: this.partnerId });
    return {
      provider: this.name,
      documentType: payload.documentType,
      side: payload.side,
      imageUrl: payload.imageUrl,
      confidence: Number(data.confidence ?? data.ocr_confidence ?? 0),
      extracted: data.extracted || data.ocrData || {},
      raw: data,
    };
  }

  async faceMatch(payload) {
    const data = await this.post('/biometric/face-match', { ...payload, partner_id: this.partnerId });
    return { provider: this.name, faceMatchScore: Number(data.score ?? data.face_match_score ?? 0), passed: Boolean(data.passed ?? data.match) };
  }

  async liveness(payload) {
    const data = await this.post('/biometric/liveness', { ...payload, partner_id: this.partnerId });
    return { provider: this.name, livenessScore: Number(data.score ?? data.liveness_score ?? 0), passed: Boolean(data.passed) };
  }
}

module.exports = SmileIdProvider;
