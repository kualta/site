import type { NewsletterDB } from "../newsletter/types";
import { validId } from "./server";
import type { Platform } from "./presets";

export async function historyPage(db: NewsletterDB, cursor: string | null) {
  const [timestamp, id] = cursor?.split(":") || [];
  if (cursor && (!/^\d+$/.test(timestamp) || !validId(id))) throw new Error("Invalid history cursor");
  const condition = cursor ? "WHERE created_at < ? OR (created_at = ? AND id < ?)" : "";
  const query = db.prepare(
    `SELECT id, payload, created_at FROM publisher_jobs ${condition} ORDER BY created_at DESC, id DESC LIMIT 21`,
  );
  const { results: jobs } = await (cursor ? query.bind(Number(timestamp), Number(timestamp), id) : query).all<{
    id: string;
    payload: string;
    created_at: number;
  }>();
  const page = jobs.slice(0, 20);
  if (!page.length) return { posts: [], next: null };
  const { results: targets } = await db
    .prepare(
      `SELECT t.*, d.state AS deletion_state, d.message AS deletion_message, d.finished_at AS deleted_at
     FROM publisher_targets t LEFT JOIN publisher_deletions d ON d.target_id=t.id
     WHERE t.job_id IN (${page.map(() => "?").join(",")}) ORDER BY t.rowid`,
    )
    .bind(...page.map((job) => job.id))
    .all<{ job_id: string }>();
  const last = page[page.length - 1];
  return {
    posts: page.map((job) => ({
      ...job,
      post: JSON.parse(job.payload),
      payload: undefined,
      targets: targets.filter((target) => target.job_id === job.id),
    })),
    next: jobs.length > 20 ? `${last.created_at}:${last.id}` : null,
  };
}

export async function queueDeletion(db: NewsletterDB, job: string, platform: Platform | undefined) {
  // Only confirmed publications with a URL can be deleted. Retry is explicit;
  // completed/active deletions never get replayed by repeated requests.
  return db
    .prepare(`INSERT INTO publisher_deletions(target_id,requested_at)
    SELECT id, ? FROM publisher_targets WHERE job_id=? AND state='succeeded' AND url IS NOT NULL
    ${
      platform
        ? "AND platform=?"
        : "AND NOT EXISTS (SELECT 1 FROM publisher_targets p WHERE p.job_id=publisher_targets.job_id AND p.state IN ('queued','working'))"
    }
    ON CONFLICT(target_id) DO UPDATE SET state='queued',claim=NULL,started_at=NULL,finished_at=NULL,message=NULL,requested_at=excluded.requested_at
    WHERE publisher_deletions.state IN ('failed','uncertain')`)
    .bind(Date.now(), job, ...(platform ? [platform] : []))
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
