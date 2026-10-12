CREATE TABLE IF NOT EXISTS saved_futures_preferences (
  user_id TEXT PRIMARY KEY,
  preferences TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
