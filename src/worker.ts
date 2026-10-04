import astro from "@astrojs/cloudflare/entrypoints/server";
import { runActivityCron } from "./lib/activity/scheduled";

export default {
  fetch: astro.fetch,
  async scheduled(controller: { scheduledTime: number }, env: Cloudflare.Env): Promise<void> {
    await runActivityCron(env, controller.scheduledTime);
  },
};
