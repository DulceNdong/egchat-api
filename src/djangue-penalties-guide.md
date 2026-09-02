# Mi Djangue - Sistema de Moras Automáticas

## Flujo Completo de Moras

### 1. Durante el periodo activo
- Los integrantes cotizan normalmente
- El sistema envía recordatorios (10 días antes, últimos 5 días)
- Los integrantes pueden justificar ausencias

### 2. Al cierre del periodo (automático)

Cuando `period_end_date` llega:

1. **Se ejecuta `checkAutoCloseTurns()` (diariamente a las 23:00 UTC)**
2. **Se identifica al beneficiario del turno actual**
3. **Se calcula el monto total a pagar** (suma de contribuciones)
4. **Se aplican moras automáticamente:**
   - SQL función `calculate_turn_penalties()` identifica morosos
   - Se excluyen: beneficiario, pagados, justificados
   - Se calcula: `mora = cuota × penalty_percent / 100`
5. **Se registran las moras** en tabla `djangue_penalties`
6. **Se envía mensaje al chat grupal** por cada mora aplicada
7. **Se transfiere el monto al beneficiario** (su wallet)
8. **Se avanza al siguiente turno**
9. **Se notifica a todos** (beneficiario + morosos)

## Funciones SQL Disponibles

### `calculate_turn_penalties(group_id, turn_number)`
Calcula moras **sin aplicarlas**. Útil para preview.

```sql
SELECT * FROM calculate_turn_penalties(
  '123e4567-e89b-12d3-a456-426614174000',
  5
);
```

Retorna:
```
user_id | penalty_amount | reason
--------|----------------|--------
abc...  | 5000          | Mora del 5% por no cotizar en el turno 5
def...  | 5000          | Mora del 5% por no cotizar en el turno 5
```

### `apply_turn_penalties(group_id, turn_number)`
Aplica moras y las registra en la BD.

```sql
SELECT apply_turn_penalties(
  '123e4567-e89b-12d3-a456-426614174000',
  5
);
```

Retorna JSON:
```json
{
  "success": true,
  "penalties_applied": 2,
  "total_amount": 10000,
  "currency": "XAF",
  "turn_number": 5
}
```

### `close_turn_with_penalties(group_id, turn_number, beneficiary_id, payout_amount)`
Cierra el turno completo: paga al beneficiario + aplica moras + avanza turno.

```sql
SELECT close_turn_with_penalties(
  '123e4567-e89b-12d3-a456-426614174000',
  5,
  'user-uuid-here',
  95000
);
```

### `get_user_penalty_summary(user_id)`
Obtiene resumen de moras de un usuario.

```sql
SELECT get_user_penalty_summary('user-uuid-here');
```

Retorna:
```json
{
  "total_pending": 15000,
  "total_paid": 5000,
  "count_pending": 3,
  "penalties": [
    {
      "id": "...",
      "group_name": "San y San",
      "turn_number": 3,
      "amount": 5000,
      "currency": "XAF",
      "reason": "Mora del 5% por no cotizar...",
      "created_at": "2024-01-15T10:00:00Z"
    }
  ]
}
```

### `pay_penalty(penalty_id, payment_method)`
Marca una mora como pagada.

```sql
SELECT pay_penalty('penalty-uuid-here', 'wallet');
```

## API Endpoints

### POST `/api/djangue/:id/close-turn`
Cierra un turno manualmente (admin/secretario).

```javascript
POST /api/djangue/123e4567.../close-turn
Authorization: Bearer <token>

Response:
{
  "success": true,
  "payout": {
    "beneficiary": "Juan Pérez",
    "amount": 95000,
    "currency": "XAF"
  },
  "penalties": {
    "penalties_applied": 2,
    "total_amount": 10000,
    "currency": "XAF"
  },
  "next_turn": 6
}
```

### GET `/api/djangue/my-penalties`
Obtiene las moras del usuario actual.

```javascript
GET /api/djangue/my-penalties
Authorization: Bearer <token>

Response:
{
  "total_pending": 15000,
  "total_paid": 5000,
  "count_pending": 3,
  "penalties": [...]
}
```

### POST `/api/djangue/pay-penalty/:penaltyId`
Paga una mora usando el wallet.

```javascript
POST /api/djangue/pay-penalty/penalty-uuid-here
Authorization: Bearer <token>
Content-Type: application/json

{
  "payment_method": "wallet"
}

Response:
{
  "success": true,
  "penalty_id": "...",
  "amount_paid": 5000
}
```

## Cron Jobs

### Auto-close turns (23:00 UTC diariamente)

Archivo: `.github/workflows/djangue-auto-close-turns.yml`

```bash
# Ejecutar manualmente para testing:
node djangue-penalties.js

# O via API:
curl -X POST https://api.com/api/djangue/cron/auto-close-turns \
  -H "Authorization: Bearer SECRET"
```

