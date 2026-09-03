#!/usr/bin/env node
/**
 * Monitorea el deploy en Render cada 10 segundos
 * Se detiene cuando detecta la nueva versión o después de 5 minutos
 */

const https = require('https');

const RENDER_API = 'https://egchat-api.onrender.com';
const TARGET_VERSION = '2.6.2';
const CHECK_INTERVAL = 10000; // 10 segundos
const MAX_CHECKS = 30; // 5 minutos máximo

let checkCount = 0;

function getVersion() {
  return new Promise((resolve, reject) => {
    https.get(`${RENDER_API}/`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.version || 'unknown');
        } catch {
          resolve('error');
        }
      });
    }).on('error', () => resolve('error'));
  });
}

async function monitor() {
  checkCount++;
  const elapsed = Math.floor((checkCount * CHECK_INTERVAL) / 1000);
  
  process.stdout.write(`\r⏳ Verificando... [${elapsed}s] `);
  
  const version = await getVersion();
  
  if (version === TARGET_VERSION) {
    console.log(`\n\n✅ ¡DEPLOY COMPLETADO!`);
    console.log(`   Versión actualizada: ${version}`);
    console.log(`   Tiempo total: ${elapsed} segundos\n`);
    console.log('🎯 Ahora puedes ejecutar tu test de endpoints.');
    process.exit(0);
  } else if (version === 'error') {
    process.stdout.write(`(servidor caído - probablemente redeployando) `);
  } else {
    process.stdout.write(`(v${version}) `);
  }
  
  if (checkCount >= MAX_CHECKS) {
    console.log(`\n\n⚠️  Timeout después de ${elapsed} segundos.`);
    console.log(`   Versión actual: ${version}`);
    console.log(`   Versión esperada: ${TARGET_VERSION}\n`);
    console.log('Posibles causas:');
    console.log('  • Render está en cola (free tier puede tardar)');
    console.log('  • Error en el build (revisar logs en dashboard)');
    console.log('  • Auto-deploy no está habilitado\n');
    console.log('👉 Revisa: https://dashboard.render.com/');
    process.exit(1);
  }
  
  setTimeout(monitor, CHECK_INTERVAL);
}

console.log('🚀 Monitoreando deploy en Render...');
console.log(`   Target: v${TARGET_VERSION}`);
console.log(`   URL: ${RENDER_API}\n`);

monitor();
