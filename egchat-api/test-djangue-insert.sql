-- ═══════════════════════════════════════════════════════════════
-- DJANGUE DE PRUEBA - Insertar datos de ejemplo
-- Ejecutar en Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- PASO 1: Obtener un usuario existente para ser el owner
-- (Reemplaza 'TU_USER_ID' con un UUID real de tu tabla users)
DO $$
DECLARE
  v_owner_id UUID;
  v_group_id UUID;
  v_wallet_id UUID;
  v_chat_group_id UUID;
BEGIN
  -- Obtener el primer usuario disponible
  SELECT id INTO v_owner_id FROM users LIMIT 1;
  
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'No hay usuarios en la base de datos. Crea un usuario primero.';
  END IF;

  -- PASO 2: Crear el grupo de djangue
  INSERT INTO djangue_groups (
    name,
    description,
    slogan,
    frequency,
    quota_amount,
    currency,
    max_members,
    penalty_percent,
    notification_days_before,
    notification_final_days,
    status,
    owner_id,
    current_turn,
    total_turns,
    period_start_date,
    period_end_date
  ) VALUES (
    'Djangue Amigos 2026',
    'Grupo de ahorro mensual para ayudarnos mutuamente',
    '¡Juntos somos más fuertes! 💪',
    'monthly',
    50000,
    'XAF',
    10,
    10.00,
    10,
    5,
    'active',
    v_owner_id,
    1,
    10,
    NOW(),
    NOW() + INTERVAL '30 days'
  ) RETURNING id INTO v_group_id;

  RAISE NOTICE 'Djangue creado con ID: %', v_group_id;

  -- PASO 3: Crear el monedero del djangue
  INSERT INTO djangue_wallets (
    group_id,
    balance,
    currency
  ) VALUES (
    v_group_id,
    0,
    'XAF'
  ) RETURNING id INTO v_wallet_id;

  -- Actualizar el grupo con el wallet_id
  UPDATE djangue_groups SET wallet_id = v_wallet_id WHERE id = v_group_id;

  RAISE NOTICE 'Monedero creado con ID: %', v_wallet_id;

  -- PASO 4: Crear grupo de chat (si existe la tabla groups)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'groups') THEN
    INSERT INTO groups (
      name,
      type,
      group_type,
      created_by
    ) VALUES (
      'Chat: Djangue Amigos 2026',
      'group',
      'djangue',
      v_owner_id
    ) RETURNING id INTO v_chat_group_id;

    -- Actualizar el grupo con el chat_group_id
    UPDATE djangue_groups SET chat_group_id = v_chat_group_id WHERE id = v_group_id;

    RAISE NOTICE 'Grupo de chat creado con ID: %', v_chat_group_id;
  END IF;

  -- PASO 5: Agregar al owner como primer miembro con turno 1
  INSERT INTO djangue_members (
    group_id,
    user_id,
    turn_number,
    status,
    joined_at
  ) VALUES (
    v_group_id,
    v_owner_id,
    1,
    'active',
    NOW()
  );

  RAISE NOTICE 'Miembro owner agregado al djangue';

  -- PASO 6: Agregar más usuarios como miembros (si existen)
  DECLARE
    v_member_id UUID;
    v_turn_num INT := 2;
  BEGIN
    FOR v_member_id IN (
      SELECT id FROM users 
      WHERE id != v_owner_id 
      LIMIT 9
    ) LOOP
      INSERT INTO djangue_members (
        group_id,
        user_id,
        turn_number,
        status,
        joined_at
      ) VALUES (
        v_group_id,
        v_member_id,
        v_turn_num,
        'active',
        NOW()
      );
      
      v_turn_num := v_turn_num + 1;
      
      RAISE NOTICE 'Miembro agregado con turno: %', v_turn_num - 1;
    END LOOP;
  END;

  -- PASO 7: Crear algunas cotizaciones de ejemplo para el turno actual
  INSERT INTO djangue_contributions (
    group_id,
    member_id,
    turn_number,
    amount,
    currency,
    status,
    contributed_at
  )
  SELECT 
    v_group_id,
    dm.id,
    1,
    50000,
    'XAF',
    CASE 
      WHEN dm.turn_number <= 3 THEN 'paid'
      ELSE 'pending'
    END,
    CASE 
      WHEN dm.turn_number <= 3 THEN NOW()
      ELSE NULL
    END
  FROM djangue_members dm
  WHERE dm.group_id = v_group_id;

  RAISE NOTICE 'Cotizaciones creadas para el turno 1';

  -- Actualizar el balance del wallet con las cotizaciones pagadas
  UPDATE djangue_wallets 
  SET balance = balance + (3 * 50000)
  WHERE id = v_wallet_id;

  RAISE NOTICE '✅ DJANGUE DE PRUEBA CREADO EXITOSAMENTE';
  RAISE NOTICE 'Nombre: Djangue Amigos 2026';
  RAISE NOTICE 'ID: %', v_group_id;
  RAISE NOTICE 'Miembros: % de %', (SELECT COUNT(*) FROM djangue_members WHERE group_id = v_group_id), 10;
  RAISE NOTICE 'Balance: 150,000 XAF (3 cotizaciones pagadas)';
  RAISE NOTICE 'Turno actual: 1';

END $$;
