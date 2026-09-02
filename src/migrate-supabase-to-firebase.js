#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════
// Script de migración: Supabase PostgreSQL → Firebase Firestore
// Uso: node migrate-supabase-to-firebase.js
// ══════════════════════════════════════════════════════════════════
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const admin = require('firebase-admin');

// ── Config Supabase ───────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fjtoxjcuyfapeprniink.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Config Firebase ───────────────────────────────────────────────
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./firebase-service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`,
  });
}

const db = admin.firestore();

// ── Helpers ───────────────────────────────────────────────────────
const log = (msg) => console.log(`[MIGRATOR] ${msg}`);
const error = (msg) => console.error(`[ERROR] ${msg}`);

// ── Migración por tabla ───────────────────────────────────────────
const TABLES_TO_MIGRATE = [
  'users', 'wallets', 'contacts', 'chats', 'chat_participants',
  'messages', 'message_deletions', 'message_reads',
  'transactions', 'recharge_codes', 'lia_conversations',
  'taxi_rides', 'cemac_transfers', 'service_orders',
  'expo_push_tokens',
];

async function migrateTable(tableName) {
  try {
    log(`📦 Migrando tabla: ${tableName}...`);
    const { data, error: fetchError, count } = await supabase
      .from(tableName)
      .select('*', { count: 'exact' });

    if (fetchError) {
      error(`No se pudo leer ${tableName}: ${fetchError.message}`);
      return { table: tableName, ok: false, migrated: 0 };
    }

    if (!data || data.length === 0) {
      log(`✅ ${tableName}: vacía (0 registros)`);
      return { table: tableName, ok: true, migrated: 0 };
    }

    log(`   └─ ${data.length} registros encontrados`);

    const batch = db.batch();
    let batchCount = 0;

    for (const row of data) {
      const docId = row.id || db.collection(tableName).doc().id;
      const docRef = db.collection(tableName).doc(String(docId));
      batch.set(docRef, row, { merge: true });
      batchCount++;

      // Firestore batch limit: 500
      if (batchCount >= 500) {
        await batch.commit();
        log(`   └─ Batch de 500 registros guardado`);
        batchCount = 0;
      }
    }

    if (batchCount > 0) await batch.commit();

    log(`✅ ${tableName}: ${data.length} registros migrados`);
    return { table: tableName, ok: true, migrated: data.length };
  } catch (e) {
    error(`Error migrando ${tableName}: ${e.message}`);
    return { table: tableName, ok: false, migrated: 0, error: e.message };
  }
}


// ── Migrar Storage (archivos de chat) ────────────────────────────
async function migrateStorage() {
  try {
    log('📂 Migrando Storage de Supabase → Firebase...');
    log('⚠️  NOTA: La migración de archivos debe hacerse manualmente con gsutil o Firebase Console.');
    log('   1. Exporta archivos de Supabase Storage bucket "chat-files"');
    log('   2. Importa a Firebase Storage bucket con: gsutil -m cp -r gs://supabase-bucket/* gs://firebase-bucket/');
    return { ok: true, message: 'Storage requiere migración manual' };
  } catch (e) {
    error(`Error en storage: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('🔄 MIGRACIÓN EGCHAT: Supabase → Firebase');
  console.log('══════════════════════════════════════════════════════════════════\n');

  const startTime = Date.now();
  const results = [];

  // Migrar tablas
  for (const table of TABLES_TO_MIGRATE) {
    const result = await migrateTable(table);
    results.push(result);
  }

  // Storage (manual)
  const storageResult = await migrateStorage();
  results.push(storageResult);

  // Resumen
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  const success = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const totalMigrated = results.reduce((sum, r) => sum + (r.migrated || 0), 0);

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('📊 RESUMEN DE MIGRACIÓN');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`✅ Exitosas: ${success}`);
  console.log(`❌ Fallidas: ${failed}`);
  console.log(`📦 Total registros migrados: ${totalMigrated}`);
  console.log(`⏱️  Tiempo: ${elapsed}s`);
  console.log('══════════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    console.log('❌ Tablas con errores:');
    results.filter(r => !r.ok).forEach(r => {
      console.log(`   - ${r.table}: ${r.error || 'error desconocido'}`);
    });
    console.log('');
  }

  console.log('🎉 Migración completada.');
  console.log('📝 Próximos pasos:');
  console.log('   1. Verifica los datos en Firebase Console');
  console.log('   2. Migra archivos de Storage manualmente');
  console.log('   3. Actualiza las variables de entorno en Railway');
  console.log('   4. Despliega el nuevo backend: index.firebase.js');
  console.log('   5. Actualiza la URL del API en el cliente móvil\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  error(`Error fatal: ${e.message}`);
  process.exit(1);
});
