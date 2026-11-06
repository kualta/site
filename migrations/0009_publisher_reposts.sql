-- A post can hold more than one publication on a platform, such as a repost on a new account beside the original, so
-- their stats add up. SQLite drops UNIQUE(job_id, platform) only by rebuilding the table. The tables that refer to it
-- are set aside first, so dropping it leaves no reference behind for the commit's foreign key check to fail on.
CREATE TABLE publisher_targets_old AS SELECT rowid AS position, * FROM publisher_targets;
CREATE TABLE publisher_metric_checks_old AS SELECT * FROM publisher_metric_checks;
CREATE TABLE publisher_metric_snapshots_old AS SELECT * FROM publisher_metric_snapshots;
CREATE TABLE publisher_deletions_old AS SELECT * FROM publisher_deletions;
DROP TABLE publisher_deletions;
DROP TABLE publisher_metric_snapshots;
DROP TABLE publisher_metric_checks;
DROP TABLE publisher_targets;

CREATE TABLE publisher_targets (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES publisher_jobs(id),
  platform TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','working','succeeded','failed','uncertain')),
  claim TEXT,
  started_at INTEGER,
  message TEXT,
  url TEXT,
  finished_at INTEGER,
  -- Published by the owner outside the helper and linked to the post by its URL.
  linked INTEGER NOT NULL DEFAULT 0 CHECK (linked IN (0,1))
);
-- Queues and history read targets in rowid order, so it carries over.
INSERT INTO publisher_targets (rowid, id, job_id, platform, state, claim, started_at, message, url, finished_at)
SELECT position, id, job_id, platform, state, claim, started_at, message, url, finished_at FROM publisher_targets_old;
CREATE INDEX publisher_queue ON publisher_targets(state, started_at);
CREATE INDEX publisher_job_targets ON publisher_targets(job_id, platform);

CREATE TABLE publisher_metric_checks (
  target_id TEXT PRIMARY KEY REFERENCES publisher_targets(id),
  claim TEXT,
  next_at INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER,
  message TEXT
);
INSERT INTO publisher_metric_checks SELECT * FROM publisher_metric_checks_old;
CREATE INDEX publisher_metric_due ON publisher_metric_checks(next_at);

CREATE TABLE publisher_metric_snapshots (
  target_id TEXT NOT NULL REFERENCES publisher_targets(id),
  observed_at INTEGER NOT NULL,
  metrics TEXT NOT NULL,
  PRIMARY KEY(target_id, observed_at)
);
INSERT INTO publisher_metric_snapshots SELECT * FROM publisher_metric_snapshots_old;

CREATE TABLE publisher_deletions (
  target_id TEXT PRIMARY KEY REFERENCES publisher_targets(id),
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','working','deleted','failed','uncertain')),
  claim TEXT,
  requested_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  message TEXT
);
INSERT INTO publisher_deletions SELECT * FROM publisher_deletions_old;
CREATE INDEX publisher_deletion_queue ON publisher_deletions(state, requested_at);

-- Created after the copies, so restoring the targets doesn't queue a second metrics check for each.
CREATE TRIGGER publisher_metrics_after_publish AFTER UPDATE OF state,url ON publisher_targets
WHEN NEW.state='succeeded' AND NEW.url IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO publisher_metric_checks(target_id) VALUES(NEW.id);
END;
CREATE TRIGGER publisher_metrics_after_insert AFTER INSERT ON publisher_targets
WHEN NEW.state='succeeded' AND NEW.url IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO publisher_metric_checks(target_id) VALUES(NEW.id);
END;

DROP TABLE publisher_targets_old;
DROP TABLE publisher_metric_checks_old;
DROP TABLE publisher_metric_snapshots_old;
DROP TABLE publisher_deletions_old;
