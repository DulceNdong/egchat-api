const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const NEON_URL = 'postgresql://neondb_owner:npg_QGsC87gwTEbL@ep-icy-smoke-a2znhutu.eu-central-1.aws.neon.tech/neondb?sslmode=require';

const schema = fs.readFileSync(path.join(__dirname, 'full_dependencies.sql'), 'utf8');

// Solo ejecutar la parte nueva (tablas faltantes) — la primera parte ya está aplicada
const lines = schema.split('\n');
const startIdx = lines.findIndex(l => l.includes('Columnas y tablas faltantes'));
const newSchema = startIdx >= 0 ? lines.slice(startIdx).join('\n') : schema;

async function migrate() {
  const client = new Client({ connectionString: NEON_URL });
  try {
    console.log('Conectando a Neon...');
    await client.connect();
    console.log('Conectado OK');
    console.log('Aplicando tablas faltantes...');
    await client.query(newSchema);
    console.log('Schema aplicado correctamente');
    const res = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`);
    console.log('\nTablas creadas:');
    res.rows.forEach(r => console.log(' -', r.table_name));
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
