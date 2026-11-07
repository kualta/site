import type { NewsletterDB } from "../newsletter/types";
import { historyPage } from "./history";
import { validMetrics, type DailyChange, type Metrics } from "./metrics";
import { kinds as postKinds, postLabel, type Platform, type PostKind } from "./presets";
import { storedThumbnail, youtubeThumbnail } from "./preview";
import { PostError } from "./server";

/** The `kinds` a request asks for, comma separated; without the parameter, every kind. */
export function parseKinds(value: string | null): PostKind[] | undefined {
  if (value === null) return undefined;
  const list = value.split(",");
  if (!list.every((kind) => (postKinds as readonly string[]).includes(kind))) throw new PostError("Invalid post kind");
  return [...new Set(list as PostKind[])];
}
/** A condition on the job's kind, with its values, or nothing when every kind counts. */
function kindFilter(column: string, kinds?: readonly PostKind[]) {
  if (!kinds) return { sql: "", values: [] as string[] };
  return { sql: ` AND json_extract(${column},'$.kind') IN (${kinds.map(() => "?").join(",")})`, values: [...kinds] };
}

/** SQL for whether publication `t` can be read on one of `supported`, which are bound in its place. */
function readable(supported: Platform[]): string {
  return `t.state='succeeded' AND t.url IS NOT NULL
    AND t.platform IN (${supported.map(() => "?").join(",")})
    AND NOT EXISTS(SELECT 1 FROM publisher_deletions d WHERE d.target_id=t.id AND d.state IN ('queued','working','deleted'))`;
}
/**
 * The helper asks every few seconds, so this reads only the checks that are due. CROSS JOIN keeps SQLite starting from
 * them rather than from every publication. A due check nothing can read, such as a deleted post's or one on a
 * platform the helper isn't signed in to, is set aside for an hour so the next asks don't read it again.
 */
