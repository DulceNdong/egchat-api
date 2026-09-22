const KYCProvider = require('./KYCProvider');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class MockProvider extends KYCProvider {
  constructor(options = {}) {
    super('mock');
    this.delayMs = options.delayMs ?? 800;
  }

  async ocrDocument({ documentType, imageUrl, side }) {
    await wait(this.delayMs);
    return {
      provider: this.name,
      documentType: documentType || 'UNKNOWN',
      side: side || 'front',
      imageUrl,
      confidence: 0.92,
      extracted: {
        full_name: null,
        document_number: null,
        nationality: 'GQ',
      },
      raw: { mock: true },
    };
  }

  async faceMatch() {
    await wait(this.delayMs);
    return {
      provider: this.name,
      faceMatchScore: 0.95,
      passed: true,
    };
  }

  async liveness() {
    await wait(this.delayMs);
    return {
      provider: this.name,
      livenessScore: 0.95,
      passed: true,
    };
  }

  async screenSanctions({ fullName, nationality }) {
    await wait(this.delayMs);
    return {
      provider: this.name,
      sanctionsHit: false,
      pepHit: false,
      riskSignals: [],
      matches: [],
      checkedName: fullName || null,
      nationality: nationality || null,
    };
  }
}

module.exports = MockProvider;
