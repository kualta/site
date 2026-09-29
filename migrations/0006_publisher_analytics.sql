CREATE TABLE publisher_metric_checks (
  target_id TEXT PRIMARY KEY REFERENCES publisher_targets(id),
  claim TEXT,
  next_at INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER,
  message TEXT
);
CREATE INDEX publisher_metric_due ON publisher_metric_checks(next_at);
CREATE TABLE publisher_metric_snapshots (
  target_id TEXT NOT NULL REFERENCES publisher_targets(id),
  observed_at INTEGER NOT NULL,
  metrics TEXT NOT NULL,
  PRIMARY KEY(target_id, observed_at)
);
INSERT INTO publisher_metric_checks(target_id)
SELECT id FROM publisher_targets WHERE state='succeeded' AND url IS NOT NULL;
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
