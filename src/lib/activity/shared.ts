import { activityStore } from "./durable";
import { getActivityHistory, getInitialActivityFeed, type ActivityHistory } from "./feed";
import type { ActivityFeed } from "./types";

async function readObject<T>(env: Cloudflare.Env, path: string, timeoutMs: number): Promise<T | undefined> {
  const store = activityStore(env);
  if (!store) return undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      store.fetch(`https://activity.internal${path}`, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error("Activity store read unavailable");
        return response.json() as Promise<T>;
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Activity store read timed out")); }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Initial HTML stays bounded and falls back to the last legacy snapshot. */
export async function getSharedActivityFeed(env: Cloudflare.Env, strict = false): Promise<ActivityFeed> {
  const startedAt = Date.now();
  try {
    const feed = await readObject<ActivityFeed>(env, "/head", strict ? 2_000 : 250);
    if (feed) return feed;
  } catch {
    if (strict) throw new Error("Activity store unavailable; preserving visible snapshot");
  }
  const remaining = Math.max(1, 250 - (Date.now() - startedAt));
  return getInitialActivityFeed({ cache: env.ACTIVITY_CACHE, requireReadableCache: strict, cacheReadTimeoutMs: strict ? 2_000 : remaining });
}

/** Full archive parsing stays in the object rather than the 10ms page Worker. */
export async function getSharedActivityHistory(env: Cloudflare.Env, before: string): Promise<ActivityHistory> {
  const path = `/history?before=${encodeURIComponent(before)}`;
  const page = await readObject<ActivityHistory>(env, path, 2_000);
  return page ?? getActivityHistory({ cache: env.ACTIVITY_CACHE, before, limit: 100, requireReadableCache: true, cacheReadTimeoutMs: 2_000 });
}
