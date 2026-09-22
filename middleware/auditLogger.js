function createAuditLogger({ supabase, sensitivePaths = [/\/api\/kyc\//, /\/api\/admin\//, /\/api\/aml\//] } = {}) {
  return async (req, res, next) => {
    const shouldLog = sensitivePaths.some((pattern) => pattern.test(req.path));
    if (!shouldLog || !supabase) return next();

    const startedAt = Date.now();
    res.on('finish', () => {
      supabase
        .from('kyc_audit_log')
        .insert({
          application_id: req.params?.id || null,
          action: `${req.method} ${req.path}`,
          performed_by: req.user?.id || req.admin?.id || null,
          performed_role: req.admin?.role || req.userRole || 'system',
          details: {
            status_code: res.statusCode,
            duration_ms: Date.now() - startedAt,
            query: req.query || {},
          },
          ip_address: req.ip,
        })
        .catch(() => {});
    });

    next();
  };
}

module.exports = { createAuditLogger };
