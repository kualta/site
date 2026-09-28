ALTER TABLE publisher_helper ADD COLUMN public_key TEXT;
CREATE TABLE publisher_connections (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('connect','disconnect')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','working','succeeded','failed','cancelled')),
  payload TEXT,
  claim TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  message TEXT
);
CREATE UNIQUE INDEX publisher_one_connection ON publisher_connections((1)) WHERE state IN ('queued','working');
