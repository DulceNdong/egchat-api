/**
 * Mi Djangue — Sistema de Moras Automáticas
 * 
 * Lógica para:
 * - Calcular moras cuando se cierra un periodo
 * - Aplicar moras a miembros que no cotizaron
 * - Cerrar turnos automáticamente
 * - Pagar al beneficiario
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Cierra un turno y aplica moras automáticamente
 */
async function closeTurnWithPenalties(groupId, turnNumber) {
  try {
    console.log(`Closing turn ${turnNumber} for group ${groupId}...`);

    // 1. Obtener info del grupo
    const { data: group, error: groupError } = await supabase
      .from('djangue_groups')
      .select(`
        id,
        name,
        quota_amount,
        currency,
        penalty_percent,
        current_turn,
        chat_group_id,
        members:djangue_members!inner(
          id,
          user_id,
          turn_order,
          users:user_id(id, full_name, phone)
        )
      `)
      .eq('id', groupId)
      .single();

    if (groupError) throw groupError;

    // 2. Identificar al beneficiario del turno
    const beneficiary = group.members.find(m => m.turn_order === turnNumber);
    if (!beneficiary) {
      throw new Error(`No se encontró beneficiario para el turno ${turnNumber}`);
    }

    // 3. Calcular el monto a pagar (suma de todas las contribuciones del turno)
    const { data: contributions, error: contribError } = await supabase
      .from('djangue_contributions')
      .select('amount')
      .eq('group_id', groupId)
      .eq('turn_number', turnNumber)
      .eq('status', 'paid');

    if (contribError) throw contribError;

    const payoutAmount = contributions.reduce((sum, c) => sum + c.amount, 0);

    console.log(`Payout amount for ${beneficiary.users.full_name}: ${payoutAmount} ${group.currency}`);

    // 4. Llamar a la función SQL que cierra el turno y aplica moras
    const { data: result, error: closeError } = await supabase.rpc(
      'close_turn_with_penalties',
      {
        p_group_id: groupId,
        p_turn_number: turnNumber,
        p_beneficiary_id: beneficiary.user_id,
        p_payout_amount: payoutAmount,
      }
    );

    if (closeError) throw closeError;

    console.log('Turn closed successfully:', result);

    // 5. Transferir el monto al wallet del beneficiario
    await transferToWallet(beneficiary.user_id, payoutAmount, group.currency, groupId, turnNumber);

    // 6. Enviar notificación push al beneficiario
    await sendPayoutNotification(
      beneficiary.user_id,
      group.name,
      payoutAmount,
      group.currency
    );

    // 7. Notificar a los que recibieron moras
    if (result.penalties && result.penalties.penalties_applied > 0) {
      await notifyPenalizedMembers(groupId, turnNumber, group.name);
    }

    return {
      success: true,
      payout: {
        beneficiary: beneficiary.users.full_name,
        amount: payoutAmount,
        currency: group.currency,
      },
      penalties: result.penalties,
      next_turn: result.next_turn,
    };
  } catch (error) {
    console.error('Error closing turn:', error);
    throw error;
  }
}

/**
 * Transfiere el monto al wallet del beneficiario
 */
async function transferToWallet(userId, amount, currency, groupId, turnNumber) {
  try {
    // Obtener o crear wallet del usuario
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .eq('currency', currency)
      .single();

    if (walletError && walletError.code !== 'PGRST116') {
      throw walletError;
    }

    if (!wallet) {
      // Crear wallet si no existe
      const { error: createError } = await supabase
        .from('wallets')
        .insert({
          user_id: userId,
          currency: currency,
          balance: amount,
        });

      if (createError) throw createError;
    } else {
      // Actualizar balance
      const { error: updateError } = await supabase
        .from('wallets')
        .update({ balance: wallet.balance + amount })
        .eq('id', wallet.id);

      if (updateError) throw updateError;
    }

    // Registrar transacción
    await supabase.from('wallet_transactions').insert({
      wallet_id: wallet?.id,
      user_id: userId,
      type: 'credit',
      amount: amount,
      currency: currency,
      description: `Djangue - Turno ${turnNumber} completado`,
      reference_type: 'djangue',
      reference_id: groupId,
    });

    console.log(`Transferred ${amount} ${currency} to user ${userId}`);
  } catch (error) {
    console.error('Error transferring to wallet:', error);
    throw error;
  }
}

/**
 * Envía notificación push al beneficiario
 */
