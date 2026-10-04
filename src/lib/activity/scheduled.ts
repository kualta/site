import { refreshScheduledActivity } from "./feed";

/** One atomic D1 claim per minute, across isolates and duplicate cron delivery. */
export async function runActivityCron(env: Cloudflare.Env, scheduledTime: number, refresh = refreshScheduledActivity): Promise<void> {
  if (!env.ACTIVITY_CACHE || !env.NEWSLETTER_DB) throw new Error("Activity cron bindings are missing");
  const minute = Math.floor(scheduledTime / 60_000);
  const claim = await env.NEWSLETTER_DB.prepare(
    `INSERT INTO activity_refresh (id, minute) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET minute = excluded.minute
     WHERE activity_refresh.minute < excluded.minute`,
  ).bind(minute).run();
  if (!claim.meta.changes) return;
  await refresh({ cache: env.ACTIVITY_CACHE, githubToken: env.GITHUB_ACTIVITY_TOKEN });
}
