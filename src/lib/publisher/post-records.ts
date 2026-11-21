import type { NewsletterDB } from "../newsletter/types";
import type { Platform, PostKind } from "./presets";
import { PostError, validId, type Post } from "./server";

/**
 * What a post's public record (`dev.kualta.post`, in the owner's AT Protocol repository) is made from. Only what is
 * already public leaves here: the post's words, and the copies a platform confirmed.
 */
export interface PostRecordSource {
  id: string;
  created_at: number;
  post: { kind: PostKind; title: string; caption: string; tags?: string[] };
  /** Every copy that went up, in the order they were queued, with the ones since deleted marked. */
  targets: { platform: Platform; url: string; finished_at: number | null; linked: boolean; deleted: boolean }[];
  /** The stored thumbnail's type, size and SHA-256, which fix its blob's address without sending its bytes. */
  thumbnail: { type: string; size: number; sha256: string } | null;
}
const PAGE = 20;
type JobRow = { id: string; payload: string; created_at: number };

async function sources(db: NewsletterDB, jobs: JobRow[]): Promise<PostRecordSource[]> {
  if (!jobs.length) return [];
  const marks = jobs.map(() => "?").join(",");
  const ids = jobs.map((job) => job.id);
  const [{ results: targets }, { results: thumbnails }] = await Promise.all([
    db
      .prepare(
        `SELECT t.job_id, t.platform, t.url, t.finished_at, t.linked, d.state AS deletion
         FROM publisher_targets t LEFT JOIN publisher_deletions d ON d.target_id = t.id
         WHERE t.state = 'succeeded' AND t.url IS NOT NULL AND t.job_id IN (${marks}) ORDER BY t.rowid`,
      )
      .bind(...ids)
      .all<{
        job_id: string;
        platform: Platform;
        url: string;
        finished_at: number | null;
        linked: number;
        deletion: string | null;
      }>(),
    db
      .prepare(`SELECT job_id, type, data FROM publisher_thumbnails WHERE job_id IN (${marks})`)
      .bind(...ids)
      .all<{ job_id: string; type: string; data: ArrayBuffer | ArrayLike<number> }>(),
  ]);
  return Promise.all(
    jobs.map(async (job) => {
      const post = JSON.parse(job.payload) as Post;
      const thumbnail = thumbnails.find((row) => row.job_id === job.id);
      const data = thumbnail && new Uint8Array(thumbnail.data);
      return {
        id: job.id,
        created_at: job.created_at,
        post: {
          kind: post.kind,
          title: post.title,
          caption: post.caption,
          ...(post.tags?.length ? { tags: post.tags } : {}),
        },
        targets: targets
          .filter((target) => target.job_id === job.id)
          .map((target) => ({
            platform: target.platform,
            url: target.url,
            finished_at: target.finished_at,
            linked: target.linked === 1,
            deleted: target.deletion === "deleted",
          })),
        thumbnail:
          thumbnail && data
            ? {
                type: thumbnail.type,
                size: data.byteLength,
                sha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
                  .map((n) => n.toString(16).padStart(2, "0"))
                  .join(""),
              }
            : null,
      };
    }),
  );
}

/** Every post, newest first, a page at a time: the helper reconciles each one's record against it. */
export async function postRecordPage(db: NewsletterDB, cursor: string | null) {
  const [timestamp, id] = cursor?.split(":") || [];
  if (cursor && (!/^\d+$/.test(timestamp) || !validId(id))) throw new PostError("Invalid post cursor");
  const query = db.prepare(
    `SELECT id, payload, created_at FROM publisher_jobs ${
      cursor ? "WHERE created_at < ? OR (created_at = ? AND id < ?)" : ""
    } ORDER BY created_at DESC, id DESC LIMIT ${PAGE + 1}`,
  );
  const { results } = await (cursor ? query.bind(Number(timestamp), Number(timestamp), id) : query).all<JobRow>();
  const page = results.slice(0, PAGE);
  const last = page[page.length - 1];
  return {
    jobs: await sources(db, page),
    next: results.length > PAGE ? `${last.created_at}:${last.id}` : null,
  };
}

export async function postRecordSource(db: NewsletterDB, job: string): Promise<PostRecordSource | null> {
  const row = await db
    .prepare("SELECT id, payload, created_at FROM publisher_jobs WHERE id = ?")
    .bind(job)
    .first<JobRow>();
  return row ? (await sources(db, [row]))[0] : null;
}
