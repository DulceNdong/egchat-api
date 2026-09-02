-- ═══════════════════════════════════════════════════════════════
-- MI DJANGUE — Tablas Supabase
-- Tanda/caja de ahorro grupal para EGCHAT
-- Ejecutar en: https://supabase.com/dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════════

-- 1. Grupos Djangue
CREATE TABLE IF NOT EXISTS djangue_groups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT,
  logo_url      TEXT,                     -- URL del logo del djangue
  slogan        TEXT,                     -- eslogan del grupo
  frequency     TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly','annual')),
  quota_amount  NUMERIC(12,2) NOT NULL,  -- cuota por periodo por miembro
  currency      TEXT NOT NULL DEFAULT 'XAF',
  max_members   INT NOT NULL DEFAULT 12,
  penalty_percent NUMERIC(5,2) NOT NULL DEFAULT 10.00,  -- % de mora para morosos
  notification_days_before INT NOT NULL DEFAULT 10,      -- días antes para 1ra notificación
  notification_final_days  INT NOT NULL DEFAULT 5,       -- últimos X días para notifs diarias
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','cancelled')),
  owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,    -- administrador general
  secretary_id  UUID REFERENCES users(id) ON DELETE SET NULL,            -- secretario
  chat_group_id UUID,                                                     -- referencia al grupo de chat de EGChat
  wallet_id     UUID,                                                     -- monedero del djangue
  current_turn  INT NOT NULL DEFAULT 1,    -- turno actual (1-based)
  total_turns   INT NOT NULL DEFAULT 0,    -- total de turnos = total miembros
  period_start_date  TIMESTAMPTZ,          -- inicio del periodo actual
  period_end_date    TIMESTAMPTZ,          -- fin del periodo actual
  next_payout_at TIMESTAMPTZ,              -- fecha del próximo cobro
  total_mora_collected NUMERIC(12,2) NOT NULL DEFAULT 0,  -- total de moras cobradas históricamente
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Monedero del djangue (separado de wallets personales)
CREATE TABLE IF NOT EXISTS djangue_wallets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID NOT NULL UNIQUE REFERENCES djangue_groups(id) ON DELETE CASCADE,
  balance     NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'XAF',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Miembros del djangue
CREATE TABLE IF NOT EXISTS djangue_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID NOT NULL REFERENCES djangue_groups(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  turn_order  INT NOT NULL,              -- número de turno asignado
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','removed')),
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(group_id, user_id),
  UNIQUE(group_id, turn_order)
);

