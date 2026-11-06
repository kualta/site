-- A small picture of each post, kept after its uploads expire so Analytics can still show what the post was.
CREATE TABLE publisher_thumbnails (
  job_id TEXT PRIMARY KEY REFERENCES publisher_jobs(id),
  type TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
