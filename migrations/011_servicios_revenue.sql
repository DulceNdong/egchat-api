-- ============================================================
-- EGCHAT — Tablas de revenue por TODOS los servicios
-- Comisión universal: 1.5% sobre cada transacción
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- ── Catálogo de servicios registrados ────────────────────────────
CREATE TABLE IF NOT EXISTS revenue_servicios (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  categoria    TEXT NOT NULL,  -- restaurantes, vuelos, hoteles, seguros, apuestas,
                               -- supermercados, bancos, gasolineras, ocio, barcos,
                               -- taxis, correos, farmacia, djangue, otros
  nombre       TEXT NOT NULL,
  descripcion  TEXT,
  comision_pct DECIMAL(5,2) NOT NULL DEFAULT 1.5,
  activo       BOOLEAN DEFAULT true,
  icono        TEXT DEFAULT '🏪',
  ciudad       TEXT DEFAULT 'Malabo',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Transacciones diarias por servicio ───────────────────────────
CREATE TABLE IF NOT EXISTS revenue_transacciones (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  servicio_id     UUID REFERENCES revenue_servicios(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  categoria       TEXT NOT NULL,
  descripcion     TEXT,
  monto_bruto     DECIMAL(14,2) NOT NULL,
  comision_pct    DECIMAL(5,2)  NOT NULL DEFAULT 1.5,
  comision_monto  DECIMAL(14,2) NOT NULL DEFAULT 0,
  estado          TEXT DEFAULT 'completado',  -- completado, pendiente, cancelado
  fecha           TIMESTAMPTZ DEFAULT NOW(),
  dia             DATE GENERATED ALWAYS AS (fecha::DATE) STORED,
  mes             INT,
  anio            INT,
  semana          INT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger para calcular comision_monto, mes, anio, semana
CREATE OR REPLACE FUNCTION trg_revenue_tx_before()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.comision_monto := ROUND(NEW.monto_bruto * NEW.comision_pct / 100, 2);
  NEW.mes    := EXTRACT(MONTH   FROM NEW.fecha)::INT;
  NEW.anio   := EXTRACT(YEAR    FROM NEW.fecha)::INT;
  NEW.semana := EXTRACT(WEEK    FROM NEW.fecha)::INT;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_revenue_tx ON revenue_transacciones;
CREATE TRIGGER trg_revenue_tx
  BEFORE INSERT OR UPDATE ON revenue_transacciones
  FOR EACH ROW EXECUTE FUNCTION trg_revenue_tx_before();

-- ── Resumen diario por categoría (para gráficos rápidos) ─────────
CREATE TABLE IF NOT EXISTS revenue_resumen_diario (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fecha             DATE NOT NULL,
  categoria         TEXT NOT NULL,
  total_bruto       DECIMAL(14,2) DEFAULT 0,
  total_comisiones  DECIMAL(14,2) DEFAULT 0,
  num_transacciones INT DEFAULT 0,
  UNIQUE(fecha, categoria)
);

-- ── Vista: revenue por categoría con tendencia ───────────────────
CREATE OR REPLACE VIEW v_revenue_por_categoria AS
SELECT
  categoria,
  COUNT(*)                              AS total_tx,
  SUM(monto_bruto)                      AS total_bruto,
  SUM(comision_monto)                   AS total_comision,
  AVG(comision_monto)                   AS avg_comision,
  MAX(fecha)                            AS ultima_tx,
  SUM(CASE WHEN mes  = EXTRACT(MONTH FROM NOW())
            AND anio = EXTRACT(YEAR  FROM NOW())
           THEN comision_monto ELSE 0 END) AS comision_mes_actual,
  SUM(CASE WHEN fecha >= NOW() - INTERVAL '7 days'
           THEN comision_monto ELSE 0 END) AS comision_semana,
  SUM(CASE WHEN fecha >= NOW() - INTERVAL '1 day'
           THEN comision_monto ELSE 0 END) AS comision_hoy
FROM revenue_transacciones
WHERE estado = 'completado'
GROUP BY categoria;

-- ── Vista: revenue diario últimos 30 días ─────────────────────────
CREATE OR REPLACE VIEW v_revenue_diario_30 AS
SELECT
  dia,
  SUM(comision_monto)  AS total_comisiones,
  SUM(monto_bruto)     AS total_bruto,
  COUNT(*)             AS num_tx
FROM revenue_transacciones
WHERE estado = 'completado'
  AND dia >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY dia
ORDER BY dia;

-- ── Vista: top servicios del mes ─────────────────────────────────
CREATE OR REPLACE VIEW v_top_servicios_mes AS
SELECT
  s.id,
  s.nombre,
  s.categoria,
  s.icono,
  s.ciudad,
  COUNT(t.id)          AS num_tx,
  SUM(t.monto_bruto)   AS total_bruto,
  SUM(t.comision_monto)AS total_comision
FROM revenue_servicios s
LEFT JOIN revenue_transacciones t
  ON t.servicio_id = s.id
  AND t.mes  = EXTRACT(MONTH FROM NOW())::INT
  AND t.anio = EXTRACT(YEAR  FROM NOW())::INT
  AND t.estado = 'completado'
WHERE s.activo = true
GROUP BY s.id, s.nombre, s.categoria, s.icono, s.ciudad
ORDER BY total_comision DESC NULLS LAST;

-- ── RLS ──────────────────────────────────────────────────────────
ALTER TABLE revenue_servicios      ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_transacciones  ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_resumen_diario ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_revenue_servicios"     ON revenue_servicios;
DROP POLICY IF EXISTS "admin_revenue_transacciones" ON revenue_transacciones;
DROP POLICY IF EXISTS "admin_revenue_resumen"       ON revenue_resumen_diario;

CREATE POLICY "admin_revenue_servicios"     ON revenue_servicios
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
CREATE POLICY "admin_revenue_transacciones" ON revenue_transacciones
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
CREATE POLICY "admin_revenue_resumen"       ON revenue_resumen_diario
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');

-- ============================================================
-- DATOS DEMO — catálogo completo de servicios de la app
-- ============================================================
INSERT INTO revenue_servicios (categoria, nombre, icono, ciudad, comision_pct) VALUES
  -- Restaurantes
  ('restaurantes', 'La Bahía',               '🍽️', 'Malabo', 1.5),
  ('restaurantes', 'El Rincón Guineano',     '🍽️', 'Malabo', 1.5),
  ('restaurantes', 'Pizzería Malabo',        '🍕', 'Malabo', 1.5),
  ('restaurantes', 'Marisquería del Puerto', '🦞', 'Malabo', 1.5),
  -- Vuelos
  ('vuelos', 'Ceiba Intercontinental',  '✈️', 'Malabo', 1.5),
  ('vuelos', 'Iberia GQ',               '✈️', 'Malabo', 1.5),
  ('vuelos', 'Air France GQ',           '✈️', 'Malabo', 1.5),
  ('vuelos', 'Ethiopian Airlines GQ',   '✈️', 'Malabo', 1.5),
  -- Hoteles
  ('hoteles', 'Hotel Bahía',    '🏨', 'Malabo', 1.5),
  ('hoteles', 'Hotel Impala',   '🏨', 'Malabo', 1.5),
  ('hoteles', 'Sofitel Malabo', '🏨', 'Malabo', 1.5),
  ('hoteles', 'Hotel Ureca',    '🏨', 'Bioko Sur', 1.5),
  -- Supermercados
  ('supermercados', 'BM Malabo Centro', '🛒', 'Malabo', 1.5),
  ('supermercados', 'BM Caracolas',     '🛒', 'Malabo', 1.5),
  ('supermercados', 'BM Bata',          '🛒', 'Bata',   1.5),
  -- Gasolineras
  ('gasolineras', 'GEPetrol Centro',    '⛽', 'Malabo', 1.5),
  ('gasolineras', 'GEPetrol Caracolas', '⛽', 'Malabo', 1.5),
  ('gasolineras', 'Total Malabo',       '⛽', 'Malabo', 1.5),
  ('gasolineras', 'GEPetrol Bata',      '⛽', 'Bata',   1.5),
  -- Seguros
  ('seguros', 'Seguro Auto EG',     '🚗', 'Malabo', 1.5),
  ('seguros', 'Seguro Hogar EG',    '🏠', 'Malabo', 1.5),
  ('seguros', 'Seguro Médico EG',   '🏥', 'Malabo', 1.5),
  ('seguros', 'Seguro Vida EG',     '❤️', 'Malabo', 1.5),
  ('seguros', 'Seguro Viaje EG',    '✈️', 'Malabo', 1.5),
  -- Apuestas
  ('apuestas', '1xBet GQ',      '🎰', 'Malabo', 1.5),
  ('apuestas', 'Bet9ja GQ',     '⚽', 'Malabo', 1.5),
  ('apuestas', 'BetWay GQ',     '🎲', 'Malabo', 1.5),
  -- Barcos
  ('barcos', 'Bioko Express',   '⛵', 'Malabo', 1.5),
  ('barcos', 'Costa Verde',     '⛵', 'Bata',   1.5),
  ('barcos', 'Mongomo Star',    '⛵', 'Malabo', 1.5),
  -- Taxis
  ('taxis', 'EGChat Taxi Malabo', '🚖', 'Malabo', 1.5),
  ('taxis', 'EGChat Taxi Bata',   '🚖', 'Bata',   1.5),
  -- Farmacias
  ('farmacias', 'Farmacia Central GE',   '💊', 'Malabo', 1.5),
  ('farmacias', 'Farmacia Ela Nguema',   '💊', 'Malabo', 1.5),
  ('farmacias', 'Farmacia Santa Isabel', '💊', 'Malabo', 1.5),
  -- Salud / Clínicas
  ('salud', 'Clínica La Paz',           '🏥', 'Malabo', 1.5),
  ('salud', 'Hospital General Malabo',  '🏥', 'Malabo', 1.5),
  ('salud', 'Centro Salud Ela Nguema',  '🏥', 'Malabo', 1.5),
  -- Bancos (comisión sobre operaciones vía app)
  ('bancos', 'BANGE',           '🏦', 'Malabo', 1.5),
  ('bancos', 'BGFI Bank GQ',    '🏦', 'Malabo', 1.5),
  ('bancos', 'CCEI Bank GQ',    '🏦', 'Malabo', 1.5),
  ('bancos', 'Ecobank GQ',      '🏦', 'Malabo', 1.5),
  -- Djangue (grupos de ahorro)
  ('djangue', 'Djangues activos EGChat', '🤝', 'Nacional', 1.5),
  -- Correos / Envíos
  ('correos', 'Correos GQ Nacional',       '📮', 'Nacional', 1.5),
  ('correos', 'Correos GQ Internacional',  '📦', 'Nacional', 1.5),
  -- Ocio
  ('ocio', 'Cine Malabo',     '🎬', 'Malabo', 1.5),
  ('ocio', 'Multicines Bata', '🎬', 'Bata',   1.5)
ON CONFLICT DO NOTHING;

-- ── Datos demo de transacciones (últimos 6 meses) ─────────────────
-- Generar resumen mensual para cada categoría
INSERT INTO revenue_resumen_diario (fecha, categoria, total_bruto, total_comisiones, num_transacciones)
SELECT
  gen_date::DATE,
  cat,
  ROUND((random() * 800000 + 200000)::numeric, 2),
  ROUND((random() * 12000 + 3000)::numeric, 2),
  (random() * 80 + 20)::INT
FROM
  generate_series(
    NOW() - INTERVAL '180 days',
    NOW(),
    INTERVAL '1 day'
  ) AS gen_date,
  UNNEST(ARRAY[
    'restaurantes','vuelos','hoteles','supermercados','gasolineras',
    'seguros','apuestas','barcos','taxis','farmacias','salud',
    'bancos','djangue','correos','ocio'
  ]) AS cat
ON CONFLICT (fecha, categoria) DO NOTHING;
