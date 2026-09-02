-- ══════════════════════════════════════════════════════════════════
-- MÓDULOS 3-5: BUSINESS DASHBOARD + WALLET + MERCHANT
-- ══════════════════════════════════════════════════════════════════

-- Productos del merchant
CREATE TABLE IF NOT EXISTS merchant_products (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  price       NUMERIC(12,2) NOT NULL,
  currency    TEXT DEFAULT 'XAF',
  category    TEXT,
  stock       INT DEFAULT 0,
  images      JSONB DEFAULT '[]',
  status      TEXT DEFAULT 'active' CHECK (status IN ('active','inactive','deleted')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Pedidos
CREATE TABLE IF NOT EXISTS merchant_orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   UUID NOT NULL REFERENCES users(id),
  customer_id   UUID REFERENCES users(id),
  items         JSONB NOT NULL DEFAULT '[]',
  total_amount  NUMERIC(12,2) DEFAULT 0,
  currency      TEXT DEFAULT 'XAF',
  status        TEXT DEFAULT 'pending' CHECK (status IN ('pending','confirmed','preparing','shipped','delivered','cancelled')),
  delivery_addr TEXT,
  notes         TEXT,
  chat_id       UUID REFERENCES chats(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Pagos al merchant
CREATE TABLE IF NOT EXISTS merchant_payouts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  UUID NOT NULL REFERENCES users(id),
  amount       NUMERIC(12,2) NOT NULL,
  currency     TEXT DEFAULT 'XAF',
  bank_account TEXT,
  notes        TEXT,
  status       TEXT DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','rejected')),
  processed_by UUID REFERENCES users(id),
  processed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Transacciones del wallet (extensión de Neon)
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,  -- transfer_in, transfer_out, topup, withdraw, payment
  amount      NUMERIC(12,2) NOT NULL,
  description TEXT,
  status      TEXT DEFAULT 'completed',
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_merchant_products_merchant ON merchant_products(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_merchant_orders_merchant   ON merchant_orders(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_merchant_orders_customer   ON merchant_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_merchant_payouts_merchant  ON merchant_payouts(merchant_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user             ON wallet_transactions(user_id, created_at DESC);
