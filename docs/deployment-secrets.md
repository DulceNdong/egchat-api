# EGCHAT deployment secrets

Configurar en GitHub Actions > Settings > Secrets and variables > Actions:

- `RENDER_DEPLOY_HOOK_URL`: Deploy Hook del servicio Render `egchat-api`.
- `SUPABASE_URL`: URL HTTPS del proyecto Supabase, no `postgres://`.
- `SUPABASE_SERVICE_KEY`: service_role key de Supabase.
- `JWT_SECRET`: secreto de firma JWT de producción.
- `DATABASE_URL`: conexión PostgreSQL para backups/restores.

Configurar en Render > egchat-api > Environment:

- `SUPABASE_URL=https://fqfxtjnfhvpggssbymdn.supabase.co`
- `SUPABASE_SERVICE_KEY=<service_role>`
- `JWT_SECRET=<valor largo y único>`
- `KYC_PROVIDER=mock` hasta activar proveedores reales.
- `KYC_DOCUMENT_PROVIDERS=smile_id,sumsub,mock`
- `KYC_BIOMETRIC_PROVIDERS=smile_id,sumsub,mock`
- `KYC_SCREENING_PROVIDERS=comply_advantage,world_check,sumsub,mock`
- `SENTRY_DSN=<opcional>`

UptimeRobot:

- Monitor HTTP(s): `https://egchat-api-xlxj.onrender.com/health`
- Intervalo: 5 minutos.
- Alertar si status no es 2xx o respuesta contiene `"status":"degraded"`.
