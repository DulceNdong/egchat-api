const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Probar diferentes claves de Supabase
const keys = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqdG94amN1eWZhcGVwcm5paW5rIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTY5NjQwMDI4MCwiZXhwIjoyMDExOTc2MjgwfQ.Hpqh4zAKCbfLq8t8Z3x_8u5iL8j8J5k8d9J3f2Dqf4Y',
  process.env.SUPABASE_SERVICE_KEY,
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqdG94amN1eWZhcGVwcm5paW5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTY0MDAyODAsImV4cCI6MjAxMTk3NjI4MH0.4b8qJz3kK3xJX3xJ3xJ3xJ3xJ3xJ3xJ3xJ3xJ3xJ3xJ'
];

async function testConnection() {
  console.log('Probando conexión a Supabase con diferentes claves...');
  
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!key) continue;
    
    console.log(`\n--- Probando clave ${i + 1} ---`);
    console.log(`Key: ${key.substring(0, 50)}...`);
    
    const supabase = createClient(
      process.env.SUPABASE_URL,
      key
    );
    
    try {
      const { data, error } = await supabase
        .from('users')
        .select('count')
        .limit(1);
      
      if (error) {
        console.log('Error:', error.message);
      } else {
        console.log('Conexión exitosa!');
        
        // Intentar crear usuario de prueba
        const { data: user, error: userError } = await supabase
          .from('users')
          .upsert({
            phone: '+240111222333',
            full_name: 'Usuario de Prueba EGCHAT',
            password: '$2a$10$rOzJqQjQjQjQjQjQjQjQjO',
            status: 'active',
            avatar_url: 'https://i.pravatar.cc/150?img=68',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .select()
          .single();
        
        if (userError) {
          console.log('Error creando usuario:', userError.message);
        } else {
          console.log('Usuario de prueba creado exitosamente!');
          console.log('ID:', user.id);
          console.log('Teléfono:', user.phone);
          console.log('Nombre:', user.full_name);
          
          // Actualizar el .env con la clave correcta
          require('fs').writeFileSync('.env', `
# EGCHAT API - Variables de entorno
PORT=5000
JWT_SECRET=egchat_secret_2026
SUPABASE_URL=https://fjtoxjcuyfapeprniink.supabase.co
SUPABASE_SERVICE_KEY=${key}
CORS_ALLOWED_ORIGINS=https://egchat-app.vercel.app,http://localhost:3003,http://localhost:5173
APP_VERSION=2.5.1
          `);
          
          console.log('Archivo .env actualizado con la clave correcta');
          return;
        }
      }
    } catch (e) {
      console.log('Error de conexión:', e.message);
    }
  }
  
  console.log('\nNo se encontró una clave válida. Debes obtener la SERVICE_ROLE_KEY del dashboard de Supabase');
}

testConnection();
