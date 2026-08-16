CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');
CREATE TYPE entry_direction AS ENUM ('debit', 'credit');
CREATE TYPE tx_status AS ENUM ('pending', 'posted', 'failed', 'reversed');

CREATE TABLE accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  type          account_type NOT NULL,
  currency      CHAR(3) NOT NULL,             -- ISO 4217
  allow_negative BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,       -- the dedup guarantee
  status          tx_status NOT NULL DEFAULT 'pending',
  description     TEXT,
  reverses        UUID REFERENCES transactions(id),  -- set on reversal txns
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at       TIMESTAMPTZ
);

CREATE TABLE entries (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES transactions(id),
  account_id     UUID NOT NULL REFERENCES accounts(id),
  direction      entry_direction NOT NULL,
  amount         BIGINT NOT NULL CHECK (amount > 0),  -- paise, never floats
  currency       CHAR(3) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_entries_account ON entries (account_id, created_at);
CREATE INDEX idx_entries_tx ON entries (transaction_id);