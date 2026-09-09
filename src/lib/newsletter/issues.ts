import { plunkSender, SendError } from "./plunk";
import { renderIssue } from "./render";
import { digest, record } from "./security";
import { applyFeedback, subscriber } from "./store";
import type { Delivery, EmailSender, Issue, NewsletterDB, NewsletterEnv } from "./types";

export function parseIssue(value: unknown): Issue {
  const issue = record(value);
  if (typeof issue.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(issue.id))
    throw new Error("Issue id must be a stable lowercase slug.");
  if (typeof issue.title !== "string" || !issue.title.trim() || issue.title.length > 200 || /[\r\n]/.test(issue.title))
    throw new Error("Invalid title.");
  if (typeof issue.preview !== "string" || issue.preview.length > 300) throw new Error("Invalid preview.");
  if (
    issue.markdown !== undefined &&
    (typeof issue.markdown !== "string" || !issue.markdown.trim() || issue.markdown.length > 150000)
  )
    throw new Error("Invalid article markdown.");
  if (
    !issue.markdown &&
    (!Array.isArray(issue.paragraphs) ||
      !issue.paragraphs.length ||
      issue.paragraphs.length > 50 ||
      issue.paragraphs.some((p) => typeof p !== "string" || !p.trim() || p.length > 10000))
  )
    throw new Error("Invalid paragraphs.");
  if (typeof issue.articleUrl !== "string" || issue.articleUrl.length > 2000) throw new Error("Invalid article URL.");
  const url = new URL(issue.articleUrl);
  if (url.origin !== "https://kualta.dev" || url.username || url.password)
    throw new Error("Article must link to https://kualta.dev.");
  return {
    id: issue.id,
    title: issue.title,
    preview: issue.preview,
    paragraphs: issue.markdown ? [] : (issue.paragraphs as string[]),
    ...(issue.markdown ? { markdown: issue.markdown as string } : {}),
    articleUrl: issue.articleUrl,
  };
}
export async function prepareIssue(db: NewsletterDB, issue: Issue): Promise<void> {
  const content = JSON.stringify(issue);
  const hash = await digest(content);
  const existing = await db
    .prepare("SELECT content_hash FROM newsletter_issues WHERE id=?")
    .bind(issue.id)
    .first<{ content_hash: string }>();
  if (existing) {
    if (existing.content_hash !== hash) throw new Error("This issue id already has different content. Use a new id.");
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  // Unique issue insertion and audience snapshot are one transaction. Concurrent prepares cannot expand it.
  await db.batch([
    db
      .prepare("INSERT INTO newsletter_issues(id,content,content_hash,created_at) VALUES (?,?,?,?)")
      .bind(issue.id, content, hash, now),
    db
      .prepare(`INSERT INTO newsletter_deliveries(id,subscriber_id,issue_id,kind,state,created_at)
      SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),
      id,?,'newsletter','pending',? FROM newsletter_subscribers WHERE status='active'`)
      .bind(issue.id, now),
  ]);
}
export async function issueStats(db: NewsletterDB, id: string) {
  const counts = await db
    .prepare(
      `SELECT state, COUNT(*) count FROM newsletter_deliveries WHERE issue_id=? AND kind='newsletter' GROUP BY state`,
    )
    .bind(id)
    .all<{ state: string; count: number }>();
  const engagement = await db
    .prepare(`SELECT COUNT(*) total, SUM(delivered_at IS NOT NULL) delivered,
    SUM(opened_at IS NOT NULL) estimated_opens, SUM(clicked_at IS NOT NULL) clicks,
    SUM(bounced_at IS NOT NULL) bounced, SUM(complained_at IS NOT NULL) complaints
    FROM newsletter_deliveries WHERE issue_id=? AND kind='newsletter'`)
    .bind(id)
    .first();
  return { states: Object.fromEntries(counts.results.map((row) => [row.state, row.count])), engagement };
}
export async function sendBatch(env: NewsletterEnv, issueId: string, send?: EmailSender) {
  const db = env.NEWSLETTER_DB;
  if (!db || !env.PLUNK_SECRET_KEY || !env.NEWSLETTER_TOKEN_SECRET) throw new Error("Sending is not configured.");
  const stored = await db
    .prepare("SELECT content FROM newsletter_issues WHERE id=?")
    .bind(issueId)
    .first<{ content: string }>();
  if (!stored) throw new Error("Issue not found.");
  const issue = parseIssue(JSON.parse(stored.content));
  const blocked = await db
    .prepare(
      "SELECT id FROM newsletter_deliveries WHERE issue_id=? AND kind='newsletter' AND state IN ('sending','failed','unknown') LIMIT 1",
    )
    .bind(issueId)
    .first();
  if (blocked) return issueStats(db, issueId);
  const pending = await db
    .prepare(
      "SELECT * FROM newsletter_deliveries WHERE issue_id=? AND kind='newsletter' AND state='pending' ORDER BY id LIMIT 5",
    )
    .bind(issueId)
    .all<Delivery>();
  const sender = send || plunkSender(env.PLUNK_SECRET_KEY);
  for (const item of pending.results) {
    const now = Math.floor(Date.now() / 1000);
    const claimed = await db
      .prepare("UPDATE newsletter_deliveries SET state='sending',attempted_at=? WHERE id=? AND state='pending'")
      .bind(now, item.id)
      .run();
    if (!claimed.meta.changes) continue;
    try {
      const recipient = await subscriber(db, item.subscriber_id);
      if (!recipient || recipient.status !== "active") {
        await db.prepare("UPDATE newsletter_deliveries SET state='skipped' WHERE id=?").bind(item.id).run();
        continue;
      }
      const rendered = await renderIssue(issue, env, recipient.id, item.id);
      // Recheck consent after rendering, immediately before handing off to the provider.
      if ((await subscriber(db, recipient.id))?.status !== "active") {
        await db.prepare("UPDATE newsletter_deliveries SET state='skipped' WHERE id=?").bind(item.id).run();
        continue;
      }
      const providerId = await sender({
        to: recipient.email,
        subject: issue.title,
        html: rendered.html,
        unsubscribeUrl: rendered.unsubscribe,
        idempotencyKey: item.id,
      });
      await db
        .prepare("UPDATE newsletter_deliveries SET state='sent',provider_id=?,sent_at=? WHERE id=?")
        .bind(providerId, now, item.id)
        .run();
      await applyFeedback(db, providerId);
    } catch (error) {
      const knownFailure = error instanceof SendError && !error.uncertain;
      await db
        .prepare("UPDATE newsletter_deliveries SET state=?,error_code=? WHERE id=?")
        .bind(knownFailure ? "failed" : "unknown", error instanceof SendError ? error.code : "internal", item.id)
        .run();
      break; // Stop this batch on a provider problem. Never auto-retry an uncertain handoff.
    }
  }
  return issueStats(db, issueId);
}
