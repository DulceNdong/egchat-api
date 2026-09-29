-- =============================================
-- EJECUTAR EN: Supabase → SQL Editor
-- Crea la tabla pending_transfers si no existe
-- =============================================

-- 1. Crear tabla
CREATE TABLE IF NOT EXISTS public.pending_transfers (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id     UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  recipient_id  UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  concept       TEXT,
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','completed','cancelled','expired')),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Índices
CREATE INDEX IF NOT EXISTS idx_pt_recipient ON public.pending_transfers(recipient_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pt_sender    ON public.pending_transfers(sender_id)    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pt_expires   ON public.pending_transfers(expires_at)   WHERE status = 'pending';

-- 3. RLS
ALTER TABLE public.pending_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pending_transfers_own" ON public.pending_transfers;
CREATE POLICY "pending_transfers_own" ON public.pending_transfers
  FOR ALL
  USING (auth.uid() = sender_id OR auth.uid() = recipient_id)
  WITH CHECK (auth.uid() = sender_id OR auth.uid() = recipient_id);
