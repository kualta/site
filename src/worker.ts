import astro from "@astrojs/cloudflare/entrypoints/server";
import { runActivityCron } from "./lib/activity/scheduled";
import { archiveRecentPosts } from "./lib/publisher/archive";
import { VISITORS_PATH, visitorsSocket } from "./lib/visitors/durable";
export { ActivityStatusCache } from "./lib/activity/durable";
export { LiveVisitors } from "./lib/visitors/durable";

type AstroFetch = Parameters<typeof astro.fetch>;

/**
 * Once a day, copies to the archive the uploads of any post queued in the last 31 days that aren't there yet: a post
 * whose copy failed when it was queued is caught before the media bucket expires its uploads.
 */
async function sweepArchive(env: Cloudflare.Env, scheduledTime: number): Promise<void> {
  const at = new Date(scheduledTime);
  if (at.getUTCHours() !== 3 || at.getUTCMinutes() !== 17) return;
  if (!env.NEWSLETTER_DB || !env.PUBLISHER_MEDIA || !env.ARCHIVE) return;
  try {
    const done = await archiveRecentPosts(env.NEWSLETTER_DB, env.PUBLISHER_MEDIA, env.ARCHIVE);
    if (done.copied || done.gone) console.log("Archive sweep", done);
  } catch (error) {
    console.error("Archive sweep failed", error);
  }
}

export default {
  fetch(request: Request, env: AstroFetch[1], context: AstroFetch[2]) {
    // the live count's socket never needs Astro, so it skips the page render entirely
    if (new URL(request.url).pathname === VISITORS_PATH) return visitorsSocket(request, env as Cloudflare.Env);
    return astro.fetch(request, env, context);
  },
  async scheduled(controller: { scheduledTime: number }, env: Cloudflare.Env): Promise<void> {
    await Promise.all([runActivityCron(env, controller.scheduledTime), sweepArchive(env, controller.scheduledTime)]);
  },
};
