const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const requiredVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'JWT_SECRET'];
const placeholderPatterns = [
  /your-project\.supabase\.co/i,
  /your_service_role_key/i,
  /TU_PROYECTO/i,
  /TU_SERVICE_ROLE_KEY/i,
  /example\.supabase\.co/i
];

console.log('--- EGCHAT API local environment diagnostics ---');
console.log(`.env file ${fs.existsSync('.env') ? 'found' : 'not found'}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV || 'not set'}`);
console.log(`PORT: ${process.env.PORT || '5000 (default)'}`);

const missingVars = [];
requiredVars.forEach((name) => {
  const value = process.env[name];
  const isMissing = !value || !value.trim();
  const isPlaceholder = !isMissing && placeholderPatterns.some((regex) => regex.test(value));

  console.log(`${name}: ${isMissing ? 'missing' : isPlaceholder ? 'placeholder value detected' : 'set'}`);

  if (isMissing) missingVars.push(name);
  if (isPlaceholder) missingVars.push(name + ' (placeholder)');
});

if (missingVars.length > 0) {
  console.error('ERROR: Variables de entorno faltantes o inválidas: ' + missingVars.join(', '));
  process.exit(1);
}

console.log('Todas las variables obligatorias están presentes. Probando conexión a Supabase...');

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const { data, error } = await supabase.from('users').select('id').limit(1);
    if (error) {
      console.error('ERROR: Conexión Supabase falló: ' + error.message);
      process.exit(1);
    }

    console.log('✅ Supabase conectado correctamente.');
    console.log(`   Tabla users consultada, registros recuperados: ${Array.isArray(data) ? data.length : 'unknown'}`);
    process.exit(0);
  } catch (error) {
    console.error('ERROR de conexión Supabase:', error.message || error);
    process.exit(1);
  }
})();
