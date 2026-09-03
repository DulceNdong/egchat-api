#!/usr/bin/env node
/**
 * Script para verificar el estado del deploy en Render
 * Compara la versión desplegada con la versión local
 */

const https = require('https');

const RENDER_API = 'https://egchat-api.onrender.com';
const LOCAL_VERSION = '2.6.2'; // Versión esperada tras el push

function checkEndpoint(path) {
  return new Promise((resolve, reject) => {
    https.get(`${RENDER_API}${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('🔍 Verificando estado del deploy en Render...\n');

  // 1. Check version
  console.log('1️⃣  Verificando versión desplegada...');
  const rootCheck = await checkEndpoint('/');
  const deployedVersion = rootCheck.data?.version || 'unknown';
  console.log(`   Versión local:      ${LOCAL_VERSION}`);
  console.log(`   Versión en Render:  ${deployedVersion}`);
  
  if (deployedVersion === LOCAL_VERSION) {
    console.log('   ✅ Deploy actualizado\n');
  } else {
    console.log('   ⚠️  Deploy desactualizado - Render aún no actualizó\n');
  }

  // 2. Check missing endpoints
  console.log('2️⃣  Verificando endpoints críticos...\n');
  
  const endpoints = [
    { method: 'GET', path: '/api/djangue', description: 'Listar djangues' },
    { method: 'POST', path: '/api/djangue/test-id/advance-turn', description: 'Avanzar turno' },
    { method: 'POST', path: '/api/djangue/test-id/manual-payout', description: 'Pago manual' },
    { method: 'PATCH', path: '/api/chats/test-id/settings', description: 'Settings de chat' },
    { method: 'POST', path: '/api/chats/test-id/invite-link', description: 'Invite link' },
  ];

  let available = 0;
  let notFound = 0;

  for (const endpoint of endpoints) {
    const result = await checkEndpoint(endpoint.path);
    const status = result.status;
    
    // 401 = endpoint existe pero requiere auth (BUENO)
    // 404 = endpoint no existe (MALO)
    // 400 = endpoint existe pero falta data (ACEPTABLE)
    
    if (status === 404) {
      console.log(`   ❌ ${endpoint.method} ${endpoint.path}`);
      console.log(`      └─ 404 Not Found - Endpoint no existe\n`);
      notFound++;
    } else if (status === 401) {
      console.log(`   ✅ ${endpoint.method} ${endpoint.path}`);
      console.log(`      └─ 401 Unauthorized - Endpoint existe (requiere auth)\n`);
      available++;
    } else {
      console.log(`   ✅ ${endpoint.method} ${endpoint.path}`);
      console.log(`      └─ ${status} - Endpoint existe\n`);
      available++;
    }
  }

  console.log('═══════════════════════════════════════════════════════\n');
  console.log(`📊 RESULTADO: ${available}/${endpoints.length} endpoints disponibles\n`);

  if (notFound > 0) {
    console.log('⚠️  ACCIÓN REQUERIDA:');
    console.log('   Render no ha actualizado el código. Opciones:\n');
    console.log('   1. Esperar 2-5 minutos más (Render puede tardar)');
    console.log('   2. Ir a dashboard.render.com → egchat-api → Manual Deploy');
    console.log('   3. Ejecutar: git commit --allow-empty -m "force deploy" && git push\n');
  } else {
    console.log('✅ Todos los endpoints están disponibles!');
    console.log('   Puedes continuar con tu testing.\n');
  }
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
