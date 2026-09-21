'use strict';

/**
 * db.js — Pool de PostgreSQL compartido para el servidor EGCHAT
 *
 * Se conecta vía DATABASE_URL (Supabase transaction pooler).
 * En Render: añade DATABASE_URL en Settings > Environment.
 *
 * Formato:
 *   postgresql://postgres.REF:PASSWORD@aws-0-XX.pooler.supabase.com:6543/postgres
 */

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('[db] ⚠️  DATABASE_URL no definida. Las rutas KYC/AML fallarán.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[db] Error inesperado en cliente idle:', err.message);
});

module.exports = { pool };
