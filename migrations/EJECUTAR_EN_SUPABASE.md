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
