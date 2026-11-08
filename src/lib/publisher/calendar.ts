import type { NewsletterDB } from "../newsletter/types";
import type { Platform, PostKind } from "./presets";
import { STOPPED_BEFORE } from "./server";

/** One destination on the calendar: when it published, or is to. */
export interface CalendarTarget {
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
  targets: CalendarTarget[];
}

/**
 * A destination's moment: a scheduled one still waiting is at its time; one that's out at when it finished, else when
 * it started; one never claimed at its scheduled time, else when it was queued.
 */
const MOMENT = `COALESCE(CASE WHEN t.state='queued' THEN t.scheduled_at END, t.finished_at, t.started_at, t.scheduled_at, j.created_at)`;

/**
 * Every post with a destination whose moment falls in [from, to). The Calendar asks once per month shown, never on a
 * timer, so reading every destination (there's no index on a moment) stays cheap.
 */
export async function calendarPosts(
  db: NewsletterDB,
  from: number,
  to: number,
  now = Date.now(),
): Promise<CalendarPost[]> {
  const { results } = await db
    .prepare(
      `SELECT t.job_id, t.platform, t.state, t.url, t.message, t.scheduled_at, ${MOMENT} AS at,
         d.state AS deletion_state
       FROM publisher_targets t JOIN publisher_jobs j ON j.id=t.job_id
       LEFT JOIN publisher_deletions d ON d.target_id=t.id
       WHERE ${MOMENT} >= ? AND ${MOMENT} < ? ORDER BY at, t.rowid`,
    )
    .bind(from, to)
    .all<{
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
  // D1 binds up to 100 values a statement.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const marks = chunk.map(() => "?").join(",");
    const [found, thumbnails] = await Promise.all([
      db
        .prepare(`SELECT id, payload FROM publisher_jobs WHERE id IN (${marks})`)
        .bind(...chunk)
        .all<{ id: string; payload: string }>(),
      db
        .prepare(`SELECT job_id, created_at FROM publisher_thumbnails WHERE job_id IN (${marks})`)
        .bind(...chunk)
        .all<{ job_id: string; created_at: number }>(),
    ]);
    jobs.push(...found.results);
    for (const row of thumbnails.results) thumbnailAt.set(row.job_id, row.created_at);
  }
  return jobs
    .map(({ id, payload }) => {
      const post = JSON.parse(payload);
      return {
        id,
        title: post.title ?? "",
        caption: post.caption ?? "",
        kind: post.kind,
        media: post.media ?? [],
        ...(post.mediaKinds ? { mediaKinds: post.mediaKinds } : {}),
        ...(post.cover ? { cover: post.cover } : {}),
        thumbnail: thumbnailAt.get(id) ?? null,
        targets: results
          .filter((row) => row.job_id === id)
          .map((row) => ({
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
