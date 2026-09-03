# 🚀 Instrucciones para Deploy Manual en Render

## ⚠️ Situación Actual

- ✅ Código pusheado a GitHub
- 🎯 Usa el servicio correcto: `egchat-api-xlxj`

---

## 📋 Paso a Paso - Deploy Manual

### 1️⃣ Ir al Dashboard de Render

Abre tu navegador y ve a:
```
https://dashboard.render.com/
```

### 2️⃣ Seleccionar tu Servicio

1. Busca el servicio **`egchat-api-xlxj`** en la lista
2. Haz clic en el nombre del servicio para abrir su panel

### 3️⃣ Hacer Deploy Manual

En la página del servicio:

1. En la esquina superior derecha, busca el botón **"Manual Deploy"**
2. Selecciona **"Deploy latest commit"** 
3. Aparecerá un dropdown, selecciona la rama **`main`**
4. Haz clic en **"Deploy"**

### 4️⃣ Monitorear el Build

- Verás los logs del build en tiempo real
- Debe decir que el nuevo servicio está desplegando el commit correcto
- El build toma 2-5 minutos típicamente
- Cuando termine, dirá: `Build successful` y `Live ✓`

### 5️⃣ Verificar que Funcionó

Ejecuta en tu terminal:

```bash
cd /Users/raymonreddintone/Desktop/EGCHAT_NATIVA/server
node verify-deploy.js
```

Deberías ver:
```
✅ Todos los endpoints están disponibles!
   Versión en Render: 2.6.1
```

---

## 🔧 Habilitar Auto-Deploy (Opcional)

Para que Render haga deploy automático en futuros pushes:

### En el Dashboard de Render:

1. Ve a tu servicio **`egchat-api-xlxj`**
2. Click en **"Settings"** (menú izquierdo)
3. Busca la sección **"Build & Deploy"**
4. Asegúrate que esté **activado**:
   - ✅ **Auto-Deploy**: Yes
   - **Branch**: main

5. Guarda cambios si hiciste alguno

---

## 📊 Comandos Útiles

### Verificar versión actual en Render:
```bash
curl -s https://egchat-api-xlxj.onrender.com/ | grep version
```

### Verificar endpoints:
```bash
node verify-deploy.js
```

### Monitorear deploy en tiempo real:
```bash
node monitor-deploy.js
```

---

## ❓ Troubleshooting

### Si el deploy falla:

1. Revisa los logs en Render Dashboard → Events
2. Busca errores de npm install o node
3. Verifica que todas las variables de entorno estén configuradas:
   - `JWT_SECRET`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`

### Si sigue en versión vieja:

1. Verifica que el build dice "Live ✓"
2. Espera 30 segundos más (propagación de CDN)
3. Haz hard refresh: `Ctrl+Shift+R` (Windows) o `Cmd+Shift+R` (Mac)
4. Prueba con curl: `curl -s https://egchat-api-xlxj.onrender.com/`

---

## 🎯 Resultado Esperado

Después del deploy exitoso:

```
🌐 SERVIDOR RENDER
  ✅ GET /health → 200
  ✅ GET /api/stickers/catalog → 401
  ✅ GET /api/djangue → 401 (ahora existe!)
  ✅ GET /api/auth/sessions → 401
  ✅ POST /api/djangue/x/advance-turn → 401 (ahora existe!)
  ✅ POST /api/djangue/x/manual-payout → 401 (ahora existe!)
  ✅ PATCH /api/chats/x/settings → 401 (ahora existe!)
  ✅ POST /api/chats/x/invite-link → 401 (ahora existe!)

📊 RESULTADO: 14/14 ✅
```

*(401 es correcto porque requieren autenticación)*

---

**¿Necesitas ayuda?** Avísame qué ves en el dashboard de Render.
