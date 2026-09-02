const { Client } = require('pg');
const NEON_URL = 'postgresql://neondb_owner:npg_QGsC87gwTEbL@ep-icy-smoke-a2znhutu.eu-central-1.aws.neon.tech/neondb?sslmode=require';

async function check() {
  const client = new Client({ connectionString: NEON_URL });
  await client.connect();

  console.log('\n=== USUARIOS EN NEON ===');
  const users = await client.query(`SELECT id, phone, full_name FROM users ORDER BY created_at DESC LIMIT 10`);
  users.rows.forEach(u => console.log(` ${u.phone} | ${u.full_name} | ${u.id}`));

  console.log('\n=== PARTICIPANTES POR USUARIO (top 5) ===');
  const parts = await client.query(`
    SELECT u.phone, u.full_name, COUNT(cp.chat_id) as chat_count
    FROM users u
    LEFT JOIN chat_participants cp ON cp.user_id = u.id
    GROUP BY u.id, u.phone, u.full_name
    ORDER BY chat_count DESC
    LIMIT 10
  `);
  parts.rows.forEach(p => console.log(` ${p.phone} | ${p.full_name} | ${p.chat_count} chats`));

  console.log('\n=== CHATS CON PARTICIPANTES ===');
  const chats = await client.query(`
    SELECT c.id, c.type, c.name, COUNT(cp.user_id) as members
    FROM chats c
    LEFT JOIN chat_participants cp ON cp.chat_id = c.id
    GROUP BY c.id, c.type, c.name
    ORDER BY c.updated_at DESC
    LIMIT 10
  `);
  chats.rows.forEach(c => console.log(` ${c.type} | ${c.name||'privado'} | ${c.members} miembros | ${c.id}`));

  await client.end();
}
check().catch(console.error);
