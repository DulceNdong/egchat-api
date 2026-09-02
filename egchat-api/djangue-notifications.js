/**
 * Mi Djangue — Sistema de Notificaciones Automáticas
 * 
 * Cron Job que se ejecuta diariamente para:
 * - Enviar notificaciones 10 días antes del cierre de periodo
 * - Enviar notificaciones diarias los últimos 5 días
 * - Enviar recordatorios a integrantes que no han cotizado
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Calcula días restantes hasta el fin del periodo
 */
function getDaysUntilPeriodEnd(periodEndDate) {
  const now = new Date();
  const end = new Date(periodEndDate);
  const diffTime = end.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
}

/**
 * Envía notificación push a un usuario
 */
async function sendPushNotification(userId, title, message, data = {}) {
  try {
    // Obtener token de push del usuario
    const { data: tokens, error } = await supabase
      .from('expo_push_tokens')
      .select('token')
      .eq('user_id', userId)
      .eq('active', true);

    if (error || !tokens || tokens.length === 0) {
      console.log(`No push tokens found for user ${userId}`);
      return;
    }

    // Enviar notificación via Expo Push
    const messages = tokens.map(t => ({
      to: t.token,
      sound: 'default',
      title,
      body: message,
      data: { ...data, type: 'djangue' },
      badge: 1,
    }));

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    const result = await response.json();
    console.log('Push notification sent:', result);
    return result;
  } catch (error) {
    console.error('Error sending push notification:', error);
  }
}

/**
 * Registra notificación en la base de datos
 */
async function recordNotification(groupId, userId, type, title, message) {
  try {
    const { error } = await supabase
      .from('djangue_notifications')
      .insert({
        group_id: groupId,
        user_id: userId,
        type,
        title,
        message,
        sent_at: new Date().toISOString(),
      });

    if (error) throw error;
  } catch (error) {
    console.error('Error recording notification:', error);
  }
}

/**
 * Procesa notificaciones para un djangue específico
 */