## Estados de Moras

- **`pending`**: Mora aplicada, no pagada
- **`paid`**: Mora pagada
- **`waived`**: Mora condonada (admin puede implementar esto)

## Notificaciones Push

### Al aplicar mora:
```
Título: ⚠️ Mora aplicada - San y San
Mensaje: Se aplicó una mora de 5,000 XAF por no cotizar a tiempo en el turno 5
```

### Al pagar mora:
```
Título: ✅ Mora pagada
Mensaje: Pagaste tu mora de 5,000 XAF
```

### Mensaje al chat grupal:
```
⚠️ Mora aplicada a Juan Pérez: 5,000 XAF
```

## Reglas de Negocio

1. **No se aplica mora al beneficiario del turno**
2. **No se aplica mora si el miembro pagó**
3. **No se aplica mora si el miembro justificó su ausencia**
4. **La mora se calcula como:** `cuota × penalty_percent / 100`
5. **Las moras se acumulan** en `total_mora_collected` del grupo
6. **Las moras pendientes se muestran** en la vista del integrante
7. **Las moras se pueden pagar** desde el wallet del usuario

## Triggers Automáticos

### `trigger_notify_user_on_penalty`
Se ejecuta al insertar una mora. Crea notificación push.

### `trigger_notify_chat_on_payment` (existente)
Se ejecuta al pagar una contribución. Envía mensaje al chat.

## Vista de Consulta

### `djangue_user_penalties`
Vista que combina moras con info de usuario y grupo.

```sql
SELECT * FROM djangue_user_penalties
WHERE user_id = 'user-uuid-here'
ORDER BY created_at DESC;
```

## Testing

### 1. Simular cierre de turno

```sql
-- Paso 1: Crear un grupo de prueba
INSERT INTO djangue_groups (...) VALUES (...);

-- Paso 2: Agregar miembros
INSERT INTO djangue_members (...) VALUES (...);

-- Paso 3: Algunos pagan, otros no
INSERT INTO djangue_contributions (...) VALUES (...);

-- Paso 4: Cerrar el turno
SELECT close_turn_with_penalties(
  'group-id',
  1,
  'beneficiary-user-id',
  95000
);

-- Paso 5: Verificar moras aplicadas
SELECT * FROM djangue_penalties WHERE group_id = 'group-id';

-- Paso 6: Verificar que el grupo avanzó al turno 2
SELECT current_turn FROM djangue_groups WHERE id = 'group-id';
```

### 2. Testing de notificaciones

```bash
# Ejecutar el script de cierre automático
node djangue-penalties.js

# Revisar logs
tail -f /var/log/djangue-penalties.log
```

### 3. Testing de pagos de mora

```javascript
// En la app mobile
const result = await apiFetch('/api/djangue/pay-penalty/penalty-id', {
  method: 'POST',
  body: JSON.stringify({ payment_method: 'wallet' }),
});

console.log(result);
// { success: true, penalty_id: '...', amount_paid: 5000 }
```

## Monitoreo

### Dashboard SQL

```sql
-- Moras pendientes totales
SELECT 
  SUM(amount) as total_pending,
  COUNT(*) as count
FROM djangue_penalties 
WHERE status = 'pending';

-- Top 5 grupos con más moras
SELECT 
  dg.name,
  SUM(dp.amount) as total_penalties,
  COUNT(dp.id) as penalty_count
FROM djangue_penalties dp
JOIN djangue_groups dg ON dg.id = dp.group_id
WHERE dp.status = 'pending'
GROUP BY dg.name
ORDER BY total_penalties DESC
LIMIT 5;

-- Usuarios con más moras pendientes
SELECT 
  u.full_name,
  u.phone,
  SUM(dp.amount) as total_pending,
  COUNT(dp.id) as count
FROM djangue_penalties dp
JOIN users u ON u.id = dp.user_id
WHERE dp.status = 'pending'
GROUP BY u.full_name, u.phone
ORDER BY total_pending DESC
LIMIT 10;
```

## Integración con Wallet

Al cerrar un turno:
1. Se crea/actualiza el wallet del beneficiario
2. Se registra transacción en `wallet_transactions`
3. El beneficiario puede usar ese dinero para:
   - Transferir a su cuenta bancaria
   - Pagar moras propias
   - Cotizar en otros djangues
   - Hacer recargas, etc.

## Mejoras Futuras

- [ ] Condonación de moras por admin
- [ ] Mora progresiva (aumenta con el tiempo)
- [ ] Recordatorios de moras pendientes
- [ ] Plan de pagos para moras
- [ ] Dashboard de moras en admin
- [ ] Exportar reporte de moras (PDF/Excel)
