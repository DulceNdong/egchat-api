// ══════════════════════════════════════════════════════════════════
// EGCHAT - Script de limpieza de base de datos Supabase
// Uso: node cleanup-db.js
// ══════════════════════════════════════════════════════════════════

try { require('dotenv').config(); } catch(e) {}

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ Faltan variables de entorno: SUPABASE_URL y SUPABASE_SERVICE_KEY');
  console.error('   Crea un archivo .env en la carpeta server/ con esas variables.');
  process.exit(1);
}

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function getTableCount(table) {
  try {
    const { count } = await supabase.from(table).select('*', { count: 'exact', head: true });
    return count ?? '?';
  } catch {
    return 'N/A';
  }
}

async function deleteOlderThan(table, dateColumn, interval, extraFilter = null) {
  try {
    const cutoff = new Date(Date.now() - interval).toISOString();
    let query = supabase.from(table).delete().lt(dateColumn, cutoff);
    if (extraFilter) query = extraFilter(query);
    const { error, count } = await query;
    if (error) {
      log(`  ⚠️  ${table}: ${error.message}`);
      return 0;
    }
    return count || 0;
  } catch (e) {
    log(`  ⚠️  ${table}: ${e.message}`);
    return 0;
  }
}

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  EGCHAT - Limpieza de base de datos Supabase');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');

  // ── DIAGNÓSTICO INICIAL ──────────────────────────────────────────
  log('📊 Estado actual de las tablas:');
  const tables = [
    'users', 'messages', 'chats', 'chat_participants',
    'message_reads', 'message_deletions', 'call_sessions',
    'lia_conversations', 'government_news', 'stories',
    'push_subscriptions', 'expo_push_tokens', 'transactions',
    'contacts', 'recharge_codes'
  ];

  for (const table of tables) {
    const count = await getTableCount(table);
    log(`   ${table.padEnd(25)} → ${count} filas`);
  }

  console.log('');
  log('🧹 Iniciando limpieza...');
  console.log('');

  let totalDeleted = 0;

  // ── 1. call_sessions terminadas o antiguas (> 6 horas) ──────────
  log('1️⃣  call_sessions terminadas...');
  try {
    const { error: e1 } = await supabase
      .from('call_sessions')
      .delete()
      .eq('ended', true);
    if (!e1) log('   ✅ Sesiones terminadas eliminadas');

    const cutoff6h = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { error: e2 } = await supabase
      .from('call_sessions')
      .delete()
      .lt('created_at', cutoff6h);
    if (!e2) log('   ✅ Sesiones antiguas (> 6h) eliminadas');
  } catch (e) {
    log(`   ⚠️  call_sessions: ${e.message}`);
  }

  // ── 2. government_news: LIMPIAR TODAS las existentes ───────────
  log('2️⃣  government_news (eliminando todas las noticias existentes)...');
  try {
    const { error } = await supabase
      .from('government_news')
      .delete()
      .not('id', 'is', null);
    if (!error) log('   ✅ Todas las noticias eliminadas');
    else log(`   ⚠️  ${error.message}`);
  } catch (e) {
    log(`   ⚠️  government_news: ${e.message}`);
  }

  // ── 3. lia_conversations > 60 días ──────────────────────────────
  log('3️⃣  lia_conversations (> 60 días)...');
  const n3 = await deleteOlderThan('lia_conversations', 'created_at', 60 * 24 * 60 * 60 * 1000);
  log(`   ✅ ${n3 || 'algunas'} conversaciones antiguas eliminadas`);

  // ── 4. stories expiradas ─────────────────────────────────────────
  log('4️⃣  stories expiradas...');
  try {
    const { error } = await supabase
      .from('stories')
      .delete()
      .lt('expires_at', new Date().toISOString());
    if (!error) log('   ✅ Stories expiradas eliminadas');
    else log(`   ⚠️  ${error.message}`);
  } catch (e) {
    log(`   ⚠️  stories: ${e.message}`);
  }

  // ── 5. push_subscriptions inactivas > 30 días ───────────────────
  log('5️⃣  push_subscriptions inactivas (> 30 días)...');
  try {
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('active', false)
      .lt('updated_at', cutoff30d);
    if (!error) log('   ✅ Suscripciones push inactivas eliminadas');
    else log(`   ⚠️  ${error.message}`);
  } catch (e) {
    log(`   ⚠️  push_subscriptions: ${e.message}`);
  }

  // ── 6. messages con soft delete > 30 días ───────────────────────
  log('6️⃣  messages eliminados (soft delete > 30 días)...');
  try {
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase
      .from('messages')
      .delete()
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoff30d);
    if (!error) log('   ✅ Mensajes eliminados (soft delete) limpiados');
    else log(`   ⚠️  ${error.message}`);
  } catch (e) {
    log(`   ⚠️  messages: ${e.message}`);
  }

  // ── 7. message_reads > 90 días ───────────────────────────────────
  log('7️⃣  message_reads antiguos (> 90 días)...');
  const n7 = await deleteOlderThan('message_reads', 'read_at', 90 * 24 * 60 * 60 * 1000);
  log(`   ✅ ${n7 || 'algunos'} registros de lectura antiguos eliminados`);

  // ── 8. message_deletions > 90 días ──────────────────────────────
  log('8️⃣  message_deletions antiguos (> 90 días)...');
  const n8 = await deleteOlderThan('message_deletions', 'deleted_at', 90 * 24 * 60 * 60 * 1000);
  log(`   ✅ ${n8 || 'algunos'} registros de eliminación antiguos limpiados`);

  // ── 9. transactions > 1 año ──────────────────────────────────────
  log('9️⃣  transactions muy antiguas (> 1 año)...');
  const n9 = await deleteOlderThan('transactions', 'created_at', 365 * 24 * 60 * 60 * 1000);
  log(`   ✅ ${n9 || 'algunas'} transacciones muy antiguas eliminadas`);

  // ── DIAGNÓSTICO FINAL ────────────────────────────────────────────
  console.log('');
  log('📊 Estado final de las tablas:');
  for (const table of tables) {
    const count = await getTableCount(table);
    log(`   ${table.padEnd(25)} → ${count} filas`);
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  ✅ Limpieza completada');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');
  console.log('  💡 Recuerda también ir a Supabase > Settings > Database');
  console.log('     y ejecutar VACUUM para liberar espacio en disco.');
  console.log('');
}

main().catch(e => {
  console.error('❌ Error fatal:', e.message);
  process.exit(1);
});
