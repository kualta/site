-- What went out before the Pipeline existed joins its Posted column, linked to its post. Each piece is named as History
-- names the post, by its title or else its caption's first line, and posted when its first destination finished.
-- A post already linked to a piece keeps that one.
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
WHERE EXISTS (SELECT 1 FROM publisher_targets t WHERE t.job_id = j.id AND t.state = 'succeeded')
  AND NOT EXISTS (SELECT 1 FROM publisher_content c WHERE c.job_id = j.id);
