CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'USD',
  fx_rates TEXT NOT NULL DEFAULT '{}',
  cash_balance NUMERIC NOT NULL DEFAULT 0,
  lot_method TEXT NOT NULL DEFAULT 'fifo' CHECK (lot_method IN ('fifo', 'lifo', 'average')),
  expiry_warning_days INTEGER NOT NULL DEFAULT 7 CHECK (expiry_warning_days >= 0),
  concentration_threshold NUMERIC NOT NULL DEFAULT 0.25,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_uidx ON accounts(user_id);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('equity', 'option', 'future')),
  kind TEXT NOT NULL DEFAULT 'trade' CHECK (kind IN ('trade', 'split', 'dividend', 'option-outcome')),
  side TEXT CHECK (side IN ('buy', 'sell')),
  quantity NUMERIC,
  price NUMERIC,
  fees NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  executed_at TIMESTAMPTZ NOT NULL,
  open_close TEXT CHECK (open_close IN ('open', 'close')),
  notes TEXT NOT NULL DEFAULT '',
  ratio_numerator NUMERIC,
  ratio_denominator NUMERIC,
  amount_per_share NUMERIC,
  disposition TEXT CHECK (disposition IN ('active', 'expired', 'assigned', 'exercised')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS transactions_account_time_idx ON transactions(account_id, executed_at, id);

CREATE TABLE IF NOT EXISTS transaction_audit (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  before TEXT,
  after TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS transaction_audit_account_time_idx ON transaction_audit(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  market_value NUMERIC NOT NULL,
  realized_pnl NUMERIC NOT NULL,
  unrealized_pnl NUMERIC NOT NULL,
  delta NUMERIC NOT NULL DEFAULT 0,
  gamma NUMERIC NOT NULL DEFAULT 0,
  theta NUMERIC NOT NULL DEFAULT 0,
  vega NUMERIC NOT NULL DEFAULT 0,
  UNIQUE(account_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS saved_positions_preferences (
  user_id TEXT PRIMARY KEY,
  preferences TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
