CREATE TABLE newsletter_subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL CHECK(status IN ('pending','active','unsubscribed','suppressed')),
  source TEXT NOT NULL DEFAULT 'signup',
  consent_at INTEGER,
  confirmed_at INTEGER,
  unsubscribed_at INTEGER,
  suppression_reason TEXT,
  created_at INTEGER NOT NULL,
  confirmation_hash TEXT,
  confirmation_expires INTEGER,
  confirmation_sent_at INTEGER
);
CREATE INDEX newsletter_subscribers_status ON newsletter_subscribers(status);
CREATE UNIQUE INDEX newsletter_confirmation_hash ON newsletter_subscribers(confirmation_hash);
CREATE TABLE newsletter_issues (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE newsletter_deliveries (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL REFERENCES newsletter_subscribers(id),
  issue_id TEXT REFERENCES newsletter_issues(id),
  kind TEXT NOT NULL CHECK(kind IN ('confirmation','newsletter','test')),
  state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','failed','unknown','skipped')),
  provider TEXT NOT NULL DEFAULT 'plunk',
  provider_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  attempted_at INTEGER,
  sent_at INTEGER,
  delivered_at INTEGER,
  opened_at INTEGER,
  clicked_at INTEGER,
  bounced_at INTEGER,
  complained_at INTEGER,
  error_code TEXT,
  UNIQUE(issue_id, subscriber_id, kind)
);
CREATE INDEX newsletter_delivery_pending ON newsletter_deliveries(issue_id,state);
CREATE INDEX newsletter_delivery_subscriber ON newsletter_deliveries(subscriber_id,created_at);
-- Persist feedback even when it races the send response. No raw payloads/addresses.
CREATE TABLE newsletter_feedback (
  provider_id TEXT NOT NULL,
  type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  permanent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(provider_id,type)
);
CREATE TABLE newsletter_rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
