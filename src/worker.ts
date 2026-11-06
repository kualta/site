import astro from "@astrojs/cloudflare/entrypoints/server";
import { runActivityCron } from "./lib/activity/scheduled";
import { VISITORS_PATH, visitorsSocket } from "./lib/visitors/durable";
export { ActivityStatusCache } from "./lib/activity/durable";
export { LiveVisitors } from "./lib/visitors/durable";

type AstroFetch = Parameters<typeof astro.fetch>;

export default {
  fetch(request: Request, env: AstroFetch[1], context: AstroFetch[2]) {
    // the live count's socket never needs Astro, so it skips the page render entirely
    if (new URL(request.url).pathname === VISITORS_PATH) return visitorsSocket(request, env as Cloudflare.Env);
    return astro.fetch(request, env, context);
  },
  async scheduled(controller: { scheduledTime: number }, env: Cloudflare.Env): Promise<void> {
    await runActivityCron(env, controller.scheduledTime);
  },
};
