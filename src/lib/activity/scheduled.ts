import { refreshScheduledActivity } from "./feed";
import { activityStore } from "./durable";

/** One atomic D1 claim per minute, across isolates and duplicate cron delivery. */
export async function runActivityCron(env: Cloudflare.Env, scheduledTime: number, refresh = refreshScheduledActivity): Promise<void> {
  const store = activityStore(env);
  if (store) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        store.fetch("https://activity.internal/refresh", {
          method: "POST", body: JSON.stringify({ scheduledTime }),
          headers: { "content-type": "application/json" }, signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("Activity store refresh timed out")); }, 15_000);
        }),
      ]);
      if (!response.ok) throw new Error("Activity store refresh failed");
      return;
    } finally { clearTimeout(timer); }
  }
  if (!env.ACTIVITY_CACHE || !env.NEWSLETTER_DB) throw new Error("Activity cron bindings are missing");
  const minute = Math.floor(scheduledTime / 60_000);
  let claim;
  try {
    claim = await env.NEWSLETTER_DB.prepare(
      `INSERT INTO activity_refresh (id, minute) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET minute = excluded.minute
       WHERE activity_refresh.minute < excluded.minute`,
    ).bind(minute).run();
  } catch {
    // No provider work can run without coordination. Do not log D1 error details.
    console.warn("activity cron result", { stage: "coordination", result: "failed", action: "verify-0007-migration-and-D1" });
    throw new Error("Activity refresh coordination unavailable: verify 0007_activity_refresh.sql and D1 binding");
  }
  if (!claim.meta.changes) return;
  await refresh({ cache: env.ACTIVITY_CACHE, githubToken: env.GITHUB_ACTIVITY_TOKEN });
}
