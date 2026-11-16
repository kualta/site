-- Queueing a post now gives it a piece in the Pipeline's Posted column. This gives one to each post queued before
-- that without a piece, as 0013 did: named as History names it, and posted when its first destination finished.
INSERT INTO publisher_content (id, title, notes, stage, job_id, created_at, stage_at)
SELECT
  j.id,
  COALESCE(
    NULLIF(trim(json_extract(j.payload, '$.title'), char(32, 9, 10, 13)), ''),
    NULLIF(substr(substr(caption, 1, instr(caption || char(10), char(10)) - 1), 1, 80), ''),
    'Untitled'
  ),
  '',
  'posted',
  j.id,
  j.created_at,
  COALESCE(
    (SELECT MIN(COALESCE(t.finished_at, t.started_at)) FROM publisher_targets t WHERE t.job_id = j.id AND t.state = 'succeeded'),
    j.created_at
  )
FROM (
  SELECT id, payload, created_at, trim(COALESCE(json_extract(payload, '$.caption'), ''), char(32, 9, 10, 13)) AS caption
  FROM publisher_jobs
) j
WHERE NOT EXISTS (SELECT 1 FROM publisher_content c WHERE c.job_id = j.id);
