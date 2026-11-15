-- Pieces of content on their way to being posted: an idea, then its script, footage and edit, then the post it went out
-- as. The Pipeline tab shows them by stage.
CREATE TABLE publisher_content (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'idea' CHECK (stage IN ('idea','script','footage','edit','posted')),
  -- The post it went out as, when queued from the composer. Cancelling that post unlinks it first.
  job_id TEXT REFERENCES publisher_jobs(id),
  created_at INTEGER NOT NULL,
  -- When it reached its stage, which orders each column.
  stage_at INTEGER NOT NULL
);
CREATE INDEX publisher_content_stage ON publisher_content(stage, stage_at);
