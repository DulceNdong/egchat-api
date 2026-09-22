const MockProvider = require('./providers/MockProvider');
const SmileIdProvider = require('./providers/SmileIdProvider');
const SumsubProvider = require('./providers/SumsubProvider');
const ComplyAdvantageProvider = require('./providers/ComplyAdvantageProvider');
const WorldCheckProvider = require('./providers/WorldCheckProvider');

class KYCProviderFactory {
  constructor(config = {}) {
    this.primary = config.primary || process.env.KYC_PROVIDER || 'mock';
    this.logger = config.logger || console;
    this.providers = new Map([
      ['mock', new MockProvider({ delayMs: Number(process.env.KYC_MOCK_DELAY_MS || 0) })],
      ['smile_id', new SmileIdProvider()],
      ['sumsub', new SumsubProvider()],
      ['comply_advantage', new ComplyAdvantageProvider()],
      ['world_check', new WorldCheckProvider()],
    ]);
  }

  getProvider(name = this.primary) {
    return this.providers.get(name) || this.providers.get('mock');
  }

  getProviderOrder(operation) {
    const screeningOrder = process.env.KYC_SCREENING_PROVIDERS || 'comply_advantage,world_check,sumsub,mock';
    const documentOrder = process.env.KYC_DOCUMENT_PROVIDERS || 'smile_id,sumsub,mock';
    const biometricOrder = process.env.KYC_BIOMETRIC_PROVIDERS || 'smile_id,sumsub,mock';

    if (operation === 'screenSanctions') return screeningOrder.split(',').map((s) => s.trim()).filter(Boolean);
    if (operation === 'ocrDocument') return documentOrder.split(',').map((s) => s.trim()).filter(Boolean);
    if (operation === 'faceMatch' || operation === 'liveness') return biometricOrder.split(',').map((s) => s.trim()).filter(Boolean);
    return [this.primary, 'mock'];
  }

  logAttempt(event) {
    this.logger.info?.('[KYCProvider]', JSON.stringify(event));
  }

  async withFallback(operation, payload = {}) {
    const order = this.getProviderOrder(operation).filter((item, index, arr) => item && arr.indexOf(item) === index);
    let lastError;

    for (const providerName of order) {
      const provider = this.getProvider(providerName);
      const startedAt = Date.now();
      try {
        const result = await provider[operation](payload);
        this.logAttempt({
          operation,
          provider: provider.name,
          duration_ms: Date.now() - startedAt,
          success: true,
        });
        return {
          ...result,
          provider: provider.name,
          duration_ms: Date.now() - startedAt,
          success: true,
        };
      } catch (error) {
        this.logAttempt({
          operation,
          provider: provider.name,
          duration_ms: Date.now() - startedAt,
          success: false,
          error: error.message,
        });
        lastError = error;
      }
    }

    throw lastError || new Error(`Operación KYC no disponible: ${operation}`);
  }
}

module.exports = KYCProviderFactory;
