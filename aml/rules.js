const DEFAULT_RULES = [
  {
    id: 'HIGH_VALUE_TRANSFER',
    severity: 'high',
    description: 'Transferencia igual o superior a 1.000.000 XAF',
    evaluate: (tx) => Number(tx.amount || 0) >= 1_000_000,
  },
  {
    id: 'RAPID_SUCCESSIVE_TRANSFERS',
    severity: 'medium',
    description: 'Múltiples transferencias en ventana corta',
    evaluate: (tx, ctx = {}) => Number(ctx.transfersLastHour || 0) >= 5,
  },
  {
    id: 'HIGH_RISK_KYC',
    severity: 'high',
    description: 'Cliente con KYC de alto riesgo',
    evaluate: (_tx, ctx = {}) => String(ctx.riskLevel || '').toLowerCase() === 'high',
  },
  {
    id: 'SANCTIONS_OR_PEP_HIT',
    severity: 'critical',
    description: 'Coincidencia sanciones o PEP',
    evaluate: (_tx, ctx = {}) => Boolean(ctx.sanctionsHit || ctx.pepHit),
  },
  {
    id: 'STRUCTURING_PATTERN',
    severity: 'medium',
    description: 'Importes repetidos próximos al umbral de revisión',
    evaluate: (tx, ctx = {}) => Number(tx.amount || 0) >= 900_000 && Number(ctx.similarTransfers24h || 0) >= 3,
  },
];

function evaluateAmlRules(transaction, context = {}, rules = DEFAULT_RULES) {
  return rules
    .filter((rule) => {
      try { return rule.evaluate(transaction || {}, context || {}); } catch { return false; }
    })
    .map(({ id, severity, description }) => ({ id, severity, description }));
}

module.exports = { DEFAULT_RULES, evaluateAmlRules };
