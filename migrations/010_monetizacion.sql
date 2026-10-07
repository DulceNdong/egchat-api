-- ============================================================
-- EGCHAT MONETIZACIÓN - Setup completo de base de datos
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- Drop tablas con columnas generadas problemáticas (las recrea sin GENERATED ALWAYS AS)
DROP TABLE IF EXISTS historial_transacciones_negocios CASCADE;
DROP TABLE IF EXISTS historial_transacciones_usuarios CASCADE;
DROP TABLE IF EXISTS monetizacion_wallet_movimientos CASCADE;
DROP TABLE IF EXISTS monetizacion_billetes CASCADE;
DROP TABLE IF EXISTS monetizacion_taxista_viajes CASCADE;

-- -------------------------
-- 1. EMPRESAS DE SERVICIOS
-- -------------------------
CREATE TABLE IF NOT EXISTS monetizacion_empresas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nombre TEXT NOT NULL,
  responsable TEXT NOT NULL,
  email TEXT,
  telefono TEXT,
  tipo_servicio TEXT DEFAULT 'general',
  cuota_mensual DECIMAL(12,2) NOT NULL DEFAULT 0,
  comision_pct DECIMAL(5,2) NOT NULL DEFAULT 1.5,
  total_ventas_mes DECIMAL(12,2) DEFAULT 0,
  estado_pago TEXT DEFAULT 'pendiente',
  activa BOOLEAN DEFAULT true,
  fecha_registro TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS monetizacion_empresa_ingresos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id UUID REFERENCES monetizacion_empresas(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  monto DECIMAL(12,2) NOT NULL,
  descripcion TEXT,
  mes INT NOT NULL,
  anio INT NOT NULL,
  fecha TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- -------------------------
-- 2. TAXIS
-- -------------------------
CREATE TABLE IF NOT EXISTS monetizacion_taxistas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  nombre TEXT NOT NULL,
  apellido TEXT NOT NULL,
  telefono TEXT,
  num_licencia TEXT NOT NULL UNIQUE,
  num_matricula TEXT,
  marca_vehiculo TEXT,
  modelo_vehiculo TEXT,
  anio_vehiculo INT,
  color_vehiculo TEXT,
  foto_url TEXT,
  fecha_venc_carnet DATE,
  fecha_venc_seguro DATE,
  fecha_venc_revision_tecnica DATE,
  fecha_venc_permiso_operacion DATE,
  total_viajes_mes INT DEFAULT 0,
  horas_activo_mes DECIMAL(8,2) DEFAULT 0,
  activo BOOLEAN DEFAULT true,
  verificado BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sin GENERATED ALWAYS AS — mes/anio se insertan explícitamente
CREATE TABLE IF NOT EXISTS monetizacion_taxista_viajes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  taxista_id UUID REFERENCES monetizacion_taxistas(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  origen TEXT,
  destino TEXT,
  distancia_km DECIMAL(8,2),
  duracion_min INT,
  monto_viaje DECIMAL(12,2) NOT NULL,
  comision_pct DECIMAL(5,2) DEFAULT 5.0,
  comision_monto DECIMAL(12,2) DEFAULT 0,
  estado TEXT DEFAULT 'completado',
  mes INT,
  anio INT,
  fecha TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger para calcular comision_monto y mes/anio automáticamente
CREATE OR REPLACE FUNCTION trg_taxista_viaje_before()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.comision_monto := NEW.monto_viaje * NEW.comision_pct / 100;
  NEW.mes  := EXTRACT(MONTH FROM NEW.fecha)::INT;
  NEW.anio := EXTRACT(YEAR  FROM NEW.fecha)::INT;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_taxista_viaje ON monetizacion_taxista_viajes;
CREATE TRIGGER trg_taxista_viaje
  BEFORE INSERT OR UPDATE ON monetizacion_taxista_viajes
  FOR EACH ROW EXECUTE FUNCTION trg_taxista_viaje_before();

CREATE TABLE IF NOT EXISTS monetizacion_taxista_horas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  taxista_id UUID REFERENCES monetizacion_taxistas(id) ON DELETE CASCADE,
  fecha DATE NOT NULL,
  horas DECIMAL(5,2) NOT NULL,
  inicio TIMESTAMPTZ,
  fin TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- -------------------------
-- 3. BARCOS
-- -------------------------
CREATE TABLE IF NOT EXISTS monetizacion_barcos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nombre_operador TEXT NOT NULL,
  nombre_barco TEXT NOT NULL,
  matricula TEXT UNIQUE,
  ruta TEXT NOT NULL,
  origen TEXT,
  destino TEXT,
  capacidad_pasajeros INT DEFAULT 0,
  precio_billete_base DECIMAL(12,2) DEFAULT 0,
  horario TEXT,
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS monetizacion_billetes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  barco_id UUID REFERENCES monetizacion_barcos(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  num_pasajeros INT DEFAULT 1,
  monto_total DECIMAL(12,2) NOT NULL,
  comision_pct DECIMAL(5,2) DEFAULT 1.0,
  comision_monto DECIMAL(12,2) DEFAULT 0,
  fecha_viaje DATE,
  estado TEXT DEFAULT 'vendido',
  referencia TEXT,
  mes INT,
  anio INT,
  fecha TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION trg_billete_before()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.comision_monto := NEW.monto_total * NEW.comision_pct / 100;
  NEW.mes  := EXTRACT(MONTH FROM NEW.fecha)::INT;
  NEW.anio := EXTRACT(YEAR  FROM NEW.fecha)::INT;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billete ON monetizacion_billetes;
CREATE TRIGGER trg_billete
  BEFORE INSERT OR UPDATE ON monetizacion_billetes
  FOR EACH ROW EXECUTE FUNCTION trg_billete_before();

-- -------------------------
-- 4. MONEDERO
-- -------------------------
CREATE TABLE IF NOT EXISTS monetizacion_wallet_movimientos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  monto DECIMAL(12,2) NOT NULL,
  comision_pct DECIMAL(5,2) DEFAULT 0.5,
  comision_monto DECIMAL(12,2) DEFAULT 0,
  banco TEXT,
  referencia TEXT,
  estado TEXT DEFAULT 'completado',
  mes INT,
  anio INT,
  fecha TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION trg_wallet_before()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.comision_monto := NEW.monto * NEW.comision_pct / 100;
  NEW.mes  := EXTRACT(MONTH FROM NEW.fecha)::INT;
  NEW.anio := EXTRACT(YEAR  FROM NEW.fecha)::INT;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet ON monetizacion_wallet_movimientos;
CREATE TRIGGER trg_wallet
  BEFORE INSERT OR UPDATE ON monetizacion_wallet_movimientos
  FOR EACH ROW EXECUTE FUNCTION trg_wallet_before();

-- -------------------------
-- 5. RESUMEN MENSUAL
-- -------------------------
CREATE TABLE IF NOT EXISTS monetizacion_resumen_mensual (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  categoria TEXT NOT NULL,
  mes INT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  anio INT NOT NULL,
  total_comisiones DECIMAL(12,2) DEFAULT 0,
  total_cuotas DECIMAL(12,2) DEFAULT 0,
  total_ingresos DECIMAL(12,2) DEFAULT 0,
  num_transacciones INT DEFAULT 0,
  actualizado_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(categoria, mes, anio)
);

-- -------------------------
-- 6. PERFILES FINANCIEROS USUARIOS
-- -------------------------
CREATE TABLE IF NOT EXISTS perfiles_financieros_usuarios (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  nombre_completo TEXT,
  score_financiero INT DEFAULT 0 CHECK (score_financiero BETWEEN 0 AND 100),
  total_movido DECIMAL(14,2) DEFAULT 0,
  num_transacciones INT DEFAULT 0,
  monto_promedio_mensual DECIMAL(12,2) DEFAULT 0,
  meses_activo INT DEFAULT 0,
  usa_taxi BOOLEAN DEFAULT false,
  usa_barcos BOOLEAN DEFAULT false,
  usa_servicios BOOLEAN DEFAULT false,
  usa_wallet BOOLEAN DEFAULT false,
  primera_transaccion TIMESTAMPTZ,
  ultima_transaccion TIMESTAMPTZ,
  ultima_actualizacion TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS historial_transacciones_usuarios (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  referencia_id UUID,
  descripcion TEXT,
  monto DECIMAL(12,2) NOT NULL,
  estado TEXT DEFAULT 'completado',
  mes INT,
  anio INT,
  fecha TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION trg_historial_usuario_before()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.mes  := EXTRACT(MONTH FROM NEW.fecha)::INT;
  NEW.anio := EXTRACT(YEAR  FROM NEW.fecha)::INT;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_historial_usuario ON historial_transacciones_usuarios;
CREATE TRIGGER trg_historial_usuario
  BEFORE INSERT OR UPDATE ON historial_transacciones_usuarios
  FOR EACH ROW EXECUTE FUNCTION trg_historial_usuario_before();

-- -------------------------
-- 7. PERFILES FINANCIEROS NEGOCIOS
-- -------------------------
CREATE TABLE IF NOT EXISTS perfiles_financieros_negocios (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id UUID REFERENCES monetizacion_empresas(id) ON DELETE CASCADE UNIQUE,
  razon_social TEXT NOT NULL,
  nif TEXT,
  sector TEXT,
  score_financiero INT DEFAULT 0 CHECK (score_financiero BETWEEN 0 AND 100),
  facturacion_mensual_promedio DECIMAL(12,2) DEFAULT 0,
  facturacion_total DECIMAL(14,2) DEFAULT 0,
  meses_operacion INT DEFAULT 0,
  num_transacciones_total INT DEFAULT 0,
  servicios_activos TEXT[],
  ultima_actualizacion TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS historial_transacciones_negocios (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id UUID REFERENCES monetizacion_empresas(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  descripcion TEXT,
  monto DECIMAL(12,2) NOT NULL,
  comision DECIMAL(12,2) DEFAULT 0,
  estado TEXT DEFAULT 'completado',
  mes INT,
  anio INT,
  fecha TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION trg_historial_negocio_before()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.mes  := EXTRACT(MONTH FROM NEW.fecha)::INT;
  NEW.anio := EXTRACT(YEAR  FROM NEW.fecha)::INT;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_historial_negocio ON historial_transacciones_negocios;
CREATE TRIGGER trg_historial_negocio
  BEFORE INSERT OR UPDATE ON historial_transacciones_negocios
  FOR EACH ROW EXECUTE FUNCTION trg_historial_negocio_before();

-- ============================================================
-- VISTAS
-- ============================================================

CREATE OR REPLACE VIEW v_ingresos_mensuales AS
SELECT
  mes, anio,
  SUM(total_ingresos) AS total_general,
  SUM(CASE WHEN categoria = 'empresas' THEN total_ingresos ELSE 0 END) AS ingresos_empresas,
  SUM(CASE WHEN categoria = 'taxis'    THEN total_ingresos ELSE 0 END) AS ingresos_taxis,
  SUM(CASE WHEN categoria = 'barcos'   THEN total_ingresos ELSE 0 END) AS ingresos_barcos,
  SUM(CASE WHEN categoria = 'wallet'   THEN total_ingresos ELSE 0 END) AS ingresos_wallet
FROM monetizacion_resumen_mensual
GROUP BY mes, anio
ORDER BY anio DESC, mes DESC;

CREATE OR REPLACE VIEW v_taxistas_documentacion AS
SELECT
  t.*,
  CASE
    WHEN t.fecha_venc_carnet < CURRENT_DATE THEN 'vencido'
    WHEN t.fecha_venc_carnet < CURRENT_DATE + INTERVAL '30 days' THEN 'proximo'
    ELSE 'vigente'
  END AS estado_carnet,
  CASE
    WHEN t.fecha_venc_seguro < CURRENT_DATE THEN 'vencido'
    WHEN t.fecha_venc_seguro < CURRENT_DATE + INTERVAL '30 days' THEN 'proximo'
    ELSE 'vigente'
  END AS estado_seguro,
  CASE
    WHEN t.fecha_venc_revision_tecnica < CURRENT_DATE THEN 'vencido'
    WHEN t.fecha_venc_revision_tecnica < CURRENT_DATE + INTERVAL '30 days' THEN 'proximo'
    ELSE 'vigente'
  END AS estado_revision,
  COALESCE(SUM(v.comision_monto), 0) AS comisiones_mes_actual
FROM monetizacion_taxistas t
LEFT JOIN monetizacion_taxista_viajes v
  ON v.taxista_id = t.id
  AND v.mes  = EXTRACT(MONTH FROM CURRENT_DATE)::INT
  AND v.anio = EXTRACT(YEAR  FROM CURRENT_DATE)::INT
GROUP BY t.id;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE monetizacion_empresas              ENABLE ROW LEVEL SECURITY;
ALTER TABLE monetizacion_empresa_ingresos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE monetizacion_taxistas              ENABLE ROW LEVEL SECURITY;
ALTER TABLE monetizacion_taxista_viajes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE monetizacion_taxista_horas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE monetizacion_barcos                ENABLE ROW LEVEL SECURITY;
ALTER TABLE monetizacion_billetes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE monetizacion_wallet_movimientos    ENABLE ROW LEVEL SECURITY;
ALTER TABLE monetizacion_resumen_mensual       ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfiles_financieros_usuarios      ENABLE ROW LEVEL SECURITY;
ALTER TABLE perfiles_financieros_negocios      ENABLE ROW LEVEL SECURITY;
ALTER TABLE historial_transacciones_usuarios   ENABLE ROW LEVEL SECURITY;
ALTER TABLE historial_transacciones_negocios   ENABLE ROW LEVEL SECURITY;

-- Limpiar policies previas (idempotente)
DROP POLICY IF EXISTS "admin_monetizacion_empresas"    ON monetizacion_empresas;
DROP POLICY IF EXISTS "admin_monetizacion_taxistas"    ON monetizacion_taxistas;
DROP POLICY IF EXISTS "admin_monetizacion_barcos"      ON monetizacion_barcos;
DROP POLICY IF EXISTS "admin_monetizacion_resumen"     ON monetizacion_resumen_mensual;
DROP POLICY IF EXISTS "admin_taxista_viajes"           ON monetizacion_taxista_viajes;
DROP POLICY IF EXISTS "admin_billetes"                 ON monetizacion_billetes;
DROP POLICY IF EXISTS "admin_wallet"                   ON monetizacion_wallet_movimientos;
DROP POLICY IF EXISTS "admin_perfiles_usuarios"        ON perfiles_financieros_usuarios;
DROP POLICY IF EXISTS "admin_perfiles_negocios"        ON perfiles_financieros_negocios;
DROP POLICY IF EXISTS "admin_historial_usuarios"       ON historial_transacciones_usuarios;
DROP POLICY IF EXISTS "admin_historial_negocios"       ON historial_transacciones_negocios;
DROP POLICY IF EXISTS "admin_empresa_ingresos"         ON monetizacion_empresa_ingresos;
DROP POLICY IF EXISTS "admin_taxista_horas"            ON monetizacion_taxista_horas;
DROP POLICY IF EXISTS "user_own_historial"             ON historial_transacciones_usuarios;
DROP POLICY IF EXISTS "user_own_perfil"                ON perfiles_financieros_usuarios;
DROP POLICY IF EXISTS "user_own_wallet"                ON monetizacion_wallet_movimientos;
DROP POLICY IF EXISTS "taxista_own_viajes"             ON monetizacion_taxista_viajes;

-- Admin full access
CREATE POLICY "admin_monetizacion_empresas" ON monetizacion_empresas
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
CREATE POLICY "admin_monetizacion_taxistas" ON monetizacion_taxistas
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
CREATE POLICY "admin_monetizacion_barcos" ON monetizacion_barcos
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
CREATE POLICY "admin_monetizacion_resumen" ON monetizacion_resumen_mensual
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
CREATE POLICY "admin_taxista_viajes" ON monetizacion_taxista_viajes
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
CREATE POLICY "admin_billetes" ON monetizacion_billetes
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
CREATE POLICY "admin_wallet" ON monetizacion_wallet_movimientos
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
CREATE POLICY "admin_perfiles_usuarios" ON perfiles_financieros_usuarios
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
CREATE POLICY "admin_perfiles_negocios" ON perfiles_financieros_negocios
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
CREATE POLICY "admin_historial_usuarios" ON historial_transacciones_usuarios
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
CREATE POLICY "admin_historial_negocios" ON historial_transacciones_negocios
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
CREATE POLICY "admin_empresa_ingresos" ON monetizacion_empresa_ingresos
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
CREATE POLICY "admin_taxista_horas" ON monetizacion_taxista_horas
  FOR ALL USING ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');

-- Usuarios ven su propio historial y perfil
CREATE POLICY "user_own_historial" ON historial_transacciones_usuarios
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "user_own_perfil" ON perfiles_financieros_usuarios
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "user_own_wallet" ON monetizacion_wallet_movimientos
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "taxista_own_viajes" ON monetizacion_taxista_viajes
  FOR SELECT USING (
    taxista_id IN (SELECT id FROM monetizacion_taxistas WHERE user_id = auth.uid())
  );

-- ============================================================
-- DATOS DEMO
-- ============================================================

INSERT INTO monetizacion_empresas (nombre, responsable, email, tipo_servicio, cuota_mensual, comision_pct, estado_pago) VALUES
  ('Supermercados BM Malabo',     'Carlos Ngema',  'c.ngema@bm.gq',        'supermercado',       150000, 1.5, 'pagado'),
  ('Farmacia Central GE',         'María Esono',   'm.esono@farmacia.gq',   'farmacia',            80000, 1.5, 'pagado'),
  ('Restaurante El Patio',        'José Mba',      'j.mba@elpatio.gq',      'restaurante',         60000, 1.5, 'pendiente'),
  ('Hotel Paraíso Bioko',         'Ana Nze',       'a.nze@hotel.gq',        'hotel',              200000, 1.5, 'pagado'),
  ('Telecomunicaciones GETESA',   'Pedro Abeso',   'p.abeso@getesa.gq',     'telecomunicaciones', 500000, 1.5, 'pagado'),
  ('Clínica San Carlos',          'Dr. Nguema',    'dr.nguema@clinica.gq',  'salud',              120000, 1.5, 'vencido'),
  ('Agencia Viajes Bioko',        'Rosa Eyama',    'r.eyama@bioko.gq',      'viajes',              90000, 1.5, 'pendiente')
ON CONFLICT DO NOTHING;

INSERT INTO monetizacion_resumen_mensual (categoria, mes, anio, total_comisiones, total_cuotas, total_ingresos, num_transacciones) VALUES
  ('empresas', 9, 2026, 245000, 1200000, 1445000, 342),
  ('taxis',    9, 2026, 387000,       0,  387000, 1240),
  ('barcos',   9, 2026, 156000,       0,  156000,   89),
  ('wallet',   9, 2026,  78500,       0,   78500, 2100),
  ('empresas', 8, 2026, 230000, 1200000, 1430000, 318),
  ('taxis',    8, 2026, 360000,       0,  360000, 1150),
  ('barcos',   8, 2026, 142000,       0,  142000,   81),
  ('wallet',   8, 2026,  72000,       0,   72000, 1950),
  ('empresas', 7, 2026, 210000, 1200000, 1410000, 295),
  ('taxis',    7, 2026, 340000,       0,  340000, 1090),
  ('barcos',   7, 2026, 130000,       0,  130000,   74),
  ('wallet',   7, 2026,  65000,       0,   65000, 1780),
  ('empresas', 6, 2026, 200000, 1200000, 1400000, 278),
  ('taxis',    6, 2026, 320000,       0,  320000, 1020),
  ('barcos',   6, 2026, 122000,       0,  122000,   68),
  ('wallet',   6, 2026,  61000,       0,   61000, 1620),
  ('empresas', 5, 2026, 188000, 1200000, 1388000, 260),
  ('taxis',    5, 2026, 298000,       0,  298000,  955),
  ('barcos',   5, 2026, 112000,       0,  112000,   62),
  ('wallet',   5, 2026,  56000,       0,   56000, 1490),
  ('empresas', 4, 2026, 175000, 1200000, 1375000, 241),
  ('taxis',    4, 2026, 278000,       0,  278000,  891),
  ('barcos',   4, 2026, 105000,       0,  105000,   58),
  ('wallet',   4, 2026,  52000,       0,   52000, 1380)
ON CONFLICT (categoria, mes, anio) DO NOTHING;

INSERT INTO monetizacion_barcos (nombre_operador, nombre_barco, matricula, ruta, origen, destino, capacidad_pasajeros, precio_billete_base, activo) VALUES
  ('Naviera Bioko S.A.',           'Bioko Express', 'GQ-001-MBO', 'Malabo → Bata',    'Malabo', 'Bata',    120, 45000, true),
  ('Transportes del Litoral',      'Costa Verde',   'GQ-002-BTA', 'Bata → Malabo',    'Bata',   'Malabo',   90, 45000, true),
  ('Naviera Guinea Ecuatorial',    'Mongomo Star',  'GQ-003-MBO', 'Malabo → Annobon', 'Malabo', 'Annobon',  60, 80000, true),
  ('Servicios Marítimos GE',       'Litoral GE',    'GQ-004-BTA', 'Bata → Cogo',      'Bata',   'Cogo',     45, 20000, false)
ON CONFLICT (matricula) DO NOTHING;
