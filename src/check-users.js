/**
 * Script para verificar usuarios existentes
 */

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../egchat-mobile/.env') });

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkUsers() {
  try {
    console.log('📊 Verificando usuarios en la base de datos...\n');

    const { data: users, error } = await supabase
      .from('users')
      .select('*')
      .limit(10);

    if (error) {
      console.error('❌ Error consultando usuarios:', error);
      return;
    }

    if (!users || users.length === 0) {
      console.log('⚠️  No hay usuarios en la tabla "users"');
      console.log('\n💡 Opciones:');
      console.log('   1. Registra un usuario desde la app móvil');
      console.log('   2. Usa el panel de Supabase para crear un usuario');
      return;
    }

    console.log(`✅ Encontrados ${users.length} usuarios:\n`);
    console.log('Estructura del primer usuario:');
    console.log(JSON.stringify(users[0], null, 2));
    console.log('\n✅ Puedes ejecutar create-test-djangue.js ahora');

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

checkUsers();
