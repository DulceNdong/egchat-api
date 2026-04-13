const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function createTestUser() {
  try {
    console.log('Creando usuario de prueba...');
    
    // Hash de la contraseña
    const hashedPassword = await bcrypt.hash('test123', 10);
    
    // Crear usuario
    const { data: user, error } = await supabase
      .from('users')
      .upsert({
        phone: '+240111222333',
        full_name: 'Usuario de Prueba EGCHAT',
        password: hashedPassword,
        status: 'active',
        avatar_url: 'https://i.pravatar.cc/150?img=68',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();
    
    if (error) {
      console.error('Error al crear usuario:', error);
      return;
    }
    
    console.log('Usuario creado exitosamente:');
    console.log('ID:', user.id);
    console.log('Teléfono:', user.phone);
    console.log('Nombre:', user.full_name);
    console.log('Estado:', user.status);
    
    // Generar token JWT para pruebas
    const token = jwt.sign(
      { id: user.id, phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    console.log('Token JWT para pruebas:');
    console.log(token);
    
    // Verificar que podemos leer el usuario
    const { data: verifyUser, error: verifyError } = await supabase
      .from('users')
      .select('*')
      .eq('phone', '+240111222333')
      .single();
    
    if (verifyError) {
      console.error('Error verificando usuario:', verifyError);
    } else {
      console.log('Usuario verificado exitosamente');
    }
    
  } catch (e) {
    console.error('Error:', e.message);
  }
}

createTestUser();