async function processGroupNotifications(group) {
  const daysRemaining = getDaysUntilPeriodEnd(group.period_end_date);
  
  console.log(`Processing group ${group.name}: ${daysRemaining} days remaining`);

  // Obtener miembros pendientes de pago
  const { data: pendingMembers, error: membersError } = await supabase
    .from('djangue_members')
    .select(`
      id,
      user_id,
      turn_order,
      users:user_id (
        id,
        full_name,
        phone
      )
    `)
    .eq('group_id', group.id)
    .eq('status', 'active');

  if (membersError) {
    console.error('Error fetching members:', membersError);
    return;
  }

  // Obtener contribuciones del turno actual
  const { data: contributions } = await supabase
    .from('djangue_contributions')
    .select('user_id, status')
    .eq('group_id', group.id)
    .eq('turn_number', group.current_turn);

  const contributionsMap = {};
  if (contributions) {
    contributions.forEach(c => {
      contributionsMap[c.user_id] = c.status;
    });
  }

  // Filtrar miembros que no han pagado ni justificado
  const unpaidMembers = pendingMembers.filter(m => {
    const status = contributionsMap[m.user_id];
    return !status || (status !== 'paid' && status !== 'justified');
  });

  if (unpaidMembers.length === 0) {
    console.log(`All members have paid or are justified for group ${group.name}`);
    return;
  }

  let shouldSendNotification = false;
  let notificationType = '';
  let title = '';
  let messageTemplate = '';

  // Determinar si se debe enviar notificación
  if (daysRemaining === group.notification_days_before) {
    // Primera notificación (ej. 10 días antes)
    shouldSendNotification = true;
    notificationType = 'reminder_10days';
    title = `⏰ Recordatorio: ${group.name}`;
    messageTemplate = `Faltan ${daysRemaining} días para cerrar el periodo. Por favor, realiza tu cotización de ${group.quota_amount} ${group.currency}.`;
  } else if (daysRemaining <= group.notification_final_days && daysRemaining > 0) {
    // Notificaciones diarias los últimos días (ej. últimos 5 días)
    shouldSendNotification = true;
    notificationType = 'reminder_daily';
    title = `🚨 Urgente: ${group.name}`;
    messageTemplate = `¡Solo quedan ${daysRemaining} día${daysRemaining > 1 ? 's' : ''}! Cotiza ${group.quota_amount} ${group.currency} antes del cierre para evitar mora del ${group.penalty_percent}%.`;
  } else if (daysRemaining === 0) {
    // Último día
    shouldSendNotification = true;
    notificationType = 'reminder_daily';
    title = `🚨 ¡Último día!: ${group.name}`;
    messageTemplate = `Hoy es el último día para cotizar. Evita la mora del ${group.penalty_percent}% cotizando ${group.quota_amount} ${group.currency} ahora.`;
  }

  if (!shouldSendNotification) {
    console.log(`No notification needed for group ${group.name} (${daysRemaining} days remaining)`);
    return;
  }

  // Enviar notificaciones a miembros pendientes
  console.log(`Sending ${notificationType} to ${unpaidMembers.length} members of ${group.name}`);

  for (const member of unpaidMembers) {
    try {
      const message = messageTemplate;
      
      // Enviar push notification
      await sendPushNotification(
        member.user_id,
        title,
        message,
        { 
          group_id: group.id,
          group_name: group.name,
          screen: 'djangue-detail',
          params: { id: group.id }
        }
      );

      // Registrar en base de datos
      await recordNotification(
        group.id,
        member.user_id,
        notificationType,
        title,
        message
      );

      console.log(`Notification sent to ${member.users.full_name}`);
    } catch (error) {
      console.error(`Error sending notification to member ${member.id}:`, error);
    }
  }

  // Notificar al secretario sobre pendientes
  if (group.secretary_id && unpaidMembers.length > 0) {
    const secretaryTitle = `📋 Reporte: ${group.name}`;
    const secretaryMessage = `Hay ${unpaidMembers.length} integrante${unpaidMembers.length > 1 ? 's' : ''} pendiente${unpaidMembers.length > 1 ? 's' : ''} de cotizar. Faltan ${daysRemaining} día${daysRemaining > 1 ? 's' : ''} para cerrar el periodo.`;
    
    await sendPushNotification(
      group.secretary_id,
      secretaryTitle,
      secretaryMessage,
      { 
        group_id: group.id,
        group_name: group.name,
        screen: 'djangue-secretary',
        params: { id: group.id }
      }
    );

    await recordNotification(
      group.id,
      group.secretary_id,
      'secretary_report',
      secretaryTitle,
      secretaryMessage
    );
  }
}

/**
 * Función principal que se ejecuta diariamente
 */
async function runDailyNotifications() {
  console.log('=== Starting Djangue Daily Notifications ===');
  console.log('Time:', new Date().toISOString());

  try {
    // Obtener todos los djangues activos
    const { data: groups, error } = await supabase
      .from('djangue_groups')
      .select('*')
      .eq('status', 'active')
      .not('period_end_date', 'is', null);

    if (error) {
      console.error('Error fetching groups:', error);
      return;
    }

    if (!groups || groups.length === 0) {
      console.log('No active groups found');
      return;
    }

    console.log(`Found ${groups.length} active group(s)`);

    // Procesar cada grupo
    for (const group of groups) {
      try {
        await processGroupNotifications(group);
      } catch (error) {
        console.error(`Error processing group ${group.id}:`, error);
      }
    }

    console.log('=== Djangue Daily Notifications Completed ===');
  } catch (error) {
    console.error('Fatal error in runDailyNotifications:', error);
  }
}

/**
 * Ejecutar notificaciones inmediatamente (para testing)
 */
if (require.main === module) {
  runDailyNotifications()
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
  runDailyNotifications,
  sendPushNotification,
  recordNotification,
};
