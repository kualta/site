import type { NewsletterDB } from "../newsletter/types";
import { historyPage } from "./history";
import { validMetrics, type DailyChange } from "./metrics";
import { postLabel, type Platform } from "./presets";

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
/** Makes a post's destinations due now, at most once each per five minutes, and says which ones will be read. */
export async function requestRefresh(db: NewsletterDB, job: string) {
  const at = Date.now();
  const { results } = await db
    .prepare(`UPDATE publisher_metric_checks SET next_at=0
      WHERE claim IS NULL AND (checked_at IS NULL OR checked_at<?) AND target_id IN (
        SELECT t.id FROM publisher_targets t WHERE t.job_id=? AND t.state='succeeded' AND t.url IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM publisher_deletions d WHERE d.target_id=t.id AND d.state IN ('queued','working','deleted'))
      ) RETURNING target_id`)
    .bind(at - 5 * 60_000, job)
    .all<{ target_id: string }>();
  return { at, queued: results.map((row) => row.target_id) };
}
export async function analyticsSeries(db: NewsletterDB, job: string, now = Date.now()) {
  // Hourly closes show how a young post moves; daily closes before that bound the transfer. Raw snapshots stay in D1.
  const { results } = await db
    .prepare(`SELECT s.target_id,t.platform,s.observed_at,s.metrics FROM publisher_metric_snapshots s
      JOIN publisher_targets t ON t.id=s.target_id
      JOIN (SELECT target_id, MAX(observed_at) AS observed_at FROM publisher_metric_snapshots
      WHERE target_id IN (SELECT id FROM publisher_targets WHERE job_id=?)
      GROUP BY target_id, CASE WHEN observed_at>=? THEN CAST(observed_at/3600000 AS INTEGER)
        ELSE CAST(observed_at/86400000 AS INTEGER)*24 END) closing
      ON closing.target_id=s.target_id AND closing.observed_at=s.observed_at ORDER BY s.observed_at`)
    .bind(job, now - 3 * 86_400_000)
    .all<{ target_id: string; platform: Platform; observed_at: number; metrics: string }>();
  return results.map((row) => ({ ...row, metrics: JSON.parse(row.metrics) }));
}
function youtubeThumbnail(url: string | null) {
  const id = url?.match(/(?:youtu\.be\/|\/shorts\/|[?&]v=)([\w-]{11})/)?.[1];
  return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
}
const VIEWS = "COALESCE(json_extract(s.metrics,'$.impressions'),json_extract(s.metrics,'$.views'))";
/**
 * Every post's views over time, and when each video that's still up went out. Each destination's daily change is
 * summed in SQL, so the reply grows with days and platforms instead of with posts, and a day a destination went
 * unread simply adds nothing. `utcOffset`, in minutes, decides where the reader's days begin.
 */
export async function analyticsOverview(db: NewsletterDB, utcOffset: number) {
  const [changes, videos] = await Promise.all([
    db
      .prepare(`WITH closes AS (
        SELECT s.target_id, t.platform, CAST((s.observed_at+?)/86400000 AS INTEGER) AS day, MAX(s.observed_at) AS at, ${VIEWS} AS views
        FROM publisher_metric_snapshots s JOIN publisher_targets t ON t.id=s.target_id
        WHERE ${VIEWS} IS NOT NULL GROUP BY s.target_id, day
      )
      SELECT platform, day, MAX(at) AS at, SUM(views-COALESCE(previous,0)) AS change FROM (
        SELECT *, LAG(views) OVER (PARTITION BY target_id ORDER BY day) AS previous FROM closes
      ) GROUP BY platform, day ORDER BY day`)
      .bind(utcOffset * 60_000)
      .all<DailyChange>(),
    db
      .prepare(`SELECT j.id, COALESCE(MIN(t.finished_at), j.created_at) AS at,
        json_extract(j.payload,'$.title') AS title, json_extract(j.payload,'$.caption') AS caption,
        MAX(CASE WHEN t.platform='youtube' THEN t.url END) AS youtube
        FROM publisher_jobs j JOIN publisher_targets t ON t.job_id=j.id AND t.state='succeeded'
        WHERE json_extract(j.payload,'$.kind') IN ('video','mixed')
        AND NOT EXISTS(SELECT 1 FROM publisher_deletions d WHERE d.target_id=t.id AND d.state='deleted')
        GROUP BY j.id ORDER BY at`)
      .all<{ id: string; at: number; title: string | null; caption: string | null; youtube: string | null }>(),
  ]);
  return {
    changes: changes.results,
    videos: videos.results.map((video) => ({
      id: video.id,
      at: video.at,
      label: postLabel({ title: video.title ?? "", caption: video.caption ?? "" }),
      thumbnail: youtubeThumbnail(video.youtube),
    })),
  };
}
