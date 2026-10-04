-- Coordination metadata only; no subscriber or activity content.
CREATE TABLE IF NOT EXISTS activity_refresh (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  minute INTEGER NOT NULL
);