export async function claimAnalytics(db: NewsletterDB, supported: Platform[]) {
  if (!supported.length) return null;
  const now = Date.now();
  const claimed = await db
    .prepare(`UPDATE publisher_metric_checks SET claim=?, next_at=? WHERE target_id=(
    SELECT c.target_id FROM publisher_metric_checks c CROSS JOIN publisher_targets t ON t.id=c.target_id
    WHERE c.next_at<=? AND ${readable(supported)}
    ORDER BY c.next_at, t.rowid LIMIT 1
  ) AND next_at<=? RETURNING target_id,claim`)
    .bind(crypto.randomUUID(), now + 5 * 60_000, now, ...supported, now)
    .first<{ target_id: string; claim: string }>();
  if (claimed) return claimed;
  await db
    .prepare(`UPDATE publisher_metric_checks SET next_at=? WHERE next_at<=? AND NOT EXISTS(
    SELECT 1 FROM publisher_targets t WHERE t.id=publisher_metric_checks.target_id AND ${readable(supported)})`)
    .bind(now + 60 * 60_000, now, ...supported)
    .run();
  return null;
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
/**
 * A destination's latest reading that has a watch time. Retention comes from creator pages that can lag or fail on
 * their own, so one missed read doesn't blank it. Its views come along, to weigh it by.
 */
const RETAINED = `SELECT r.metrics FROM publisher_metric_snapshots r WHERE r.target_id=t.id
  AND json_extract(r.metrics,'$.average_watch_ms') IS NOT NULL ORDER BY r.observed_at DESC LIMIT 1`;
export async function analyticsPage(db: NewsletterDB, cursor: string | null, kinds?: readonly PostKind[]) {
  const page = await historyPage(db, cursor, kinds);
  const ids = page.posts.map((post) => post.id);
  if (!ids.length) return { posts: [], next: page.next };
  const marks = ids.map(() => "?").join(",");
  const [{ results }, thumbnails] = await Promise.all([
    db
      .prepare(`SELECT t.id, c.checked_at, c.next_at, c.message AS analytics_error,
    s.observed_at, s.metrics, (${RETAINED}) AS retention FROM publisher_targets t
    LEFT JOIN publisher_metric_checks c ON c.target_id=t.id
    LEFT JOIN publisher_metric_snapshots s ON s.target_id=t.id AND s.observed_at=(SELECT MAX(observed_at) FROM publisher_metric_snapshots WHERE target_id=t.id)
    WHERE t.job_id IN (${marks})`)
      .bind(...ids)
      .all<{
        id: string;
        metrics: string | null;
        retention: string | null;
        observed_at: number | null;
        checked_at: number | null;
        next_at: number | null;
        analytics_error: string | null;
      }>(),
    db
      .prepare(`SELECT job_id, created_at FROM publisher_thumbnails WHERE job_id IN (${marks})`)
      .bind(...ids)
      .all<{ job_id: string; created_at: number }>(),
  ]);
  const thumbnailAt = new Map(thumbnails.results.map((row) => [row.job_id, row.created_at]));
  const byId = new Map(
    results.map((row) => [
      row.id,
      {
        ...row,
        metrics: row.metrics ? JSON.parse(row.metrics) : null,
        retention: row.retention ? JSON.parse(row.retention) : null,
      },
    ]),
  );
  return {
    ...page,
    posts: page.posts.map((post) => ({
      ...post,
      // When its stored thumbnail was saved, which versions the thumbnail's address; null until there is one.
      thumbnail: thumbnailAt.get(post.id) ?? null,
      targets: post.targets.map((t) => ({ ...t, ...byId.get(t.id) })),
    })),
  };
}
const THUMBNAIL_TYPES = ["image/jpeg", "image/webp", "image/png"];
export const MAX_THUMBNAIL = 200_000;
/** Keeps a post's small picture, replacing any it had; false when there's no such post. */
export async function storeThumbnail(db: NewsletterDB, job: string, type: string, data: ArrayBuffer) {
  if (!THUMBNAIL_TYPES.includes(type)) throw new PostError("A thumbnail is a JPEG, WebP or PNG image");
  if (!data.byteLength || data.byteLength > MAX_THUMBNAIL) throw new PostError("A thumbnail can be up to 200 KB");
  const result = await db
    .prepare(`INSERT INTO publisher_thumbnails(job_id,type,data,created_at) SELECT id,?,?,? FROM publisher_jobs WHERE id=?
      ON CONFLICT(job_id) DO UPDATE SET type=excluded.type, data=excluded.data, created_at=excluded.created_at`)
    .bind(type, new Uint8Array(data), Date.now(), job)
    .run();
  return result.meta.changes > 0;
}
export async function readThumbnail(db: NewsletterDB, job: string) {
  const row = await db
    .prepare("SELECT type, data FROM publisher_thumbnails WHERE job_id=?")
    .bind(job)
    .first<{ type: string; data: ArrayBuffer | ArrayLike<number> }>();
  // D1 hands a BLOB back as an array of bytes.
  return row && { type: row.type, data: new Uint8Array(row.data) };
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
const VIEWS = "COALESCE(json_extract(s.metrics,'$.impressions'),json_extract(s.metrics,'$.views'))";
/**
 * Every post's views over time, when each video that's still up went out, and how long each destination's viewers
 * watched. Each destination's daily change is summed in SQL, so the reply grows with days and platforms instead of
 * with posts, and a day a destination went unread simply adds nothing. `utcOffset`, in minutes, decides where the
 * reader's days begin; `kinds` keeps only posts of those kinds.
 */
export async function analyticsOverview(db: NewsletterDB, utcOffset: number, kinds?: readonly PostKind[]) {
  const kind = kindFilter("j.payload", kinds);
  const [changes, videos, retention] = await Promise.all([
    db
      .prepare(`WITH closes AS (
        SELECT s.target_id, t.platform, CAST((s.observed_at+?)/86400000 AS INTEGER) AS day, MAX(s.observed_at) AS at, ${VIEWS} AS views
        FROM publisher_metric_snapshots s JOIN publisher_targets t ON t.id=s.target_id JOIN publisher_jobs j ON j.id=t.job_id
        WHERE ${VIEWS} IS NOT NULL${kind.sql} GROUP BY s.target_id, day
      )
      SELECT platform, day, MAX(at) AS at, SUM(views-COALESCE(previous,0)) AS change FROM (
        SELECT *, LAG(views) OVER (PARTITION BY target_id ORDER BY day) AS previous FROM closes
      ) GROUP BY platform, day ORDER BY day`)
      .bind(utcOffset * 60_000, ...kind.values)
      .all<DailyChange>(),
    db
      .prepare(`SELECT j.id, COALESCE(MIN(t.finished_at), j.created_at) AS at,
        json_extract(j.payload,'$.title') AS title, json_extract(j.payload,'$.caption') AS caption,
        MAX(CASE WHEN t.platform='youtube' THEN t.url END) AS youtube,
        (SELECT created_at FROM publisher_thumbnails WHERE job_id=j.id) AS stored
        FROM publisher_jobs j JOIN publisher_targets t ON t.job_id=j.id AND t.state='succeeded'
        WHERE json_extract(j.payload,'$.kind') IN ('video','mixed')${kind.sql}
        AND NOT EXISTS(SELECT 1 FROM publisher_deletions d WHERE d.target_id=t.id AND d.state='deleted')
        GROUP BY j.id ORDER BY at`)
      .bind(...kind.values)
      .all<{
        id: string;
        at: number;
        title: string | null;
        caption: string | null;
        youtube: string | null;
        stored: number | null;
      }>(),
    db
      .prepare(`SELECT * FROM (
        SELECT t.platform, COALESCE(t.finished_at, j.created_at) AS at, (${RETAINED}) AS metrics
        FROM publisher_targets t JOIN publisher_jobs j ON j.id=t.job_id WHERE 1${kind.sql}
      ) WHERE metrics IS NOT NULL ORDER BY at`)
      .bind(...kind.values)
      .all<{ platform: Platform; at: number; metrics: string }>(),
  ]);
  return {
    retention: retention.results.map((row) => ({ ...row, metrics: JSON.parse(row.metrics) as Metrics })),
    changes: changes.results,
    videos: videos.results.map((video) => ({
      id: video.id,
      at: video.at,
      label: postLabel({ title: video.title ?? "", caption: video.caption ?? "" }),
      thumbnail: video.stored ? storedThumbnail(video.id, video.stored) : youtubeThumbnail(video.youtube),
    })),
  };
}
