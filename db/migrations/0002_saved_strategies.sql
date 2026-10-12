CREATE TABLE IF NOT EXISTS saved_strategies (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  name text NOT NULL,
  legs text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_strategies_user_created_idx
  ON saved_strategies(user_id, created_at DESC);