-- 4. Cuotas/Pagos de cada miembro por turno
CREATE TABLE IF NOT EXISTS djangue_contributions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        UUID NOT NULL REFERENCES djangue_groups(id) ON DELETE CASCADE,
  member_id       UUID NOT NULL REFERENCES djangue_members(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  turn_number     INT NOT NULL,          -- para qué turno es esta cuota
  amount          NUMERIC(12,2) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','justified')),
  justification_note TEXT,               -- nota de justificación si no puede pagar
  paid_at         TIMESTAMPTZ,
  transaction_id  UUID,                  -- referencia a transactions
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Historial de moras aplicadas
CREATE TABLE IF NOT EXISTS djangue_penalties (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        UUID NOT NULL REFERENCES djangue_groups(id) ON DELETE CASCADE,
  member_id       UUID NOT NULL REFERENCES djangue_members(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  turn_number     INT NOT NULL,
  penalty_amount  NUMERIC(12,2) NOT NULL,
  penalty_percent NUMERIC(5,2) NOT NULL,
  reason          TEXT,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Notificaciones enviadas
CREATE TABLE IF NOT EXISTS djangue_notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        UUID NOT NULL REFERENCES djangue_groups(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  type            TEXT NOT NULL CHECK (type IN ('reminder_10days','reminder_daily','payment_received','turn_completed','penalty_applied')),
  title           TEXT NOT NULL,
  message         TEXT NOT NULL,
  read            BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Historial de pagos al beneficiario (cuando le toca el turno)
CREATE TABLE IF NOT EXISTS djangue_payouts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        UUID NOT NULL REFERENCES djangue_groups(id) ON DELETE CASCADE,
  beneficiary_id  UUID NOT NULL REFERENCES users(id),
  turn_number     INT NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  expected_amount NUMERIC(12,2) NOT NULL,  -- lo que debería haber sido sin moras
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_djangue_groups_owner     ON djangue_groups(owner_id);
CREATE INDEX IF NOT EXISTS idx_djangue_groups_secretary ON djangue_groups(secretary_id);
CREATE INDEX IF NOT EXISTS idx_djangue_groups_chat      ON djangue_groups(chat_group_id);
CREATE INDEX IF NOT EXISTS idx_djangue_members_group    ON djangue_members(group_id);
CREATE INDEX IF NOT EXISTS idx_djangue_members_user     ON djangue_members(user_id);
CREATE INDEX IF NOT EXISTS idx_djangue_contributions_group ON djangue_contributions(group_id);
CREATE INDEX IF NOT EXISTS idx_djangue_contributions_user  ON djangue_contributions(user_id);
CREATE INDEX IF NOT EXISTS idx_djangue_contributions_turn  ON djangue_contributions(turn_number);
CREATE INDEX IF NOT EXISTS idx_djangue_penalties_group  ON djangue_penalties(group_id);
CREATE INDEX IF NOT EXISTS idx_djangue_penalties_user   ON djangue_penalties(user_id);
CREATE INDEX IF NOT EXISTS idx_djangue_notifications_group ON djangue_notifications(group_id);
CREATE INDEX IF NOT EXISTS idx_djangue_notifications_user  ON djangue_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_djangue_payouts_group    ON djangue_payouts(group_id);

-- Trigger: actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_djangue_groups_updated_at ON djangue_groups;
CREATE TRIGGER update_djangue_groups_updated_at
  BEFORE UPDATE ON djangue_groups
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

DROP TRIGGER IF EXISTS update_djangue_wallets_updated_at ON djangue_wallets;
CREATE TRIGGER update_djangue_wallets_updated_at
  BEFORE UPDATE ON djangue_wallets
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- RLS (Row Level Security) — solo miembros ven su djangue
ALTER TABLE djangue_groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE djangue_wallets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE djangue_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE djangue_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE djangue_penalties     ENABLE ROW LEVEL SECURITY;
ALTER TABLE djangue_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE djangue_payouts       ENABLE ROW LEVEL SECURITY;

-- El service_role de la API tiene acceso total (bypassa RLS)
-- Las policies son para acceso directo desde cliente (no usado aquí)
CREATE POLICY "service_role_all_djangue_groups"        ON djangue_groups        FOR ALL USING (true);
CREATE POLICY "service_role_all_djangue_wallets"       ON djangue_wallets       FOR ALL USING (true);
CREATE POLICY "service_role_all_djangue_members"       ON djangue_members       FOR ALL USING (true);
CREATE POLICY "service_role_all_djangue_contributions" ON djangue_contributions FOR ALL USING (true);
CREATE POLICY "service_role_all_djangue_penalties"     ON djangue_penalties     FOR ALL USING (true);
CREATE POLICY "service_role_all_djangue_notifications" ON djangue_notifications FOR ALL USING (true);
CREATE POLICY "service_role_all_djangue_payouts"       ON djangue_payouts       FOR ALL USING (true);


-- ═══════════════════════════════════════════════════════════════
-- NOTAS DE IMPLEMENTACIÓN
-- ═══════════════════════════════════════════════════════════════
--
-- ROLES:
-- - Administrador General (owner_id): Crea djangue, configura todo
-- - Secretario (secretary_id): Gestiona miembros, envía notificaciones
-- - Integrantes (members): Pagan cuotas, reciben turnos
--
-- NOTIFICACIONES AUTOMÁTICAS:
-- - 10 días antes del cierre: Primera notificación a pendientes
-- - Últimos 5 días: Notificación DIARIA a pendientes
-- - Implementar con cron job o función serverless
--
-- MORAS:
-- - Se aplican SOLO al cerrar el periodo
-- - % configurado en penalty_percent
-- - Se descuenta del wallet personal del moroso
-- - Se suma al bote del djangue
--
-- CHAT GRUPAL:
-- - Al crear djangue, crear grupo de chat en EGChat
-- - Guardar chat_group_id en djangue_groups
-- - Todos los miembros se agregan automáticamente
--
-- LOGO:
-- - Subir a storage de Supabase o S3
-- - Guardar URL en logo_url
--
-- ═══════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════
-- INTEGRACIÓN CON CHAT GRUPAL
-- ═══════════════════════════════════════════════════════════════

-- Agregar tipo de grupo para diferenciar chats de djangue
ALTER TABLE groups ADD COLUMN IF NOT EXISTS group_type TEXT DEFAULT 'regular' 
  CHECK (group_type IN ('regular', 'djangue', 'broadcast'));

-- Índice para búsquedas rápidas por tipo
CREATE INDEX IF NOT EXISTS idx_groups_type ON groups(group_type);

-- Función helper para enviar mensajes del sistema al chat del djangue
CREATE OR REPLACE FUNCTION send_djangue_system_message(
  p_group_id UUID,
  p_text TEXT
) RETURNS VOID AS $$
BEGIN
  INSERT INTO messages (group_id, sender_id, type, text, created_at)
  VALUES (p_group_id, NULL, 'system', p_text, NOW());
END;
$$ LANGUAGE plpgsql;

-- Trigger: Enviar mensaje al chat cuando alguien cotiza
CREATE OR REPLACE FUNCTION notify_chat_on_payment() RETURNS TRIGGER AS $$
DECLARE
  v_chat_group_id UUID;
  v_member_name TEXT;
  v_quota_amount NUMERIC;
  v_currency TEXT;
BEGIN
  IF NEW.status = 'paid' AND (OLD.status IS NULL OR OLD.status != 'paid') THEN
    -- Obtener info del djangue y miembro
    SELECT dg.chat_group_id, dg.quota_amount, dg.currency, u.full_name
    INTO v_chat_group_id, v_quota_amount, v_currency, v_member_name
    FROM djangue_groups dg
    JOIN users u ON u.id = NEW.user_id
    WHERE dg.id = NEW.group_id;

    -- Enviar mensaje al chat si existe
    IF v_chat_group_id IS NOT NULL THEN
      PERFORM send_djangue_system_message(
        v_chat_group_id,
        '✅ ' || v_member_name || ' cotizó ' || v_quota_amount || ' ' || v_currency
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_notify_chat_on_payment ON djangue_contributions;
CREATE TRIGGER trigger_notify_chat_on_payment
  AFTER INSERT OR UPDATE ON djangue_contributions
  FOR EACH ROW
  EXECUTE FUNCTION notify_chat_on_payment();

-- Trigger: Enviar mensaje al chat cuando se cierra un turno
CREATE OR REPLACE FUNCTION notify_chat_on_payout() RETURNS TRIGGER AS $$
DECLARE
  v_chat_group_id UUID;
  v_beneficiary_name TEXT;
  v_amount NUMERIC;
  v_currency TEXT;
  v_turn_number INT;
BEGIN
  IF NEW.status = 'completed' AND (OLD.status IS NULL OR OLD.status != 'completed') THEN
    -- Obtener info
    SELECT dg.chat_group_id, dg.currency, u.full_name, NEW.turn_number
    INTO v_chat_group_id, v_currency, v_beneficiary_name, v_turn_number
    FROM djangue_groups dg
    JOIN users u ON u.id = NEW.beneficiary_id
    WHERE dg.id = NEW.group_id;

    -- Enviar mensaje
    IF v_chat_group_id IS NOT NULL THEN
      PERFORM send_djangue_system_message(
        v_chat_group_id,
        '🎉 Turno ' || v_turn_number || ' cerrado. ' || v_beneficiary_name || 
        ' recibió ' || NEW.amount || ' ' || v_currency
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_notify_chat_on_payout ON djangue_payouts;
CREATE TRIGGER trigger_notify_chat_on_payout
  AFTER INSERT OR UPDATE ON djangue_payouts
  FOR EACH ROW
  EXECUTE FUNCTION notify_chat_on_payout();

-- ═══════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════
-- SISTEMA DE CÁLCULO AUTOMÁTICO DE MORAS
-- ═══════════════════════════════════════════════════════════════

-- Función para calcular moras de un turno cerrado
CREATE OR REPLACE FUNCTION calculate_turn_penalties(
  p_group_id UUID,
  p_turn_number INT
) RETURNS TABLE(
  user_id UUID,
  penalty_amount NUMERIC,
  reason TEXT
) AS $$
DECLARE
  v_quota_amount NUMERIC;
  v_penalty_percent NUMERIC;
  v_currency TEXT;
BEGIN
  -- Obtener configuración del djangue
  SELECT quota_amount, penalty_percent, currency
  INTO v_quota_amount, v_penalty_percent, v_currency
  FROM djangue_groups
  WHERE id = p_group_id;

  -- Retornar miembros que no pagaron ni justificaron
  RETURN QUERY
  SELECT 
    dm.user_id,
    ROUND((v_quota_amount * v_penalty_percent / 100)::NUMERIC, 2) as penalty_amount,
    ('Mora del ' || v_penalty_percent || '% por no cotizar en el turno ' || p_turn_number) as reason
  FROM djangue_members dm
  WHERE dm.group_id = p_group_id
    AND dm.status = 'active'
    -- No es el beneficiario del turno
    AND dm.turn_order != p_turn_number
    -- No existe una contribución pagada o justificada
    AND NOT EXISTS (
      SELECT 1 FROM djangue_contributions dc
      WHERE dc.group_id = p_group_id
        AND dc.user_id = dm.user_id
        AND dc.turn_number = p_turn_number
        AND dc.status IN ('paid', 'justified')
    );
END;
$$ LANGUAGE plpgsql;

-- Función para aplicar moras y registrarlas
CREATE OR REPLACE FUNCTION apply_turn_penalties(
  p_group_id UUID,
  p_turn_number INT
) RETURNS JSON AS $$
DECLARE
  v_penalty_record RECORD;
  v_chat_group_id UUID;
  v_user_name TEXT;
  v_currency TEXT;
  v_total_penalties NUMERIC := 0;
  v_count INT := 0;
  v_result JSON;
BEGIN
  -- Obtener chat_group_id y currency
  SELECT chat_group_id, currency INTO v_chat_group_id, v_currency
  FROM djangue_groups
  WHERE id = p_group_id;

  -- Aplicar mora a cada miembro que no pagó
  FOR v_penalty_record IN 
    SELECT * FROM calculate_turn_penalties(p_group_id, p_turn_number)
  LOOP
    -- Insertar el registro de mora
    INSERT INTO djangue_penalties (
      group_id,
      user_id,
      turn_number,
      amount,
      reason,
      status
    ) VALUES (
      p_group_id,
      v_penalty_record.user_id,
      p_turn_number,
      v_penalty_record.penalty_amount,
      v_penalty_record.reason,
      'pending'
    );

    -- Actualizar total de moras del grupo
    UPDATE djangue_groups
    SET total_mora_collected = COALESCE(total_mora_collected, 0) + v_penalty_record.penalty_amount
    WHERE id = p_group_id;

    -- Enviar mensaje al chat
    IF v_chat_group_id IS NOT NULL THEN
      SELECT full_name INTO v_user_name
      FROM users
      WHERE id = v_penalty_record.user_id;

      PERFORM send_djangue_system_message(
        v_chat_group_id,
        '⚠️ Mora aplicada a ' || v_user_name || ': ' || 
        v_penalty_record.penalty_amount || ' ' || v_currency
      );
    END IF;

    v_total_penalties := v_total_penalties + v_penalty_record.penalty_amount;
    v_count := v_count + 1;
  END LOOP;

  -- Preparar resultado
  v_result := json_build_object(
    'success', true,
    'penalties_applied', v_count,
    'total_amount', v_total_penalties,
    'currency', v_currency,
    'turn_number', p_turn_number
  );

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- Función para cerrar un turno y aplicar moras automáticamente
CREATE OR REPLACE FUNCTION close_turn_with_penalties(
  p_group_id UUID,
  p_turn_number INT,
  p_beneficiary_id UUID,
  p_payout_amount NUMERIC
) RETURNS JSON AS $$
DECLARE
  v_penalty_result JSON;
  v_payout_id UUID;
  v_result JSON;
BEGIN
  -- 1. Crear el registro de pago al beneficiario
  INSERT INTO djangue_payouts (
    group_id,
    beneficiary_id,
    turn_number,
    amount,
    status
  ) VALUES (
    p_group_id,
    p_beneficiary_id,
    p_turn_number,
    p_payout_amount,
    'completed'
  )
  RETURNING id INTO v_payout_id;

  -- 2. Aplicar moras a los que no pagaron
  v_penalty_result := apply_turn_penalties(p_group_id, p_turn_number);

  -- 3. Avanzar al siguiente turno
  UPDATE djangue_groups
  SET 
    current_turn = current_turn + 1,
    period_start_date = CURRENT_DATE,
    period_end_date = CASE frequency
      WHEN 'daily' THEN CURRENT_DATE + INTERVAL '1 day'
      WHEN 'weekly' THEN CURRENT_DATE + INTERVAL '1 week'
      WHEN 'monthly' THEN CURRENT_DATE + INTERVAL '1 month'
      WHEN 'annual' THEN CURRENT_DATE + INTERVAL '1 year'
    END
  WHERE id = p_group_id;

  -- 4. Preparar resultado completo
  v_result := json_build_object(
    'success', true,
    'payout_id', v_payout_id,
    'payout_amount', p_payout_amount,
    'penalties', v_penalty_result,
    'next_turn', p_turn_number + 1
  );

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- Vista para consultar moras pendientes por usuario
CREATE OR REPLACE VIEW djangue_user_penalties AS
SELECT 
  dp.id,
  dp.group_id,
  dp.user_id,
  dp.turn_number,
  dp.amount,
  dp.reason,
  dp.status,
  dp.created_at,
  dg.name as group_name,
  dg.currency,
  u.full_name as user_name,
  u.phone as user_phone
FROM djangue_penalties dp
JOIN djangue_groups dg ON dg.id = dp.group_id
JOIN users u ON u.id = dp.user_id
ORDER BY dp.created_at DESC;

-- Función para obtener resumen de moras de un usuario
CREATE OR REPLACE FUNCTION get_user_penalty_summary(p_user_id UUID)
RETURNS JSON AS $$
DECLARE
  v_total_pending NUMERIC;
  v_total_paid NUMERIC;
  v_count_pending INT;
  v_penalties JSON;
BEGIN
  -- Calcular totales
  SELECT 
    COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0),
    COUNT(*) FILTER (WHERE status = 'pending')
  INTO v_total_pending, v_total_paid, v_count_pending
  FROM djangue_penalties
  WHERE user_id = p_user_id;

  -- Obtener lista de moras pendientes
  SELECT json_agg(
    json_build_object(
      'id', id,
      'group_name', group_name,
      'turn_number', turn_number,
      'amount', amount,
      'currency', currency,
      'reason', reason,
      'created_at', created_at
    )
  )
  INTO v_penalties
  FROM djangue_user_penalties
  WHERE user_id = p_user_id AND status = 'pending';

  RETURN json_build_object(
    'total_pending', v_total_pending,
    'total_paid', v_total_paid,
    'count_pending', v_count_pending,
    'penalties', COALESCE(v_penalties, '[]'::json)
  );
END;
$$ LANGUAGE plpgsql;

-- Función para marcar una mora como pagada
CREATE OR REPLACE FUNCTION pay_penalty(
  p_penalty_id UUID,
  p_payment_method TEXT DEFAULT 'wallet'
) RETURNS JSON AS $$
DECLARE
  v_amount NUMERIC;
  v_user_id UUID;
  v_group_id UUID;
  v_chat_group_id UUID;
  v_user_name TEXT;
  v_currency TEXT;
BEGIN
  -- Obtener datos de la mora
  SELECT amount, user_id, group_id
  INTO v_amount, v_user_id, v_group_id
  FROM djangue_penalties
  WHERE id = p_penalty_id AND status = 'pending';

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Mora no encontrada o ya pagada');
  END IF;

  -- Marcar como pagada
  UPDATE djangue_penalties
  SET 
    status = 'paid',
    paid_at = NOW(),
    payment_method = p_payment_method
  WHERE id = p_penalty_id;

  -- Obtener info para notificación
  SELECT dg.chat_group_id, dg.currency, u.full_name
  INTO v_chat_group_id, v_currency, v_user_name
  FROM djangue_groups dg
  JOIN users u ON u.id = v_user_id
  WHERE dg.id = v_group_id;

  -- Enviar mensaje al chat
  IF v_chat_group_id IS NOT NULL THEN
    PERFORM send_djangue_system_message(
      v_chat_group_id,
      '✅ ' || v_user_name || ' pagó su mora de ' || v_amount || ' ' || v_currency
    );
  END IF;

  RETURN json_build_object(
    'success', true,
    'penalty_id', p_penalty_id,
    'amount_paid', v_amount
  );
END;
$$ LANGUAGE plpgsql;

-- Trigger para notificar al usuario cuando se le aplica una mora
CREATE OR REPLACE FUNCTION notify_user_on_penalty() RETURNS TRIGGER AS $$
BEGIN
  -- Aquí se puede integrar con el sistema de notificaciones push
  -- Por ahora solo se registra en la tabla de notificaciones
  INSERT INTO djangue_notifications (
    group_id,
    user_id,
    type,
    title,
    message
  ) VALUES (
    NEW.group_id,
    NEW.user_id,
    'penalty_applied',
    '⚠️ Mora aplicada',
    NEW.reason || '. Monto: ' || NEW.amount
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_notify_user_on_penalty ON djangue_penalties;
CREATE TRIGGER trigger_notify_user_on_penalty
  AFTER INSERT ON djangue_penalties
  FOR EACH ROW
  EXECUTE FUNCTION notify_user_on_penalty();

-- Índices para mejorar rendimiento de consultas de moras
CREATE INDEX IF NOT EXISTS idx_penalties_user_status ON djangue_penalties(user_id, status);
CREATE INDEX IF NOT EXISTS idx_penalties_group_turn ON djangue_penalties(group_id, turn_number);

-- ═══════════════════════════════════════════════════════════════

COMMENT ON FUNCTION calculate_turn_penalties IS 'Calcula las moras para un turno específico sin aplicarlas';
COMMENT ON FUNCTION apply_turn_penalties IS 'Aplica moras a todos los miembros que no pagaron en un turno';
COMMENT ON FUNCTION close_turn_with_penalties IS 'Cierra un turno, paga al beneficiario y aplica moras automáticamente';
COMMENT ON FUNCTION get_user_penalty_summary IS 'Obtiene resumen de moras de un usuario';
COMMENT ON FUNCTION pay_penalty IS 'Marca una mora como pagada y notifica al grupo';


-- ═══════════════════════════════════════════════════════════════
-- ESTADÍSTICAS Y REPORTES PARA ADMINISTRADOR
-- ═══════════════════════════════════════════════════════════════

-- Función para obtener estadísticas completas del administrador
CREATE OR REPLACE FUNCTION get_admin_stats(p_group_id UUID)
RETURNS JSON AS $$
DECLARE
  v_group RECORD;
  v_total_collected NUMERIC := 0;
  v_total_delivered NUMERIC := 0;
  v_total_penalties NUMERIC := 0;
  v_active_members INT := 0;
  v_completed_turns INT := 0;
  v_on_time_payments INT := 0;
  v_late_payments INT := 0;
  v_upcoming_turns JSON;
  v_recent_payouts JSON;
  v_top_contributors JSON;
  v_members_with_penalties JSON;
  v_compliance_rate NUMERIC;
BEGIN
  -- Obtener info básica del grupo
  SELECT * INTO v_group
  FROM djangue_groups
  WHERE id = p_group_id;

  IF NOT FOUND THEN
    RETURN json_build_object('error', 'Group not found');
  END IF;

  -- Total recaudado (todas las contribuciones pagadas)
  SELECT COALESCE(SUM(amount), 0) INTO v_total_collected
  FROM djangue_contributions
  WHERE group_id = p_group_id AND status = 'paid';

  -- Total entregado (todos los payouts completados)
  SELECT COALESCE(SUM(amount), 0) INTO v_total_delivered
  FROM djangue_payouts
  WHERE group_id = p_group_id AND status = 'completed';

  -- Total de moras
  SELECT COALESCE(SUM(amount), 0) INTO v_total_penalties
  FROM djangue_penalties
  WHERE group_id = p_group_id;

  -- Miembros activos
  SELECT COUNT(*) INTO v_active_members
  FROM djangue_members
  WHERE group_id = p_group_id AND status = 'active';

  -- Turnos completados
  SELECT COUNT(*) INTO v_completed_turns
  FROM djangue_payouts
  WHERE group_id = p_group_id AND status = 'completed';

  -- Pagos a tiempo vs tarde
  SELECT 
    COUNT(*) FILTER (WHERE paid_at <= created_at + INTERVAL '1 day'),
    COUNT(*) FILTER (WHERE paid_at > created_at + INTERVAL '1 day')
  INTO v_on_time_payments, v_late_payments
  FROM djangue_contributions
  WHERE group_id = p_group_id AND status = 'paid';

  -- Tasa de cumplimiento
  v_compliance_rate := CASE 
    WHEN (v_on_time_payments + v_late_payments) > 0 
    THEN ROUND((v_on_time_payments::NUMERIC / (v_on_time_payments + v_late_payments)) * 100)
    ELSE 100
  END;

  -- Próximos 5 turnos
  SELECT json_agg(
    json_build_object(
      'turn_number', dm.turn_order,
      'beneficiary_name', u.full_name,
      'beneficiary_avatar', u.avatar_url,
      'estimated_date', v_group.period_start_date + 
        (CASE v_group.frequency
          WHEN 'daily' THEN (dm.turn_order - v_group.current_turn) * INTERVAL '1 day'
          WHEN 'weekly' THEN (dm.turn_order - v_group.current_turn) * INTERVAL '1 week'
          WHEN 'monthly' THEN (dm.turn_order - v_group.current_turn) * INTERVAL '1 month'
          WHEN 'annual' THEN (dm.turn_order - v_group.current_turn) * INTERVAL '1 year'
        END),
      'expected_amount', v_group.quota_amount * (v_active_members - 1)
    )
    ORDER BY dm.turn_order
  ) INTO v_upcoming_turns
  FROM djangue_members dm
  JOIN users u ON u.id = dm.user_id
  WHERE dm.group_id = p_group_id
    AND dm.status = 'active'
    AND dm.turn_order >= v_group.current_turn
  LIMIT 5;

  -- Últimas 5 entregas
  SELECT json_agg(
    json_build_object(
      'turn_number', dp.turn_number,
      'beneficiary_name', u.full_name,
      'amount', dp.amount,
      'delivered_at', dp.created_at
    )
    ORDER BY dp.created_at DESC
  ) INTO v_recent_payouts
  FROM djangue_payouts dp
  JOIN users u ON u.id = dp.beneficiary_id
  WHERE dp.group_id = p_group_id AND dp.status = 'completed'
  LIMIT 5;

  -- Top 5 contribuyentes
  SELECT json_agg(
    json_build_object(
      'user_name', u.full_name,
      'total_contributed', contrib_sum,
      'on_time_rate', ROUND((on_time_count::NUMERIC / total_count) * 100)
    )
    ORDER BY contrib_sum DESC
  ) INTO v_top_contributors
  FROM (
    SELECT 
      dc.user_id,
      SUM(dc.amount) as contrib_sum,
      COUNT(*) as total_count,
      COUNT(*) FILTER (WHERE dc.paid_at <= dc.created_at + INTERVAL '1 day') as on_time_count
    FROM djangue_contributions dc
    WHERE dc.group_id = p_group_id AND dc.status = 'paid'
    GROUP BY dc.user_id
    ORDER BY contrib_sum DESC
    LIMIT 5
  ) sub
  JOIN users u ON u.id = sub.user_id;

  -- Miembros con moras pendientes
  SELECT json_agg(
    json_build_object(
      'user_name', u.full_name,
      'pending_amount', penalty_sum
    )
    ORDER BY penalty_sum DESC
  ) INTO v_members_with_penalties
  FROM (
    SELECT 
      dp.user_id,
      SUM(dp.amount) as penalty_sum
    FROM djangue_penalties dp
    WHERE dp.group_id = p_group_id AND dp.status = 'pending'
    GROUP BY dp.user_id
  ) sub
  JOIN users u ON u.id = sub.user_id;

  -- Construir respuesta completa
  RETURN json_build_object(
    'group_id', v_group.id,
    'group_name', v_group.name,
    'group_logo', v_group.logo_url,
    'currency', v_group.currency,
    'total_collected', v_total_collected,
    'total_delivered', v_total_delivered,
    'total_penalties', v_total_penalties,
    'active_members', v_active_members,
    'completed_turns', v_completed_turns,
    'total_turns', v_active_members,
    'current_turn', v_group.current_turn,
    'overall_compliance_rate', v_compliance_rate,
    'on_time_payments', v_on_time_payments,
    'late_payments', v_late_payments,
    'upcoming_turns', COALESCE(v_upcoming_turns, '[]'::json),
    'recent_payouts', COALESCE(v_recent_payouts, '[]'::json),
    'top_contributors', COALESCE(v_top_contributors, '[]'::json),
    'members_with_penalties', COALESCE(v_members_with_penalties, '[]'::json)
  );
END;
$$ LANGUAGE plpgsql;

-- Función para obtener estadísticas globales (todos los djangues)
CREATE OR REPLACE FUNCTION get_global_djangue_stats()
RETURNS JSON AS $$
DECLARE
  v_total_groups INT;
  v_active_groups INT;
  v_total_members INT;
  v_total_collected NUMERIC;
  v_total_delivered NUMERIC;
  v_total_penalties NUMERIC;
BEGIN
  SELECT COUNT(*) INTO v_total_groups FROM djangue_groups;
  SELECT COUNT(*) INTO v_active_groups FROM djangue_groups WHERE status = 'active';
  SELECT COUNT(*) INTO v_total_members FROM djangue_members WHERE status = 'active';
  
  SELECT COALESCE(SUM(amount), 0) INTO v_total_collected
  FROM djangue_contributions WHERE status = 'paid';
  
  SELECT COALESCE(SUM(amount), 0) INTO v_total_delivered
  FROM djangue_payouts WHERE status = 'completed';
  
  SELECT COALESCE(SUM(amount), 0) INTO v_total_penalties
  FROM djangue_penalties;

  RETURN json_build_object(
    'total_groups', v_total_groups,
    'active_groups', v_active_groups,
    'total_members', v_total_members,
    'total_collected', v_total_collected,
    'total_delivered', v_total_delivered,
    'total_penalties', v_total_penalties
  );
END;
$$ LANGUAGE plpgsql;

-- Vista para reportes exportables
CREATE OR REPLACE VIEW djangue_full_report AS
SELECT 
  dg.id as group_id,
  dg.name as group_name,
  dg.frequency,
  dg.quota_amount,
  dg.currency,
  dg.current_turn,
  dg.status as group_status,
  dg.created_at as group_created_at,
  u_owner.full_name as owner_name,
  u_secretary.full_name as secretary_name,
  COUNT(DISTINCT dm.id) as total_members,
  COUNT(DISTINCT dc.id) FILTER (WHERE dc.status = 'paid') as total_contributions,
  COALESCE(SUM(dc.amount) FILTER (WHERE dc.status = 'paid'), 0) as total_collected,
  COUNT(DISTINCT dp.id) as total_payouts,
  COALESCE(SUM(dp.amount), 0) as total_delivered,
  COUNT(DISTINCT pen.id) as total_penalties_count,
  COALESCE(SUM(pen.amount), 0) as total_penalties_amount
FROM djangue_groups dg
LEFT JOIN users u_owner ON u_owner.id = dg.owner_id
LEFT JOIN users u_secretary ON u_secretary.id = dg.secretary_id
LEFT JOIN djangue_members dm ON dm.group_id = dg.id AND dm.status = 'active'
LEFT JOIN djangue_contributions dc ON dc.group_id = dg.id
LEFT JOIN djangue_payouts dp ON dp.group_id = dg.id
LEFT JOIN djangue_penalties pen ON pen.group_id = dg.id
GROUP BY dg.id, u_owner.full_name, u_secretary.full_name;

-- ═══════════════════════════════════════════════════════════════

COMMENT ON FUNCTION get_admin_stats IS 'Obtiene estadísticas completas para el dashboard del administrador';
COMMENT ON FUNCTION get_global_djangue_stats IS 'Obtiene estadísticas globales de todos los djangues';
COMMENT ON VIEW djangue_full_report IS 'Vista con reporte completo para exportación';

-- ═══════════════════════════════════════════════════════════════
-- COLUMNAS ADICIONALES — necesarias para funciones de moras
-- Ejecutar si las funciones pay_penalty / apply_turn_penalties fallan
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE djangue_penalties ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE djangue_penalties ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'wallet';
ALTER TABLE djangue_penalties ADD COLUMN IF NOT EXISTS amount NUMERIC(12,2);
ALTER TABLE djangue_penalties ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'
  CHECK (status IN ('pending','paid'));

-- Columna total_mora_collected en grupos (por si falta)
ALTER TABLE djangue_groups ADD COLUMN IF NOT EXISTS total_mora_collected NUMERIC(12,2) NOT NULL DEFAULT 0;
