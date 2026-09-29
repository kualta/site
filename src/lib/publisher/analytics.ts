import type { NewsletterDB } from "../newsletter/types";
import { historyPage } from "./history";
import { validMetrics } from "./metrics";
import type { Platform } from "./presets";

export async function claimAnalytics(db: NewsletterDB, supported: Platform[]) {
  if (!supported.length) return null;
  const now = Date.now();
  return db
    .prepare(`UPDATE publisher_metric_checks SET claim=?, next_at=? WHERE target_id=(
    SELECT c.target_id FROM publisher_metric_checks c JOIN publisher_targets t ON t.id=c.target_id
    WHERE c.next_at<=? AND t.state='succeeded' AND t.url IS NOT NULL
    AND t.platform IN (${supported.map(() => "?").join(",")})
    AND NOT EXISTS(SELECT 1 FROM publisher_deletions d WHERE d.target_id=t.id AND d.state IN ('queued','working','deleted'))
    ORDER BY c.next_at, t.rowid LIMIT 1
  ) AND next_at<=? RETURNING target_id,claim`)
    .bind(crypto.randomUUID(), now + 5 * 60_000, now, ...supported, now)
    .first<{ target_id: string; claim: string }>();
}
export async function saveAnalytics(db: NewsletterDB, id: string, claim: string, input: unknown, error?: string) {
  const metrics = error ? null : validMetrics(input);
  const now = Date.now();
  await db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO publisher_metric_snapshots(target_id,observed_at,metrics)
      SELECT target_id, ?, ? FROM publisher_metric_checks WHERE target_id=? AND claim=? AND ? IS NOT NULL`)
      .bind(now, metrics ? JSON.stringify(metrics) : null, id, claim, metrics ? 1 : null),
    db
      .prepare(
        "UPDATE publisher_metric_checks SET claim=NULL,next_at=?,checked_at=?,message=? WHERE target_id=? AND claim=?",
      )
      .bind(now + 60 * 60_000, now, error?.slice(0, 300) || null, id, claim),
  ]);
}
export async function analyticsPage(db: NewsletterDB, cursor: string | null) {
  const page = await historyPage(db, cursor);
  const ids = page.posts.map((post) => post.id);
  if (!ids.length) return { posts: [], next: page.next };
  const { results } = await db
    .prepare(`SELECT t.id, c.checked_at, c.next_at, c.message AS analytics_error,
    s.observed_at, s.metrics FROM publisher_targets t
    LEFT JOIN publisher_metric_checks c ON c.target_id=t.id
    LEFT JOIN publisher_metric_snapshots s ON s.target_id=t.id AND s.observed_at=(SELECT MAX(observed_at) FROM publisher_metric_snapshots WHERE target_id=t.id)
    WHERE t.job_id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{
      id: string;
      metrics: string | null;
      observed_at: number | null;
      checked_at: number | null;
      next_at: number | null;
      analytics_error: string | null;
    }>();
  const byId = new Map(
    results.map((row) => [row.id, { ...row, metrics: row.metrics ? JSON.parse(row.metrics) : null }]),
  );
  return {
    ...page,
    posts: page.posts.map((post) => ({ ...post, targets: post.targets.map((t) => ({ ...t, ...byId.get(t.id) })) })),
  };
}
export async function analyticsSeries(db: NewsletterDB, job: string) {
  // Daily closing observations bound transfer size; raw hourly snapshots are retained.
  const { results } = await db
    .prepare(`SELECT s.target_id,s.observed_at,s.metrics FROM publisher_metric_snapshots s
      JOIN (SELECT target_id, MAX(observed_at) AS observed_at FROM publisher_metric_snapshots
      WHERE target_id IN (SELECT id FROM publisher_targets WHERE job_id=?)
      GROUP BY target_id, CAST(observed_at/86400000 AS INTEGER)) daily
      ON daily.target_id=s.target_id AND daily.observed_at=s.observed_at ORDER BY s.observed_at`)
    .bind(job)
    .all<{ target_id: string; observed_at: number; metrics: string }>();
  return results.map((row) => ({ ...row, metrics: JSON.parse(row.metrics) }));
}
