CREATE TABLE publisher_deletions (
  target_id TEXT PRIMARY KEY REFERENCES publisher_targets(id),
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','working','deleted','failed','uncertain')),
  claim TEXT,
  requested_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  message TEXT
);
CREATE INDEX publisher_deletion_queue ON publisher_deletions(state, requested_at);
