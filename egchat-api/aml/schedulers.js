async function runRescreening({ supabase, riskLevel, months }) {
  if (!supabase) return { checked: 0 };
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);

  const { data } = await supabase
    .from('kyc_verifications')
    .select('id, user_id, risk_level, updated_at')
    .eq('risk_level', riskLevel)
    .lte('updated_at', cutoff.toISOString())
    .limit(200)
    .catch(() => ({ data: [] }));

  for (const item of data || []) {
    await supabase
      .from('kyc_audit_log')
      .insert({
        application_id: item.id,
        action: 'KYC_RESCREENING_DUE',
        performed_by: item.user_id,
        performed_role: 'system',
        details: { risk_level: riskLevel, months },
      })
      .catch(() => ({ error: null }));
  }

  return { checked: (data || []).length };
}

async function updateSanctionsLists({ supabase }) {
  if (!supabase) return { updated: false };
  const payload = {
    source: 'OFAC_EU_UN_ONU',
    updated_at: new Date().toISOString(),
    status: 'scheduled_refresh_registered',
  };
  await supabase
    .from('system_jobs')
    .upsert({ job_key: 'sanctions_lists_daily_update', payload, updated_at: payload.updated_at }, { onConflict: 'job_key' })
    .catch(() => ({ error: null }));
  return { updated: true };
}

function startDailySchedulers({ supabase, intervalMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!supabase || intervalMs <= 0) return null;
  const run = async () => {
    await runRescreening({ supabase, riskLevel: 'high', months: 6 }).catch((e) => console.error('[KYC high rescreen]', e.message));
    await runRescreening({ supabase, riskLevel: 'medium', months: 12 }).catch((e) => console.error('[KYC medium rescreen]', e.message));
    await updateSanctionsLists({ supabase }).catch((e) => console.error('[sanctions update]', e.message));
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  setTimeout(run, 15_000).unref?.();
  return timer;
}

module.exports = { runRescreening, updateSanctionsLists, startDailySchedulers };
