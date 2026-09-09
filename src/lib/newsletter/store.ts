import type { Delivery, NewsletterDB, Subscriber } from "./types";

export function subscriber(db: NewsletterDB, id: string): Promise<Subscriber | null> {
  return db.prepare("SELECT * FROM newsletter_subscribers WHERE id = ?").bind(id).first<Subscriber>();
}
export async function rateLimit(
  db: NewsletterDB,
  key: string,
  limit: number,
  seconds: number,
  now: number,
): Promise<boolean> {
  const bucket = `${key}:${Math.floor(now / seconds)}`;
  const row = await db
    .prepare(`INSERT INTO newsletter_rate_limits(key,count,expires_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`)
    .bind(bucket, now + seconds)
    .first<{ count: number }>();
  return !!row && row.count <= limit;
}
export async function applyFeedback(db: NewsletterDB, providerId: string): Promise<void> {
  await db.batch([
    db
      .prepare(`UPDATE newsletter_deliveries SET
      delivered_at = COALESCE(delivered_at,(SELECT occurred_at FROM newsletter_feedback WHERE provider_id=? AND type='delivery')),
      opened_at = COALESCE(opened_at,(SELECT occurred_at FROM newsletter_feedback WHERE provider_id=? AND type='open')),
      clicked_at = COALESCE(clicked_at,(SELECT occurred_at FROM newsletter_feedback WHERE provider_id=? AND type='click')),
      bounced_at = COALESCE(bounced_at,(SELECT occurred_at FROM newsletter_feedback WHERE provider_id=? AND type='bounce')),
      complained_at = COALESCE(complained_at,(SELECT occurred_at FROM newsletter_feedback WHERE provider_id=? AND type='complaint'))
      WHERE provider_id=?`)
      .bind(providerId, providerId, providerId, providerId, providerId, providerId),
    db
      .prepare(`UPDATE newsletter_subscribers SET status='suppressed', confirmation_hash=NULL,
      suppression_reason=CASE WHEN EXISTS(SELECT 1 FROM newsletter_feedback WHERE provider_id=? AND type='complaint') THEN 'complaint' ELSE 'bounce' END
      WHERE id=(SELECT subscriber_id FROM newsletter_deliveries WHERE provider_id=?)
      AND EXISTS(SELECT 1 FROM newsletter_feedback WHERE provider_id=? AND (type='complaint' OR (type='bounce' AND permanent=1)))`)
      .bind(providerId, providerId, providerId),
  ]);
}
export async function delivery(db: NewsletterDB, id: string): Promise<Delivery | null> {
  return db.prepare("SELECT * FROM newsletter_deliveries WHERE id=?").bind(id).first<Delivery>();
}
