-- When a destination publishes, in ms; NULL publishes at once. The helper claims a queued destination only once its
-- time has come.
ALTER TABLE publisher_targets ADD COLUMN scheduled_at INTEGER;
