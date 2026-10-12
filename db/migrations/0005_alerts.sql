CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('equity', 'option', 'future', 'portfolio')),
  condition JSONB NOT NULL,
  trigger_mode TEXT NOT NULL DEFAULT 'every-cross' CHECK (trigger_mode IN ('once', 'every-cross', 'cooldown')),
  cooldown_seconds INTEGER NOT NULL DEFAULT 300 CHECK (cooldown_seconds BETWEEN 30 AND 604800),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  only_regular_hours BOOLEAN NOT NULL DEFAULT FALSE,
  max_jump_percent NUMERIC NOT NULL DEFAULT 20 CHECK (max_jump_percent > 0 AND max_jump_percent <= 1000),
  evaluation_state JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_triggered_at TIMESTAMPTZ,
  last_evaluated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS alerts_user_active_idx ON alerts(user_id, active);
CREATE INDEX IF NOT EXISTS alerts_symbol_active_idx ON alerts(symbol, active);

CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  trigger_value NUMERIC,
  summary TEXT NOT NULL,
  delivery_results JSONB NOT NULL DEFAULT '{}'::JSONB,
  read_at TIMESTAMPTZ,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(alert_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS alert_events_user_time_idx ON alert_events(user_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS alert_events_user_unread_idx ON alert_events(user_id, read_at);

CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('in-app', 'email', 'push', 'webhook')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  encrypted_config TEXT,
  label TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, type)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  encrypted_subscription TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, endpoint_hash)
);
