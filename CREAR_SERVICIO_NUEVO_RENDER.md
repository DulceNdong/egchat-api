# 🆕 Crear Nuevo Servicio en Render (desde cero)

## Por qué hacer esto:
El servicio `egchat-api` actual está "trabado" en v2.5.5 y no toma cambios de GitHub.

## 📋 Pasos para crear servicio nuevo:

### 1️⃣ Ir a Render Dashboard
```
https://dashboard.render.com/
```

### 2️⃣ Crear nuevo Web Service

1. Click en **"New +"** (arriba derecha)
2. Selecciona **"Web Service"**

### 3️⃣ Conectar repositorio

1. **Connect repository**: Busca y selecciona `DulceNdong/egchat-api`
2. Si no aparece, click en **"Configure account"** y autoriza el repo

### 4️⃣ Configurar el servicio

Llena el formulario con estos datos:

**Name**: `egchat-api-v2` (o cualquier nombre único)

**Region**: `Oregon (US West)` (o el que prefieras)

**Branch**: `main` ✅

**Root Directory**: *(dejar vacío)*

**Runtime**: `Node`

**Build Command**: 
```bash
npm install --production
```

**Start Command**: 
```bash
node index.js
```

**Plan**: `Free` (o el que uses)

### 5️⃣ Variables de entorno (Environment Variables)

Click en **"Advanced"** y agrega estas variables:

```
NODE_ENV=production
PORT=10000
JWT_SECRET=(copia el valor del servicio viejo)
SUPABASE_URL=https://fqfxtjnfhvpggssbymdn.supabase.co
SUPABASE_SERVICE_KEY=(copia el valor del servicio viejo)
CORS_ALLOWED_ORIGINS=https://egchat-app.vercel.app,https://egchat-v2.vercel.app,http://localhost:3001,http://localhost:5173
```

**IMPORTANTE**: Para obtener los valores del servicio viejo:
1. Ve al servicio `egchat-api` actual
2. Click en **"Environment"** en el menú izquierdo
3. Copia los valores de `JWT_SECRET` y `SUPABASE_SERVICE_KEY`

### 6️⃣ Configurar Auto-Deploy

En la misma pantalla, busca:

- **Auto-Deploy**: ✅ **Yes**

### 7️⃣ Crear el servicio

1. Click en **"Create Web Service"**
2. Espera 3-5 minutos mientras hace el build
3. Cuando termine, verás **"Live ✓"** en verde

### 8️⃣ Obtener la nueva URL

La URL será algo como:
```
https://egchat-api-v2-xxxx.onrender.com
```

Cópiala y pruébala:

```bash
curl -s https://TU-NUEVA-URL.onrender.com/ | python3 -m json.tool
```

Deberías ver:
```json
{
  "message": "EGCHAT API funcionando!",
  "version": "2.6.2",
  "deploy_test": "RENDER_UPDATED_v2.6.2"
}
```

### 9️⃣ Actualizar tu app para usar la nueva URL

Una vez confirmado que funciona:

1. Actualiza todas las referencias de `egchat-api-xlxj.onrender.com` a la nueva URL
2. Actualiza variables de entorno en Vercel/donde uses la API
3. Puedes eliminar el servicio viejo después

---

## 🔧 Troubleshooting

### Si el build falla:

1. Revisa los logs en Render
2. Verifica que todas las variables de entorno estén bien
3. Confirma que el branch sea `main`

### Si sigue sin funcionar:

Avísame y revisamos la configuración juntos.

---

## ⚡ Opción más rápida - Usar render.yaml

Si prefieres, también puedes:

1. Click en **"New +"** → **"Blueprint"**
2. Selecciona el repo `DulceNdong/egchat-api`
3. Render detectará automáticamente `render.yaml` y lo configurará todo

Esto usa el archivo `render.yaml` que ya tienes en el repo.
