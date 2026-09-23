-- Migration 009: pending_transfers table
-- Transfers require receiver acceptance before money is released

CREATE TABLE IF NOT EXISTS pending_transfers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  concept       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','completed','cancelled','expired')),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_transfers_recipient ON pending_transfers(recipient_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pending_transfers_sender    ON pending_transfers(sender_id)    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pending_transfers_expires   ON pending_transfers(expires_at)   WHERE status = 'pending';

-- Auto-expire: mark as expired when expires_at is passed (run via cron or on-read)
-- This index supports fast cleanup queries