async function sendPayoutNotification(userId, groupName, amount, currency) {
  try {
    const { data: tokens } = await supabase
      .from('expo_push_tokens')
      .select('token')
      .eq('user_id', userId)
      .eq('active', true);

    if (!tokens || tokens.length === 0) return;

    const messages = tokens.map(t => ({
      to: t.token,
      sound: 'default',
      title: '🎉 ¡Recibiste tu turno!',
      body: `${groupName}: ${amount.toLocaleString('fr-FR')} ${currency} fueron depositados en tu monedero`,
      data: { type: 'djangue_payout', screen: 'wallet' },
      badge: 1,
    }));

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    console.log(`Payout notification sent to user ${userId}`);
  } catch (error) {
    console.error('Error sending payout notification:', error);
  }
}

/**
 * Notifica a los miembros que recibieron moras
 */
async function notifyPenalizedMembers(groupId, turnNumber, groupName) {
  try {
    // Obtener moras aplicadas en este turno
    const { data: penalties } = await supabase
      .from('djangue_penalties')
      .select(`
        user_id,
        amount,
        reason,
        users:user_id(full_name)
      `)
      .eq('group_id', groupId)
      .eq('turn_number', turnNumber)
      .eq('status', 'pending');

    if (!penalties || penalties.length === 0) return;

    // Enviar notificación a cada uno
    for (const penalty of penalties) {
      const { data: tokens } = await supabase
        .from('expo_push_tokens')
        .select('token')
        .eq('user_id', penalty.user_id)
        .eq('active', true);

      if (!tokens || tokens.length === 0) continue;

      const messages = tokens.map(t => ({
        to: t.token,
        sound: 'default',
        title: `⚠️ Mora aplicada - ${groupName}`,
        body: `Se aplicó una mora de ${penalty.amount} por no cotizar a tiempo en el turno ${turnNumber}`,
        data: { type: 'djangue_penalty', screen: 'djangue-member', groupId },
        badge: 1,
      }));

      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      });

      console.log(`Penalty notification sent to ${penalty.users.full_name}`);
    }
  } catch (error) {
    console.error('Error notifying penalized members:', error);
  }
}

/**
 * Verifica si un turno está listo para cerrarse automáticamente
 */
async function checkAutoCloseTurns() {
  try {
    console.log('=== Checking turns ready to close ===');

    // Obtener grupos activos donde el periodo ha terminado
    const { data: groups, error } = await supabase
      .from('djangue_groups')
      .select('id, name, current_turn, period_end_date')
      .eq('status', 'active')
      .lte('period_end_date', new Date().toISOString());

    if (error) throw error;

    if (!groups || groups.length === 0) {
      console.log('No turns ready to close');
      return;
    }

    console.log(`Found ${groups.length} turn(s) ready to close`);

    // Cerrar cada turno
    for (const group of groups) {
      try {
        const result = await closeTurnWithPenalties(group.id, group.current_turn);
        console.log(`✓ Closed turn ${group.current_turn} for ${group.name}`);
        console.log(`  - Payout: ${result.payout.amount} to ${result.payout.beneficiary}`);
        console.log(`  - Penalties: ${result.penalties.penalties_applied} applied`);
      } catch (error) {
        console.error(`✗ Failed to close turn for ${group.name}:`, error.message);
      }
    }

    console.log('=== Auto-close check completed ===');
  } catch (error) {
    console.error('Error in checkAutoCloseTurns:', error);
  }
}

/**
 * Obtiene el resumen de moras de un usuario
 */
async function getUserPenaltySummary(userId) {
  try {
    const { data, error } = await supabase.rpc('get_user_penalty_summary', {
      p_user_id: userId,
    });

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error getting penalty summary:', error);
    throw error;
  }
}

/**
 * Marca una mora como pagada
 */
async function payPenalty(penaltyId, paymentMethod = 'wallet') {
  try {
    const { data, error } = await supabase.rpc('pay_penalty', {
      p_penalty_id: penaltyId,
      p_payment_method: paymentMethod,
    });

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error paying penalty:', error);
    throw error;
  }
}

// Ejecutar verificación automática si se llama directamente
if (require.main === module) {
  checkAutoCloseTurns()
    .then(() => {
      console.log('Done');
      process.exit(0);
    })
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}

module.exports = {
  closeTurnWithPenalties,
  checkAutoCloseTurns,
  getUserPenaltySummary,
  payPenalty,
  transferToWallet,
};
