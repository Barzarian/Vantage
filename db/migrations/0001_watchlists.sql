CREATE TABLE IF NOT EXISTS watchlists (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  name text NOT NULL,
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watchlist_items (
  id text PRIMARY KEY,
  watchlist_id text NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  asset_class text NOT NULL,
  position integer NOT NULL,
  note text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS watchlists_user_position_idx ON watchlists(user_id, position);
CREATE INDEX IF NOT EXISTS watchlist_items_list_position_idx ON watchlist_items(watchlist_id, position);

CREATE TABLE IF NOT EXISTS saved_chart_layouts (
  user_id text PRIMARY KEY,
  layout text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saved_chart_indicators (
  user_id text PRIMARY KEY,
  indicators text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saved_watchlist_preferences (
  user_id text PRIMARY KEY,
  preferences text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
