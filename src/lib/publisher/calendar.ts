import type { NewsletterDB } from "../newsletter/types";
import type { Platform, PostKind } from "./presets";
import { EXPIRY_MARGIN, UPLOAD_LIFETIME } from "./schedule";
import { STOPPED_BEFORE } from "./server";

/** One destination on the calendar: when it published, or is to. */
export interface CalendarTarget {
  id: string;
  platform: Platform;
  state: "queued" | "working" | "succeeded" | "failed" | "uncertain";
  url: string | null;
  /** When it published, or failed; for one still to go out, its scheduled time, or when it was queued. */
  at: number;
  /** Still waiting for its scheduled time. */
  scheduled: boolean;
  /** Taken down since. */
  deleted: boolean;
  /** Stopped before it published: it never reached the platform. */
  stopped: boolean;
}
/** A post with what the calendar shows of it. */
export interface CalendarPost {
  id: string;
  title: string;
  caption: string;
  kind: PostKind;
  media: string[];
  mediaKinds?: ("photo" | "video")[];
  cover?: string;
  /** When its kept thumbnail was saved, or null. */
  thumbnail: number | null;
  /** Its words beyond the title and caption, which the calendar can edit. */
  tags: string[];
  short: string;
  zh?: { title: string; text: string; topics: string[] };
  /** The latest it can go out: a while before its first upload expires, or null for a post without any. */
  expires: number | null;
  /** Every destination, those on other months too. */
  targets: CalendarTarget[];
}

/**
 * A destination's moment: a scheduled one still waiting is at its time; one that's out at when it finished, else when
 * it started; one never claimed at its scheduled time, else when it was queued.
 */
const MOMENT = `COALESCE(CASE WHEN t.state='queued' THEN t.scheduled_at END, t.finished_at, t.started_at, t.scheduled_at, j.created_at)`;

/**
 * Every post with a destination whose moment falls in [from, to), with all its destinations. The Calendar asks once
 * per month shown and after a change, never on a timer, so reading every destination (there's no index on a moment)
 * stays cheap.
 */
export async function calendarPosts(
  db: NewsletterDB,
  from: number,
  to: number,
  now = Date.now(),
): Promise<CalendarPost[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.job_id, t.platform, t.state, t.url, t.message, t.scheduled_at, ${MOMENT} AS at,
         d.state AS deletion_state
       FROM publisher_targets t JOIN publisher_jobs j ON j.id=t.job_id
       LEFT JOIN publisher_deletions d ON d.target_id=t.id
       WHERE t.job_id IN (SELECT t.job_id FROM publisher_targets t JOIN publisher_jobs j ON j.id=t.job_id
         WHERE ${MOMENT} >= ? AND ${MOMENT} < ?)
       ORDER BY at, t.rowid`,
    )
    .bind(from, to)
    .all<{
      id: string;
      job_id: string;
      platform: Platform;
      state: CalendarTarget["state"];
      url: string | null;
      message: string | null;
      scheduled_at: number | null;
      at: number;
      deletion_state: string | null;
    }>();
  const ids = [...new Set(results.map((row) => row.job_id))];
  const jobs: { id: string; payload: string }[] = [];
  const thumbnailAt = new Map<string, number>();
  const uploadedAt = new Map<string, number>();
  // D1 binds up to 100 values a statement.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const marks = chunk.map(() => "?").join(",");
    const [found, thumbnails, uploads] = await Promise.all([
      db
        .prepare(`SELECT id, payload FROM publisher_jobs WHERE id IN (${marks})`)
        .bind(...chunk)
        .all<{ id: string; payload: string }>(),
      db
        .prepare(`SELECT job_id, created_at FROM publisher_thumbnails WHERE job_id IN (${marks})`)
        .bind(...chunk)
        .all<{ job_id: string; created_at: number }>(),
      db
        .prepare(`SELECT job_id, MIN(created_at) AS at FROM publisher_media WHERE job_id IN (${marks}) GROUP BY job_id`)
        .bind(...chunk)
        .all<{ job_id: string; at: number }>(),
    ]);
    jobs.push(...found.results);
    for (const row of thumbnails.results) thumbnailAt.set(row.job_id, row.created_at);
    for (const row of uploads.results) uploadedAt.set(row.job_id, row.at);
  }
  return jobs
    .map(({ id, payload }) => {
      const post = JSON.parse(payload);
      const uploaded = uploadedAt.get(id);
      return {
        id,
        title: post.title ?? "",
        caption: post.caption ?? "",
        kind: post.kind,
        media: post.media ?? [],
        ...(post.mediaKinds ? { mediaKinds: post.mediaKinds } : {}),
        ...(post.cover ? { cover: post.cover } : {}),
        thumbnail: thumbnailAt.get(id) ?? null,
        tags: post.tags ?? [],
        short: post.short ?? "",
        ...(post.zh ? { zh: { title: post.zh.title, text: post.zh.text, topics: post.zh.topics } } : {}),
        expires: uploaded === undefined ? null : uploaded + UPLOAD_LIFETIME - EXPIRY_MARGIN,
        targets: results
          .filter((row) => row.job_id === id)
          .map((row) => ({
            id: row.id,
            platform: row.platform,
            state: row.state,
            url: row.url,
            at: row.at,
            scheduled: row.state === "queued" && row.scheduled_at !== null && row.scheduled_at > now,
            deleted: row.deletion_state === "deleted",
            stopped: row.state === "failed" && row.message === STOPPED_BEFORE,
          })),
      };
    })
    .sort((a, b) => a.targets[0].at - b.targets[0].at);
}
