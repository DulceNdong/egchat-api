const assert = require('assert');
const MockProvider = require('../providers/MockProvider');
const KYCProviderFactory = require('../KYCProviderFactory');
const { calculateRiskScore } = require('../KYCScoringEngine');

async function testMockProvider() {
  const provider = new MockProvider({ delayMs: 0 });
  const ocr = await provider.ocrDocument({ documentType: 'DNI', imageUrl: 'stored:test', side: 'front' });
  assert.equal(ocr.provider, 'mock');
  assert.equal(ocr.documentType, 'DNI');
  assert.ok(ocr.confidence > 0);

  const face = await provider.faceMatch({});
  assert.equal(face.passed, true);
  assert.ok(face.faceMatchScore >= 0.9);

  const live = await provider.liveness({});
  assert.equal(live.passed, true);
  assert.ok(live.livenessScore >= 0.9);

  const screening = await provider.screenSanctions({ fullName: 'Test User', nationality: 'GQ' });
  assert.equal(screening.sanctionsHit, false);
  assert.equal(screening.pepHit, false);
}

function testScoringEngine() {
  const approved = calculateRiskScore({});
  assert.equal(approved.decision, 'AUTO_APPROVED');
  assert.equal(approved.riskLevel, 'low');

  const review = calculateRiskScore({ document: { ocr_confidence: 0.7 } });
  assert.equal(review.decision, 'MANUAL_REVIEW');

  const rejected = calculateRiskScore({ screening: [{ match_found: true }], biometric: { liveness_passed: false }, document: { face_match_score: 0.5 } });
  assert.equal(rejected.decision, 'REJECTED');

  const sourceReview = calculateRiskScore({ personal: { source_of_funds: 'OTHER' } });
  assert.ok(sourceReview.score > approved.score);

  const sanctions = calculateRiskScore({ screening: [{ sanctionsHit: true }] });
  assert.equal(sanctions.decision, 'MANUAL_REVIEW');
}

async function testFactoryFallback() {
  process.env.KYC_DOCUMENT_PROVIDERS = 'smile_id,mock';
  process.env.KYC_SCREENING_PROVIDERS = 'comply_advantage,mock';
  const events = [];
  const factory = new KYCProviderFactory({ logger: { info: (...args) => events.push(args.join(' ')) } });

  const ocr = await factory.withFallback('ocrDocument', { documentType: 'PASSPORT', imageUrl: 'stored:test', side: 'front' });
  assert.equal(ocr.provider, 'mock');
  assert.equal(ocr.success, true);

  const screening = await factory.withFallback('screenSanctions', { fullName: 'Test User' });
  assert.equal(screening.provider, 'mock');
  assert.equal(screening.success, true);

  assert.ok(events.some((line) => line.includes('success":false')));
  assert.ok(events.some((line) => line.includes('success":true')));
}

(async () => {
  await testMockProvider();
  testScoringEngine();
  await testFactoryFallback();
  console.log('KYC tests OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
