import type { NewsletterDB } from "../newsletter/types";
import { EARLIER_SIGN_IN, SIGN_INS, postMedia, validId, type Post } from "./server";
import type { Platform, PostKind } from "./presets";
import { EXPIRY_MARGIN, UPLOAD_LIFETIME } from "./schedule";

/** `kinds` keeps only posts of those kinds; without it every post is listed. */
export async function historyPage(db: NewsletterDB, cursor: string | null, kinds?: readonly PostKind[]) {
  const [timestamp, id] = cursor?.split(":") || [];
  if (cursor && (!/^\d+$/.test(timestamp) || !validId(id))) throw new Error("Invalid history cursor");
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  if (cursor) {
    conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
    values.push(Number(timestamp), Number(timestamp), id);
  }
  if (kinds) {
    conditions.push(`json_extract(payload,'$.kind') IN (${kinds.map(() => "?").join(",")})`);
    values.push(...kinds);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = db.prepare(
    `SELECT id, payload, created_at FROM publisher_jobs ${where} ORDER BY created_at DESC, id DESC LIMIT 21`,
  );
  const { results: jobs } = await (values.length ? query.bind(...values) : query).all<{
    id: string;
    payload: string;
    created_at: number;
  }>();
  const page = jobs.slice(0, 20).map((job) => ({ ...job, post: JSON.parse(job.payload) as Post }));
  if (!page.length) return { posts: [], next: null };
  // A video post's video can be uploaded again once it expires. At most 80 ids, each read by its key.
  const uploads = page.flatMap((job) => (job.post.kind === "video" ? postMedia(job.post) : []));
  const [{ results: targets }, { results: media }] = await Promise.all([
    db
      .prepare(
        `SELECT t.*, d.state AS deletion_state, d.message AS deletion_message, d.finished_at AS deleted_at,
     ${EARLIER_SIGN_IN} AS earlier_sign_in
     FROM publisher_targets t LEFT JOIN publisher_deletions d ON d.target_id=t.id ${SIGN_INS}
     WHERE t.job_id IN (${page.map(() => "?").join(",")}) ORDER BY t.rowid`,
      )
      .bind(...page.map((job) => job.id))
      .all<{ id: string; job_id: string }>(),
    uploads.length
      ? db
          .prepare(`SELECT id, created_at FROM publisher_media WHERE id IN (${uploads.map(() => "?").join(",")})`)
          .bind(...uploads)
          .all<{ id: string; created_at: number }>()
      : { results: [] },
  ]);
  const uploaded = new Map(media.map((row) => [row.id, row.created_at]));
  const now = Date.now();
  const last = page[page.length - 1];
  return {
    posts: page.map((job) => ({
      ...job,
      payload: undefined,
      targets: targets.filter((target) => target.job_id === job.id),
      // The uploads the bucket has removed by now, or will within the hour.
      ...(job.post.kind === "video"
        ? {
            expired: postMedia(job.post).filter(
              (id) => (uploaded.get(id) ?? 0) + UPLOAD_LIFETIME - EXPIRY_MARGIN <= now,
            ),
          }
        : {}),
    })),
    next: jobs.length > 20 ? `${last.created_at}:${last.id}` : null,
  };
}

/** Deletes one publication, or without `target` every one the post has, once nothing of it is still publishing. */
export async function queueDeletion(db: NewsletterDB, job: string, target: string | undefined) {
  // Only confirmed publications with a URL can be deleted. Retry is explicit;
  // completed/active deletions never get replayed by repeated requests.
  return db
    .prepare(`INSERT INTO publisher_deletions(target_id,requested_at)
    SELECT id, ? FROM publisher_targets WHERE job_id=? AND state='succeeded' AND url IS NOT NULL
    ${
      target
        ? "AND id=?"
        : "AND NOT EXISTS (SELECT 1 FROM publisher_targets p WHERE p.job_id=publisher_targets.job_id AND p.state IN ('queued','working'))"
    }
    ON CONFLICT(target_id) DO UPDATE SET state='queued',claim=NULL,started_at=NULL,finished_at=NULL,message=NULL,requested_at=excluded.requested_at
    WHERE publisher_deletions.state IN ('failed','uncertain')`)
    .bind(Date.now(), job, ...(target ? [target] : []))
    .run();
}

export async function claimDeletion(db: NewsletterDB, supported: Platform[]) {
  await db
    .prepare(
      "UPDATE publisher_deletions SET state='uncertain', message='Helper disconnected. Check the platform before retrying.' WHERE state='working' AND started_at < ?",
    )
    .bind(Date.now() - 15 * 60_000)
    .run();
  if (!supported.length) return null;
  return db
    .prepare(`UPDATE publisher_deletions SET state='working',claim=?,started_at=? WHERE target_id=(
    SELECT d.target_id FROM publisher_deletions d JOIN publisher_targets t ON t.id=d.target_id
    WHERE d.state='queued' AND t.platform IN (${supported.map(() => "?").join(",")}) ORDER BY d.requested_at LIMIT 1
  ) AND state='queued' RETURNING *`)
    .bind(crypto.randomUUID(), Date.now(), ...supported)
    .first<{ target_id: string; claim: string }>();
}
