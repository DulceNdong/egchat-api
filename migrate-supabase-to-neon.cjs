/**
 * migrate-supabase-to-neon.cjs
 * Migra chats, grupos, mensajes, contactos y participantes
 * desde Supabase (producción) → Neon (producción)
 */

const { createClient } = require('@supabase/supabase-js');
const { Client } = require('pg');

const SUPABASE_URL = 'https://fjtoxjcuyfapeprniink.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqdG94amN1eWZhcGVwcm5paW5rIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTMxMjQxMywiZXhwIjoyMDkwODg4NDEzfQ.MpI67gnRfcnMCFCvOgg0OJet-wHRaSPjMg-AmP0v2cY';
const NEON_URL   = 'postgresql://neondb_owner:npg_QGsC87gwTEbL@ep-icy-smoke-a2znhutu.eu-central-1.aws.neon.tech/neondb?sslmode=require';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

async function migrate() {
  const pg = new Client({ connectionString: NEON_URL });
  await pg.connect();
  console.log('✅ Conectado a Neon\n');

  // ── 1. USUARIOS ────────────────────────────────────────────────
  console.log('📥 Leyendo usuarios de Supabase...');
  const { data: users, error: uErr } = await sb.from('users').select('*').limit(500);
  if (uErr) { console.error('Error users:', uErr.message); }
  else {
    console.log(`   ${users.length} usuarios encontrados`);
    let ok = 0;
    for (const u of users) {
      try {
        await pg.query(
          `INSERT INTO users (id, phone, full_name, password_hash, avatar_url, status, last_seen, created_at, last_login, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET
             full_name = EXCLUDED.full_name,
             avatar_url = EXCLUDED.avatar_url,
             status = EXCLUDED.status,
             last_login = EXCLUDED.last_login`,
          [u.id, u.phone, u.full_name, u.password_hash, u.avatar_url, u.status||'offline',
           u.last_seen, u.created_at, u.last_login, u.is_active !== false]
        );
        ok++;
      } catch(e) { console.error(`   ✗ user ${u.phone}: ${e.message}`); }
    }
    console.log(`   ✅ ${ok}/${users.length} usuarios migrados`);
  }

  // ── 2. CONTACTOS ───────────────────────────────────────────────
  console.log('\n📥 Leyendo contactos de Supabase...');
  const { data: contacts, error: cErr } = await sb.from('contacts').select('*').limit(1000);
  if (cErr) { console.error('Error contacts:', cErr.message); }
  else {
    console.log(`   ${contacts.length} contactos encontrados`);
    let ok = 0;
    for (const c of contacts) {
      try {
        await pg.query(
          `INSERT INTO contacts (id, user_id, contact_user_id, nickname, is_blocked, is_favorite, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO NOTHING`,
          [c.id, c.user_id, c.contact_user_id, c.nickname||c.name, c.is_blocked||false, c.is_favorite||false, c.created_at]
        );
        ok++;
      } catch(e) { console.error(`   ✗ contact ${c.id}: ${e.message}`); }
    }
    console.log(`   ✅ ${ok}/${contacts.length} contactos migrados`);
  }

  // ── 3. CHATS ───────────────────────────────────────────────────
  console.log('\n📥 Leyendo chats de Supabase...');
  const { data: chats, error: chErr } = await sb.from('chats').select('*').limit(500);
  if (chErr) { console.error('Error chats:', chErr.message); }
  else {
    console.log(`   ${chats.length} chats encontrados`);
    let ok = 0;
    for (const c of chats) {
      try {
        await pg.query(
          `INSERT INTO chats (id, type, name, avatar_url, created_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             updated_at = EXCLUDED.updated_at`,
          [c.id, c.type||'private', c.name, c.avatar_url, c.created_by, c.created_at, c.updated_at||c.created_at]
        );
        ok++;
      } catch(e) { console.error(`   ✗ chat ${c.id}: ${e.message}`); }
    }
    console.log(`   ✅ ${ok}/${chats.length} chats migrados`);
  }

  // ── 4. PARTICIPANTES ───────────────────────────────────────────
  console.log('\n📥 Leyendo chat_participants de Supabase...');
  const { data: parts, error: pErr } = await sb.from('chat_participants').select('*').limit(2000);
  if (pErr) { console.error('Error participants:', pErr.message); }
  else {
    console.log(`   ${parts.length} participantes encontrados`);
    let ok = 0;
    for (const p of parts) {
      try {
        await pg.query(
          `INSERT INTO chat_participants (id, chat_id, user_id, joined_at, unread_count)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (id) DO NOTHING`,
          [p.id, p.chat_id, p.user_id, p.joined_at||p.created_at||new Date(), p.unread_count||0]
        );
        ok++;
      } catch(e) { console.error(`   ✗ part ${p.id}: ${e.message}`); }
    }
    console.log(`   ✅ ${ok}/${parts.length} participantes migrados`);
  }

  // ── 5. MENSAJES ────────────────────────────────────────────────
  console.log('\n📥 Leyendo mensajes de Supabase (últimos 2000)...');
  const { data: msgs, error: mErr } = await sb
    .from('messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(2000);
  if (mErr) { console.error('Error messages:', mErr.message); }
  else {
    console.log(`   ${msgs.length} mensajes encontrados`);
    // Insertar en orden cronológico
    const sorted = [...msgs].reverse();
    let ok = 0;
    for (const m of sorted) {
      try {
        await pg.query(
          `INSERT INTO messages (id, chat_id, sender_id, text, type, status, reply_to, file_url, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO NOTHING`,
          [m.id, m.chat_id, m.sender_id, m.text, m.type||'text', m.status||'sent',
           m.reply_to, m.file_url, m.created_at]
        );
        ok++;
      } catch(e) { if (!e.message.includes('foreign key')) console.error(`   ✗ msg ${m.id}: ${e.message}`); }
    }
    console.log(`   ✅ ${ok}/${msgs.length} mensajes migrados`);
  }

  // ── RESUMEN FINAL ──────────────────────────────────────────────
  const res = await pg.query(`
    SELECT
      (SELECT COUNT(*) FROM users) as users,
      (SELECT COUNT(*) FROM contacts) as contacts,
      (SELECT COUNT(*) FROM chats) as chats,
      (SELECT COUNT(*) FROM chat_participants) as participants,
      (SELECT COUNT(*) FROM messages) as messages
  `);
  const r = res.rows[0];
  console.log('\n══════════════════════════════════════');
  console.log('✅ MIGRACIÓN COMPLETADA');
  console.log(`   Usuarios:      ${r.users}`);
  console.log(`   Contactos:     ${r.contacts}`);
  console.log(`   Chats:         ${r.chats}`);
  console.log(`   Participantes: ${r.participants}`);
  console.log(`   Mensajes:      ${r.messages}`);
  console.log('══════════════════════════════════════\n');

  await pg.end();
}

migrate().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
