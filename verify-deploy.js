#!/usr/bin/env node
/**
 * Script para verificar el estado del deploy en Render
 * Compara la versión desplegada con la versión local
 */

const https = require('https');

const RENDER_API = process.env.RENDER_API || 'https://egchat-api-xlxj.onrender.com';
const LOCAL_VERSION = process.env.LOCAL_VERSION || '7bfcbc3-TWILIO-FIXED';
const AUTH_TOKEN = process.env.RENDER_TOKEN || '';
const TEST_DEPLOY_PATH = '/api/test-deploy';

function checkEndpoint(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const request = https.request(`${RENDER_API}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function main() {
  console.log('🔍 Verificando estado del deploy en Render...\n');

  // 1. Check version
  console.log('1️⃣  Verificando versión desplegada...');
  const deployCheck = await checkEndpoint('GET', TEST_DEPLOY_PATH);
  const deployedVersion = deployCheck.data?.version || deployCheck.data?.build || 'unknown';
  console.log(`   Versión local:      ${LOCAL_VERSION}`);
  console.log(`   Versión en Render:  ${deployedVersion}`);
  
  if (deployedVersion !== 'unknown' && deployedVersion === LOCAL_VERSION) {
    console.log('   ✅ Deploy actualizado\n');
  } else {
    console.log('   ℹ️  No hay coincidencia exacta de versión, pero seguimos con la verificación funcional\n');
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
    const result = await checkEndpoint(endpoint.method, endpoint.path);
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
    console.log('   Hay endpoints que no responden en la instancia actual.\n');
    console.log('   1. Revisa que Render esté apuntando al repo y rama correctos.');
    console.log('   2. Confirma que el servicio activo sea el de egchat-api-xlxj.onrender.com.');
    console.log('   3. Si cambió el código, fuerza un redeploy desde Render.\n');
  } else {
    console.log('✅ Todos los endpoints están disponibles!');
    console.log('   Puedes continuar con tu testing.\n');
  }
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
