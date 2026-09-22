function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function calculateRiskScore({ personal = {}, document = {}, biometric = {}, screening = [] } = {}) {
  let score = 20;
  const reasons = [];

  const ocrConfidence = Number(document.ocr_confidence ?? document.ocrConfidence ?? 0);
  if (ocrConfidence && ocrConfidence < 0.75) {
    score += 20;
    reasons.push('OCR_LOW_CONFIDENCE');
  }

  const faceMatchScore = Number(biometric.face_match_score ?? document.face_match_score ?? 0);
  if (faceMatchScore && faceMatchScore < 0.8) {
    score += 25;
    reasons.push('FACE_MATCH_LOW');
  }

  const livenessPassed = biometric.liveness_passed ?? document.liveness_passed;
  if (livenessPassed === false) {
    score += 35;
    reasons.push('LIVENESS_FAILED');
  }

  const sourceOfFunds = String(personal.source_of_funds || '').toUpperCase();
  if (sourceOfFunds.includes('CRYPTO') || sourceOfFunds.includes('OTHER')) {
    score += 8;
    reasons.push('SOURCE_OF_FUNDS_REVIEW');
  }

  const hasScreeningHit = (screening || []).some((item) => item.match_found || item.sanctionsHit || item.pepHit);
  if (hasScreeningHit) {
    score += 60;
    reasons.push('SCREENING_HIT');
  }

  score = clamp(score);
  const riskLevel = score >= 75 ? 'high' : score >= 40 ? 'medium' : 'low';
  const decision = score >= 85 ? 'REJECTED' : score >= 40 ? 'MANUAL_REVIEW' : 'AUTO_APPROVED';

  return { score, riskLevel, decision, reasons };
}

module.exports = { calculateRiskScore };
