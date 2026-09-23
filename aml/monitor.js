const { evaluateAmlRules } = require('./rules');

async function runAmlScan({ supabase, limit = 100 } = {}) {
  if (!supabase) return { scanned: 0, alerts: 0 };

  const { data: transactions } = await supabase
    .from('transactions')
    .select('*')
    .eq('aml_reviewed', false)
    .order('created_at', { ascending: false })
    .limit(limit)
    .catch(() => ({ data: [] }));

  let alerts = 0;
  for (const tx of transactions || []) {
    const matches = evaluateAmlRules(tx, tx.aml_context || {});
    if (!matches.length) continue;

    alerts += matches.length;
    await supabase
      .from('aml_alerts')
      .insert(matches.map((match) => ({
        transaction_id: tx.id,
        user_id: tx.user_id,
        rule_id: match.id,
        severity: match.severity,
        description: match.description,
        status: 'pending',
      })))
      .catch(() => ({ error: null }));
  }

  return { scanned: (transactions || []).length, alerts };
}

function startAmlMonitor({ supabase, intervalMs = 60 * 60 * 1000 } = {}) {
  if (!supabase || intervalMs <= 0) return null;
  const timer = setInterval(() => {
    runAmlScan({ supabase }).catch((error) => console.error('[AML monitor]', error.message));
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { runAmlScan, startAmlMonitor };
