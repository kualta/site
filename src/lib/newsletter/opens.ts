import { notifyNewsletter, type WaitUntil } from "./notifications";
import type { NewsletterEnv } from "./types";

export async function recordOpen(env: NewsletterEnv, id: string, at: number, waitUntil?: WaitUntil): Promise<void> {
  const db = env.NEWSLETTER_DB;
  if (!db) return;
  // The conditional write deduplicates pixel loads and provider callbacks, even when concurrent.
  const changed = await db
    .prepare(`UPDATE newsletter_deliveries SET opened_at=?
    WHERE id=? AND opened_at IS NULL AND kind IN ('newsletter','test')
    AND state IN ('sending','sent','unknown') RETURNING subscriber_id,issue_id`)
    .bind(at, id)
    .first<{ subscriber_id: string; issue_id: string }>();
  if (!changed) return;
  const row = await db
    .prepare(`SELECT s.email, i.content FROM newsletter_subscribers s
    JOIN newsletter_issues i ON i.id=? WHERE s.id=?`)
    .bind(changed.issue_id, changed.subscriber_id)
    .first<{ email: string; content: string }>();
  if (!row) return;
  const issue = JSON.parse(row.content) as { title: string };
  await notifyNewsletter(env, "open detected", `${row.email}\nPost: ${issue.title}`, waitUntil);
}
