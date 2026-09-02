# Mi Djangue - Configuración de Notificaciones Automáticas

## Opciones de implementación

### Opción 1: Cron Job en el servidor (Render/VPS)

Si tu API está en Render.com o un VPS, puedes usar cron de Linux:

```bash
# Editar crontab
crontab -e

# Agregar esta línea para ejecutar diariamente a las 9:00 AM
0 9 * * * cd /path/to/egchat-api && node djangue-notifications.js >> /var/log/djangue-cron.log 2>&1
```

### Opción 2: GitHub Actions (Recomendado para Render)

Crear `.github/workflows/djangue-notifications.yml`:

```yaml
name: Djangue Daily Notifications

on:
  schedule:
    # Ejecutar todos los días a las 9:00 AM UTC (10:00 AM WAT - Guinea Ecuatorial)
    - cron: '0 9 * * *'
  workflow_dispatch: # Permitir ejecución manual

jobs:
  send-notifications:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Djangue Notifications
        run: |
          curl -X POST ${{ secrets.API_URL }}/api/djangue/cron/notifications \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

### Opción 3: Vercel Cron Jobs

Si usas Vercel, crear `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/djangue/cron/notifications",
      "schedule": "0 9 * * *"
    }
  ]
}
```

### Opción 4: Node-cron dentro de la API

Agregar a tu `server.js` o `index.js`:

```javascript
const cron = require('node-cron');
const { runDailyNotifications } = require('./djangue-notifications');

// Ejecutar todos los días a las 9:00 AM
cron.schedule('0 9 * * *', async () => {
  console.log('Running Djangue daily notifications...');
  try {
    await runDailyNotifications();
  } catch (error) {
    console.error('Error running daily notifications:', error);
  }
});

console.log('Djangue cron job scheduled');
```

Instalar dependencia:
```bash
npm install node-cron
```

## Endpoint API para el Cron

Agregar este endpoint a tu API para que pueda ser llamado por servicios externos:

```javascript
// routes/djangue.js
const { runDailyNotifications } = require('../djangue-notifications');

router.post('/cron/notifications', async (req, res) => {
  // Verificar secreto de autenticación
  const cronSecret = req.headers['authorization']?.replace('Bearer ', '');
  if (cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await runDailyNotifications();
    res.json({ success: true, message: 'Notifications sent' });
  } catch (error) {
    console.error('Error in cron endpoint:', error);
    res.status(500).json({ error: 'Failed to send notifications' });
  }
});
```

## Variables de Entorno

Agregar a `.env`:

```env
# Cron Job Secret (generar una key aleatoria)
CRON_SECRET=tu_secreto_aleatorio_aqui_123456

# Supabase (ya deberías tenerlas)
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=tu_service_role_key
```

## Testing

Ejecutar manualmente para probar:

```bash
# Desde la carpeta del API
node djangue-notifications.js
```

O hacer un POST al endpoint:

```bash
curl -X POST http://localhost:3000/api/djangue/cron/notifications \
  -H "Authorization: Bearer tu_secreto_aleatorio_aqui_123456"
```

## Monitoreo

### Logs de notificaciones

```sql
-- Ver notificaciones enviadas hoy
SELECT 
  dn.type,
  dn.title,
  u.full_name,
  dg.name as group_name,
  dn.sent_at
FROM djangue_notifications dn
JOIN users u ON u.id = dn.user_id
JOIN djangue_groups dg ON dg.id = dn.group_id
WHERE DATE(dn.sent_at) = CURRENT_DATE
ORDER BY dn.sent_at DESC;
```

### Dashboard de monitoreo

Crear un endpoint simple:

```javascript
router.get('/notifications/stats', async (req, res) => {
  const { data, error } = await supabase
    .from('djangue_notifications')
    .select('type, sent_at')
    .gte('sent_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

  const stats = {
    last_7_days: data?.length || 0,
    by_type: {}
  };

  data?.forEach(n => {
    stats.by_type[n.type] = (stats.by_type[n.type] || 0) + 1;
  });

  res.json(stats);
});
```

## Recomendación Final

Para producción en Render, usar **Opción 2 (GitHub Actions)** porque:
- ✅ Gratis
- ✅ Confiable
- ✅ Fácil de monitorear
- ✅ No requiere servidor adicional
- ✅ Logs en GitHub
