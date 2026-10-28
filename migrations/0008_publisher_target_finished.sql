-- When each destination's latest attempt ended (published, failed or uncertain).
ALTER TABLE publisher_targets ADD COLUMN finished_at INTEGER;
