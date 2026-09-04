#!/bin/bash
# Script para esperar a que Render actualice automáticamente
# Monitorea cada 15 segundos por 5 minutos

echo "🚀 Monitoreando deploy de Render..."
echo "   Esperando que el backend activo responda con las rutas nuevas"
echo ""

for i in {1..20}; do
  echo "⏳ Intento $i/20 ($(($i * 15))s)..."
  
  VERSION=$(curl -s https://egchat-api-xlxj.onrender.com/ | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
  
  echo "   Versión actual: $VERSION"
  
  if [[ "$VERSION" == *"2.6.3"* ]]; then
    echo ""
    echo "✅ ¡DEPLOY EXITOSO!"
    echo "   Render actualizó a: $VERSION"
    echo ""
    echo "🔍 Verificando endpoints..."
    node - << 'EOF'
const https = require('https');
const KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZxZnh0am5maHZwZ2dzc2J5bWRuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTg0MzgyMCwiZXhwIjoyMTAxNDE5ODIwfQ.ulwcC4WW-00pgjKzzs9CclyMGad1y4dqjS7P-c2O-CM';
function req(m,p){return new Promise(r=>{const d='{}';const rq=https.request({hostname:'egchat-api-xlxj.onrender.com',path:p,method:m,headers:{'Authorization':`Bearer ${KEY}`,'Content-Type':'application/json','Content-Length':d.length}},res=>{res.on('data',()=>{});res.on('end',()=>r(res.statusCode))});rq.on('error',()=>r(0));rq.write(d);rq.end();});}
(async()=>{
  const routes=[['GET','/api/djangue'],['POST','/api/djangue/x/advance-turn'],['PATCH','/api/chats/x/settings']];
  let ok=0;
  for(const [m,p] of routes){const s=await req(m,p);if(s!==404&&s!==0)ok++;}
  console.log(`${ok}/${routes.length} endpoints críticos funcionando`);
  if(ok===routes.length) console.log('🎉 TODO RESUELTO - Puedes continuar trabajando');
})();
EOF
    exit 0
  fi
  
  if [ $i -lt 20 ]; then
    sleep 15
  fi
done

echo ""
echo "⏱️  Timeout después de 5 minutos."
echo "   Render aún no actualizó (sigue en: $VERSION)"
echo ""
echo "🔧 ACCIÓN REQUERIDA:"
echo "   1. Ve a https://dashboard.render.com/"
echo "   2. Selecciona 'egchat-api-xlxj'"
echo "   3. Click en 'Manual Deploy' → 'Clear build cache & deploy'"
echo ""
echo "   O lee: ACCION_REQUERIDA.md para más opciones"
