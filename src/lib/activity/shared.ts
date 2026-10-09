import { activityStore } from "./durable";
import { getActivityHistory, getInitialActivityFeed, type ActivityHistory } from "./feed";
import { getPresenceState, isActivityDelayed } from "./presence";
import type { ActivityFeed } from "./types";

/** The object's raw JSON, so a head can be cached at the edge without serializing it again. */
async function readObject(env: Cloudflare.Env, path: string, timeoutMs: number): Promise<string | undefined> {
  const store = activityStore(env);
  if (!store) return undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      store.fetch(`https://activity.internal${path}`, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error("Activity store read unavailable");
        return response.text();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Activity store read timed out")); }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Where this data centre keeps the newest head it has served. */
export interface ActivityEdgeCopy {
  origin: string;
  waitUntil(work: Promise<unknown>): void;
}

const EDGE_COPY_PATH = "/_activity/last-head";
const EDGE_COPY_TTL_SECONDS = 7 * 24 * 60 * 60;

function edgeCache(): Cache | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

// The head only changes when the object refreshes, so an isolate writes each
// refresh once rather than on every request.
let keptFreshUntil: string | null | undefined;

function keepEdgeCopy(json: string, feed: ActivityFeed, edge: ActivityEdgeCopy | undefined): void {
  const cache = edgeCache();
  if (!cache || !edge || !feed.lastSeenAt || feed.freshUntil === keptFreshUntil) return;
  keptFreshUntil = feed.freshUntil;
  const copy = new Response(json, {
    headers: { "content-type": "application/json", "cache-control": `max-age=${EDGE_COPY_TTL_SECONDS}` },
  });
  edge.waitUntil(cache.put(`${edge.origin}${EDGE_COPY_PATH}`, copy).catch(() => { keptFreshUntil = undefined; }));
}

async function readEdgeCopy(edge: ActivityEdgeCopy | undefined, timeoutMs: number): Promise<ActivityFeed | undefined> {
  const cache = edgeCache();
  if (!cache || !edge) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      cache.match(`${edge.origin}${EDGE_COPY_PATH}`),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
    return response ? await response.json() as ActivityFeed : undefined;
  } catch {
    return undefined;
  } finally { clearTimeout(timer); }
}

/** A kept head is judged against now, not against when it was read. */
function asOf(feed: ActivityFeed, now: number): ActivityFeed {
  const trusted = Date.parse(feed.trustedUntil ?? "") >= now;
  return {
    ...feed,
    presence: trusted ? getPresenceState(feed.lastSeenAt, now) : "unknown",
    delayed: isActivityDelayed(feed.freshUntil, now),
  };
}

/**
 * Initial HTML stays bounded. The object is busy for a moment each minute while
 * it refreshes, so a miss falls back first to the last head this data centre
 * served, then to the legacy snapshot.
 */
export async function getSharedActivityFeed(env: Cloudflare.Env, strict = false, edge?: ActivityEdgeCopy): Promise<ActivityFeed> {
  const startedAt = Date.now();
  try {
    const json = await readObject(env, "/head", strict ? 2_000 : 250);
    if (json !== undefined) {
      const feed = JSON.parse(json) as ActivityFeed;
      keepEdgeCopy(json, feed, edge);
      return feed;
    }
  } catch {
    if (strict) throw new Error("Activity store unavailable; preserving visible snapshot");
  }
  const kept = await readEdgeCopy(edge, 100);
  if (kept?.lastSeenAt) return asOf(kept, Date.now());
  const remaining = Math.max(1, 250 - (Date.now() - startedAt));
  return getInitialActivityFeed({ cache: env.ACTIVITY_CACHE, requireReadableCache: strict, cacheReadTimeoutMs: strict ? 2_000 : remaining });
}

/** Full archive parsing stays in the object rather than the 10ms page Worker. */
export async function getSharedActivityHistory(env: Cloudflare.Env, before: string): Promise<ActivityHistory> {
  const path = `/history?before=${encodeURIComponent(before)}`;
  const page = await readObject(env, path, 2_000);
  if (page !== undefined) return JSON.parse(page) as ActivityHistory;
  return getActivityHistory({ cache: env.ACTIVITY_CACHE, before, limit: 100, requireReadableCache: true, cacheReadTimeoutMs: 2_000 });
}
