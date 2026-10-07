# 🗄️ Migraciones Supabase — Orden de ejecución

## Instrucciones
1. Ir a [Supabase Dashboard](https://supabase.com/dashboard/project/fqfxtjnfhvpggssbymdn/sql)
2. Ejecutar los scripts en el **orden indicado** abajo
3. Cada script usa `IF NOT EXISTS` / `IF NOT EXISTS` por lo que es seguro re-ejecutar

---

## Orden de ejecución

### PASO 1 — Tablas base de nuevas features
**Archivo:** `../new_features_clean.sql`

Crea/actualiza:
- `message_reactions` — reacciones emoji a mensajes
- `message_receipts` — recibos de entrega/lectura (doble check)
- `moments` + `moment_likes` + `moment_comments` — estados/historias
- `channels` + `channel_followers` — canales de difusión
- `business_profiles` + `catalog_items` — perfiles de negocio
- `phone_verifications` — verificación de teléfono
- `sticker_packs` + `user_sticker_packs` + `user_custom_stickers` + `user_sticker_favorites`
- `mini_apps` + `user_mini_apps`
- `payment_transactions` — pasarela de pagos
- `user_sessions` — sesiones multi-dispositivo
- `taxi_rides` — MiTaxi
- `user_bills` — facturas personales
- ALTER TABLE `messages` → columnas `edited`, `edited_at`, `status`
- ALTER TABLE `users` → columnas `e2e_public_key`, `e2e_key_backup`, `e2e_backup_updated`

### PASO 2 — Sistema Djangue (caja de ahorro grupal)
**Archivo:** `../egchat-api/djangue.sql`

Crea:
- `djangue_groups` — grupos de ahorro
- `djangue_wallets` — monedero del grupo
- `djangue_members` — miembros y orden de turno
- `djangue_contributions` — cuotas pagadas
- `djangue_penalties` — moras
- `djangue_notifications` — notificaciones internas
- `djangue_payouts` — pagos al beneficiario de turno
- Funciones SQL: `calculate_turn_penalties`, `apply_turn_penalties`, `close_turn_with_penalties`, `get_admin_stats`, `get_global_djangue_stats`, `pay_penalty`
- Triggers: notificación al chat al pagar, al cerrar turno, al aplicar mora
- Vistas: `djangue_user_penalties`, `djangue_full_report`
- ALTER TABLE `groups` → columna `group_type`

### PASO 3 — Token VoIP para llamadas iOS
**Archivo:** `voip_push_tokens.sql`

Crea:
- `voip_push_tokens` — tokens PushKit de iOS para llamadas con app cerrada

---

## Notas importantes

- **`new_features_clean.sql`** tiene algunas tablas duplicadas (user_sessions, payment_transactions aparecen dos veces con esquemas ligeramente diferentes). La segunda definición es la correcta — usar `IF NOT EXISTS` las ignora si ya existen.
- **`djangue.sql`** requiere que la tabla `users` exista previamente (ya existe en producción).
- **`djangue.sql`** tiene una columna `payment_method` y `paid_at` en `djangue_penalties` que no están en el `CREATE TABLE` inicial — se añaden via ALTER. Si falla, ejecutar manualmente:
  ```sql
  ALTER TABLE djangue_penalties ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
  ALTER TABLE djangue_penalties ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'wallet';
  ```
- El INSERT de canales y stickers usa `ON CONFLICT DO NOTHING` — seguro ejecutar múltiples veces.

---

## Módulo Monetización (Dashboard Revenue)

### PASO 4 — Tablas base de monetización
**Archivo:** `010_monetizacion.sql`

Crea:
- `monetizacion_empresas` — empresas con cuota mensual + comisión 1.5%
- `monetizacion_taxistas` — taxistas con documentación y comisión 5%
- `monetizacion_taxista_viajes` — viajes con trigger de comisión
- `monetizacion_taxista_horas` — horas activas
- `monetizacion_barcos` + `monetizacion_billetes` — barcos con comisión 1%
- `monetizacion_wallet_movimientos` — comisión 0.5% monedero
- `monetizacion_resumen_mensual` — resumen por categoría y mes
- `perfiles_financieros_usuarios` + `perfiles_financieros_negocios` — scores financieros
- `historial_transacciones_usuarios` + `historial_transacciones_negocios`
- Vistas: `v_ingresos_mensuales`, `v_taxistas_documentacion`
- RLS policies para admin y usuarios
- Datos demo: 7 empresas, 4 barcos, resúmenes 6 meses

### PASO 5 — Tablas de revenue por servicios
**Archivo:** `011_servicios_revenue.sql`

Crea:
- `revenue_servicios` — catálogo de 49 servicios en 15 categorías
- `revenue_transacciones` — transacciones con trigger comisión 1.5%
- `revenue_resumen_diario` — resumen diario por categoría
- Vistas: `v_revenue_por_categoria`, `v_revenue_diario_30`, `v_top_servicios_mes`
- Datos demo: 180 días de histórico por cada categoría

### PASO 6 — Usuario admin del Portal Monetización
**Archivo:** `012_admin_monetizacion.sql`

Crea:
- Amplía constraint `entity` en `admin_users` para incluir `MONETIZACION`
- Inserta usuario admin:
  - **Email:** `admin.monetizacion@egchat.gq`
  - **Password:** `EGChat2026!$Admin`
  - **Rol:** `MONETIZACION_ADMIN`

**Dashboard:** http://localhost:5174 → 💰 Portal Monetización
