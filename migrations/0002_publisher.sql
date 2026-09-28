CREATE TABLE publisher_helper (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token_hash TEXT NOT NULL,
  last_seen INTEGER,
  platforms TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE publisher_media (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'video')),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  job_id TEXT
);
CREATE TABLE publisher_jobs (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE publisher_targets (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES publisher_jobs(id),
  platform TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','working','succeeded','failed','uncertain')),
  claim TEXT,
  started_at INTEGER,
  message TEXT,
  url TEXT,
  UNIQUE(job_id, platform)
);
CREATE INDEX publisher_queue ON publisher_targets(state, started_at);

CREATE TRIGGER publisher_media_single_job BEFORE UPDATE OF job_id ON publisher_media
WHEN OLD.job_id IS NOT NULL AND OLD.job_id != NEW.job_id
BEGIN SELECT RAISE(ABORT, 'Media already queued'); END;
