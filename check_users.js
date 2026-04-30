const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function checkUsers() {
  try {
    console.log('Conectando a Supabase...');
    console.log('URL:', process.env.SUPABASE_URL);
    
    const { data: users, error } = await supabase
      .from('users')
      .select('id, phone, full_name, avatar_url, status, created_at')
      .limit(10);
    
    if (error) {
      console.error('Error al consultar usuarios:', error);
      return;
    }
    
    console.log(`Usuarios encontrados: ${users?.length || 0}`);
    users.forEach((user, i) => {
      console.log(`${i+1}. ID: ${user.id?.slice(0,8)}...`);
      console.log(`   Teléfono: ${user.phone}`);
      console.log(`   Nombre: ${user.full_name || 'Sin nombre'}`);
      console.log(`   Estado: ${user.status || 'active'}`);
      console.log(`   Creado: ${user.created_at}`);
      console.log('---');
    });
    
    // Verificar tablas de chat
    const { data: chats, error: chatError } = await supabase
      .from('chats')
      .select('id, type, name, created_at')
      .limit(5);
    
    if (chatError) {
      console.log('Tabla chats no existe o error:', chatError.message);
    } else {
      console.log(`Chats encontrados: ${chats?.length || 0}`);
    }
    
    // Verificar tabla de mensajes
    const { data: messages, error: msgError } = await supabase
      .from('messages')
      .select('id, text, created_at')
      .limit(5);
    
    if (msgError) {
      console.log('Tabla messages no existe o error:', msgError.message);
    } else {
      console.log(`Mensajes encontrados: ${messages?.length || 0}`);
    }
    
  } catch (e) {
    console.error('Error de conexión:', e.message);
  }
}

checkUsers();
