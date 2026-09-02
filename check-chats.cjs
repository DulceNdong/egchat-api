const { Client } = require('pg');

const NEON_URL = 'postgresql://neondb_owner:npg_QGsC87gwTEbL@ep-icy-smoke-a2znhutu.eu-central-1.aws.neon.tech/neondb?sslmode=require';

async function check() {
  const client = new Client({ connectionString: NEON_URL });
  await client.connect();

  const chats = await client.query(`SELECT id, type, name, created_by, created_at FROM chats ORDER BY created_at DESC LIMIT 20`);
  console.log('\n=== CHATS EN NEON ===');
  console.log(`Total: ${chats.rows.length}`);
  chats.rows.forEach(c => console.log(` ${c.type} | ${c.name || '(privado)'} | ${c.id} | ${c.created_at}`));

  const parts = await client.query(`SELECT COUNT(*) as total FROM chat_participants`);
  console.log(`\nParticipantes: ${parts.rows[0].total}`);

  const msgs = await client.query(`SELECT COUNT(*) as total FROM messages`);
  console.log(`Mensajes: ${msgs.rows[0].total}`);

  const users = await client.query(`SELECT COUNT(*) as total FROM users`);
  console.log(`Usuarios: ${users.rows[0].total}`);

  const contacts = await client.query(`SELECT COUNT(*) as total FROM contacts`);
  console.log(`Contactos: ${contacts.rows[0].total}`);

  await client.end();
}

check().catch(console.error);
