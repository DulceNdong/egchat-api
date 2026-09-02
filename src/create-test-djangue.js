/**
 * Script para crear un Djangue de Prueba
 * Ejecutar: node create-test-djangue.js
 */

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../egchat-mobile/.env') });

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function createTestDjangue() {
  try {
    console.log('🚀 Creando Djangue de prueba...\n');

    // 1. Obtener un usuario existente
    const { data: users, error: userError } = await supabase
      .from('users')
      .select('id, username')
      .limit(10);

    if (userError || !users || users.length === 0) {
      console.error('❌ Error: No hay usuarios en la base de datos');
      console.log('Por favor crea al menos un usuario primero.');
      return;
    }

    const ownerId = users[0].id;
    console.log(`✅ Usuario owner: ${users[0].username || users[0].id}`);

    // 2. Crear el grupo de djangue
    const { data: group, error: groupError } = await supabase
      .from('djangue_groups')
      .insert({
        name: 'Djangue Amigos 2026',
        description: 'Grupo de ahorro mensual para ayudarnos mutuamente',
        slogan: '¡Juntos somos más fuertes! 💪',
        frequency: 'monthly',
        quota_amount: 50000,
        currency: 'XAF',
        max_members: 10,
        penalty_percent: 10.00,
        notification_days_before: 10,
        notification_final_days: 5,
        status: 'active',
        owner_id: ownerId,
        current_turn: 1,
        total_turns: 10,
        period_start_date: new Date().toISOString(),
        period_end_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();

    if (groupError) {
      console.error('❌ Error creando djangue:', groupError);
      return;
    }

    console.log(`✅ Djangue creado: ${group.name} (ID: ${group.id})`);

    // 3. Crear el monedero del djangue
    const { data: wallet, error: walletError } = await supabase
      .from('djangue_wallets')
      .insert({
        group_id: group.id,
        balance: 0,
        currency: 'XAF',
      })
      .select()
      .single();

    if (walletError) {
      console.error('⚠️  Advertencia creando wallet:', walletError);
    } else {
      console.log(`✅ Monedero creado (ID: ${wallet.id})`);

      // Actualizar el grupo con el wallet_id
      await supabase
        .from('djangue_groups')
        .update({ wallet_id: wallet.id })
        .eq('id', group.id);
    }

    // 4. Crear grupo de chat (opcional)
    const { data: chatGroup, error: chatError } = await supabase
      .from('groups')
      .insert({
        name: `Chat: ${group.name}`,
        type: 'group',
        group_type: 'djangue',
        created_by: ownerId,
      })
      .select()
      .single();

    if (!chatError && chatGroup) {
      console.log(`✅ Grupo de chat creado (ID: ${chatGroup.id})`);

      // Actualizar el grupo con el chat_group_id
      await supabase
        .from('djangue_groups')
        .update({ chat_group_id: chatGroup.id })
        .eq('id', group.id);

      // Agregar al owner como miembro del chat
      await supabase
        .from('group_members')
        .insert({
          group_id: chatGroup.id,
          user_id: ownerId,
          role: 'admin',
        });
    }

    // 5. Agregar miembros al djangue
    const members = [];
    for (let i = 0; i < Math.min(users.length, 10); i++) {
      members.push({
        group_id: group.id,
        user_id: users[i].id,
        turn_number: i + 1,
        status: 'active',
        joined_at: new Date().toISOString(),
      });
    }

    const { data: insertedMembers, error: membersError } = await supabase
      .from('djangue_members')
      .insert(members)
      .select();

    if (membersError) {
      console.error('⚠️  Error agregando miembros:', membersError);
    } else {
      console.log(`✅ ${insertedMembers.length} miembros agregados al djangue`);
    }

    // 6. Crear cotizaciones de ejemplo (3 ya pagadas, resto pendientes)
    const contributions = insertedMembers.map((member, index) => ({
      group_id: group.id,
      member_id: member.id,
      turn_number: 1,
      amount: 50000,
      currency: 'XAF',
      status: index < 3 ? 'paid' : 'pending',
      contributed_at: index < 3 ? new Date().toISOString() : null,
    }));

    const { error: contribError } = await supabase
      .from('djangue_contributions')
      .insert(contributions);

    if (contribError) {
      console.error('⚠️  Error creando cotizaciones:', contribError);
    } else {
      console.log(`✅ Cotizaciones creadas (3 pagadas, ${insertedMembers.length - 3} pendientes)`);

      // Actualizar el balance del wallet
      if (wallet) {
        await supabase
          .from('djangue_wallets')
          .update({ balance: 3 * 50000 })
          .eq('id', wallet.id);

        console.log('✅ Balance actualizado: 150,000 XAF');
      }
    }

    console.log('\n🎉 ¡DJANGUE DE PRUEBA CREADO EXITOSAMENTE!\n');
    console.log('📊 Resumen:');
    console.log(`   Nombre: ${group.name}`);
    console.log(`   ID: ${group.id}`);
    console.log(`   Miembros: ${insertedMembers.length}/10`);
    console.log(`   Cuota: 50,000 XAF/mes`);
    console.log(`   Turno actual: 1`);
    console.log(`   Balance: 150,000 XAF (3 pagos recibidos)`);
    console.log(`   Estado: Activo\n`);
    console.log('🔗 Abre la app y ve a: Mini Apps → Mi Djangue');

  } catch (error) {
    console.error('❌ Error inesperado:', error);
  }
}

createTestDjangue();
