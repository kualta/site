import { getActivityHistory, getInitialActivityFeed, refreshScheduledActivity } from "./feed";
import type { ActivityCacheStore } from "./types";

export interface ActivityDurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
  transaction<T>(work: (storage: ActivityDurableStorage) => Promise<T>): Promise<T>;
}

export interface ActivityDurableNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
}

const CLAIM_KEY = "activity:claimed-minute:v1";
// Even three-byte BMP text stays below 128KiB, including storage metadata.
const CHUNK_CHARS = 32 * 1024;
const MAX_CHUNKS = 1_024;
const SNAPSHOT_KEYS = new Set(["activity:state:v3", "activity:archive:v3"]);

function manifestKey(key: string): string { return `${key}:chunks`; }
function chunkKey(key: string, index: number): string { return `${key}:chunk:${index}`; }

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CHUNKS;
}

async function readSnapshot(storage: ActivityDurableStorage, key: string): Promise<string | undefined> {
  return storage.transaction(async (transaction) => {
    const count = await transaction.get<number>(manifestKey(key));
    if (count === undefined) return undefined;
    if (!validCount(count)) throw new Error("Invalid activity snapshot manifest");
    const chunks = await Promise.all(Array.from({ length: count }, (_, index) => transaction.get<string>(chunkKey(key, index))));
    if (chunks.some(chunk => typeof chunk !== "string")) throw new Error("Incomplete activity snapshot");
    return chunks.join("");
  });
}

async function writeSnapshot(storage: ActivityDurableStorage, key: string, value: string): Promise<void> {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + CHUNK_CHARS, value.length);
    // Keep Unicode pairs together when the storage backend encodes a chunk.
    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  if (!validCount(chunks.length)) throw new Error("Activity snapshot exceeds bounded storage size");
  const previous = await storage.get<number>(manifestKey(key));
  if (previous !== undefined && !validCount(previous)) throw new Error("Invalid activity snapshot manifest");
  for (let index = 0; index < chunks.length; index++) await storage.put(chunkKey(key, index), chunks[index]);
  await storage.put(manifestKey(key), chunks.length);
  if (previous && previous > chunks.length) {
    for (let offset = chunks.length; offset < previous; offset += 128) {
      await storage.delete(Array.from({ length: Math.min(128, previous - offset) }, (_, index) => chunkKey(key, offset + index)));
    }
  }
}

/** One private, SQLite-backed object. Visitor methods never fetch providers. */
export class ActivityStatusCache {
  private inFlight?: { minute: number; promise: Promise<void> };

  constructor(
    private context: { storage: ActivityDurableStorage },
    private env: Cloudflare.Env,
    private refreshFeed = refreshScheduledActivity,
  ) {}

  private cache(staged?: Map<string, string>): ActivityCacheStore {
    return {
      get: async (key) => {
        if (!SNAPSHOT_KEYS.has(key)) throw new Error("Unknown activity snapshot");
        const stored = await readSnapshot(this.context.storage, key);
        if (stored !== undefined) return stored;
        const legacy = await this.env.ACTIVITY_CACHE?.get(key);
        // Force canonical, revalidated writes on bootstrap; never copy raw KV
        // bytes into persistent storage without the feed's privacy sanitizer.
        return legacy ? ` ${legacy}` : null;
      },
      put: async (key, value) => {
        if (!staged || !SNAPSHOT_KEYS.has(key)) throw new Error("Read-only activity snapshot");
        staged.set(key, value);
      },
    };
  }

  private async refresh(scheduledTime: number): Promise<void> {
    const minute = Math.floor(scheduledTime / 60_000);
    if (this.inFlight) {
      if (minute <= this.inFlight.minute) return this.inFlight.promise;
      await this.inFlight.promise.catch(() => undefined);
      return this.refresh(scheduledTime);
    }
    const promise = this.refreshOnce(minute);
    this.inFlight = { minute, promise };
    try { await promise; } finally { this.inFlight = undefined; }
  }

  private async refreshOnce(minute: number): Promise<void> {
    const previous = await this.context.storage.get<number>(CLAIM_KEY);
    if (previous !== undefined && (!Number.isSafeInteger(previous) || previous < 0)) throw new Error("Invalid activity refresh claim");
    if (previous !== undefined && previous >= minute) return;
    await this.context.storage.put(CLAIM_KEY, minute);
    const staged = new Map<string, string>();
    await this.refreshFeed({
      cache: this.cache(staged), githubToken: this.env.GITHUB_ACTIVITY_TOKEN,
      // The persistence log belongs after the real atomic commit, not after
      // the staging adapter has acknowledged a write.
      logger: { info(message, ...data) { if (message !== "activity cron result") console.info(message, ...data); }, warn: console.warn },
    });
    await this.context.storage.transaction(async (transaction) => {
      for (const [key, value] of staged) await writeSnapshot(transaction, key, value);
    });
    console.info("activity cron result", { stage: "durable-persistence", result: "stored" });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/refresh") {
        const body = await request.json() as { scheduledTime?: unknown };
        const time = body?.scheduledTime;
        if (typeof time !== "number" || !Number.isSafeInteger(time) || time < 0 || time > Date.now() + 5 * 60_000) return new Response("Invalid scheduled time", { status: 400 });
        await this.refresh(time);
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" && url.pathname === "/head") {
        return Response.json(await getInitialActivityFeed({ cache: this.cache(), requireReadableCache: true, cacheReadTimeoutMs: 2_000 }), { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "GET" && url.pathname === "/history") {
        return Response.json(await getActivityHistory({ cache: this.cache(), before: url.searchParams.get("before"), limit: 100, requireReadableCache: true, cacheReadTimeoutMs: 2_000 }), { headers: { "cache-control": "no-store" } });
      }
      return new Response("Not found", { status: 404 });
    } catch {
      console.warn("activity store result", { result: "failed" });
      return new Response("Activity store unavailable", { status: 503 });
    }
  }
}

export function activityStore(env: Cloudflare.Env) {
  if (env.ACTIVITY_STORE_MODE === "legacy") return undefined;
  const namespace = env.ACTIVITY_STORE;
  return namespace?.get(namespace.idFromName("kualta-public-activity-v1"));
}
