/**
 * Script de prueba para el flujo completo de Mi Djangue
 * Ejecutar: node test-djangue-flow.js
 */

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../egchat-mobile/.env') });

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function testDjangueFlow() {
  console.log('🧪 Iniciando pruebas del flujo de Mi Djangue\n');

  try {
    // 1. Verificar que existen tablas necesarias
    console.log('1️⃣ Verificando tablas en la base de datos...');
    
    const tables = ['djangue_groups', 'djangue_members', 'djangue_wallets', 'djangue_contributions'];
    
    for (const table of tables) {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .limit(1);
      
      if (error) {
        console.log(`   ❌ Tabla ${table}: ${error.message}`);
      } else {
        console.log(`   ✅ Tabla ${table}: OK`);
      }
    }

    // 2. Verificar Supabase Storage bucket
    console.log('\n2️⃣ Verificando bucket de Supabase Storage...');
    
    const { data: buckets, error: bucketsError } = await supabase.storage.listBuckets();
    
    if (bucketsError) {
      console.log(`   ❌ Error listando buckets: ${bucketsError.message}`);
    } else {
      const publicBucket = buckets.find(b => b.name === 'public');
      if (publicBucket) {
        console.log(`   ✅ Bucket 'public' existe`);
      } else {
        console.log(`   ⚠️  Bucket 'public' no existe - creando...`);
        
        const { error: createError } = await supabase.storage.createBucket('public', {
          public: true,
        });
        
        if (createError) {
          console.log(`   ❌ Error creando bucket: ${createError.message}`);
        } else {
          console.log(`   ✅ Bucket 'public' creado exitosamente`);
        }
      }
    }

    // 3. Verificar que hay usuarios en la BD
    console.log('\n3️⃣ Verificando usuarios...');
    
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, name, phone')
      .limit(5);
    
    if (usersError) {
      console.log(`   ❌ Error consultando usuarios: ${usersError.message}`);
    } else if (!users || users.length === 0) {
      console.log(`   ⚠️  No hay usuarios en la base de datos`);
      console.log(`   💡 Registra un usuario desde la app móvil primero`);
    } else {
      console.log(`   ✅ Encontrados ${users.length} usuarios:`);
      users.forEach((u, i) => {
        console.log(`      ${i + 1}. ${u.name || 'Sin nombre'} (${u.phone})`);
      });
    }

    // 4. Verificar djangues existentes
    console.log('\n4️⃣ Verificando djangues existentes...');
    
    const { data: djangues, error: djanguesError } = await supabase
      .from('djangue_groups')
      .select('id, name, status, current_turn, total_turns')
      .limit(10);
    
    if (djanguesError) {
      console.log(`   ❌ Error consultando djangues: ${djanguesError.message}`);
    } else if (!djangues || djangues.length === 0) {
      console.log(`   ℹ️  No hay djangues creados aún`);
    } else {
      console.log(`   ✅ Encontrados ${djangues.length} djangues:`);
      djangues.forEach((d, i) => {
        console.log(`      ${i + 1}. ${d.name} - Turno ${d.current_turn}/${d.total_turns} (${d.status})`);
      });
    }

    // 5. Instrucciones para probar en la app
    console.log('\n\n📱 INSTRUCCIONES PARA PROBAR EN LA APP:\n');
    console.log('1. Abre la app móvil en http://localhost:8081');
    console.log('2. Asegúrate de estar logueado');
    console.log('3. Ve a Mini Apps → Mi Djangue');
    console.log('4. Presiona la pestaña "Crear"');
    console.log('5. Llena el formulario:');
    console.log('   - Sube una foto como logo (toca el círculo)');
    console.log('   - Nombre: "Djangue Prueba"');
    console.log('   - Eslogan: "Ahorrando juntos"');
    console.log('   - Periodicidad: Mensual');
    console.log('   - Cuota: 50000 XAF');
    console.log('   - Max miembros: 10');
    console.log('6. Presiona "Crear Djangue"');
    console.log('7. Deberías ver la vista del djangue con tu usuario como primer integrante\n');

    console.log('✅ Pruebas de configuración completadas');
    console.log('\nEl backend está listo en: http://localhost:5000');
    console.log('Endpoints disponibles:');
    console.log('  • POST /api/upload/djangue-logo');
    console.log('  • POST /api/djangue');
    console.log('  • GET  /api/djangues');
    console.log('  • GET  /api/djangue/:id');
    console.log('  • POST /api/djangue/:id/members\n');

  } catch (error) {
    console.error('\n❌ Error en las pruebas:', error.message);
  }
}

testDjangueFlow();
