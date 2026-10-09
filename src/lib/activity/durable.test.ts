import { expect, test } from "bun:test";
import { ActivityStatusCache, type ActivityDurableStorage } from "./durable";
import { getSharedActivityFeed } from "./shared";
import { runActivityCron } from "./scheduled";
import type { ActivityFeed } from "./types";

class Storage implements ActivityDurableStorage {
  values = new Map<string, unknown>();
  failKey?: string;
  async get<T>(key: string) { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown) {
    if (key === this.failKey) throw new Error("fake platform failure includes sensitive data");
    if (typeof value === "string" && Buffer.byteLength(value) + Buffer.byteLength(key) >= 128 * 1024) throw new Error("Oversized storage value");
    this.values.set(key, value);
  }
  async delete(keys: string[]) { expect(keys.length).toBeLessThanOrEqual(128); return keys.reduce((count, key) => count + Number(this.values.delete(key)), 0); }
  async transaction<T>(work: (storage: ActivityDurableStorage) => Promise<T>): Promise<T> {
    const previous = new Map(this.values);
    try { return await work(this); } catch (error) { this.values = previous; throw error; }
  }
}

const time = () => Math.floor(Date.now() / 60_000) * 60_000;
const refreshRequest = (scheduledTime: number) => new Request("https://activity.internal/refresh", { method: "POST", body: JSON.stringify({ scheduledTime }) });
const archiveKey = "activity:archive:v3";
const stateKey = "activity:state:v3";

test("durable refresh deduplicates delivery and retries next minute after failed atomic persistence", async () => {
  const storage = new Storage();
  let calls = 0;
  const object = new ActivityStatusCache({ storage }, {}, async ({ cache }) => {
    calls++;
    await cache!.put(archiveKey, JSON.stringify({ version: 3, events: [], marker: calls }));
    await cache!.put(stateKey, JSON.stringify({ version: 3, sources: {}, events: [], marker: calls }));
  });
  const start = time() - 120_000;
  expect((await object.fetch(refreshRequest(start))).status).toBe(204);
  const stored = new Map(storage.values);
  storage.failKey = `${stateKey}:chunk:0`;
  expect((await object.fetch(refreshRequest(start + 60_000))).status).toBe(503);
  expect(storage.values.get(`${archiveKey}:chunk:0`)).toBe(stored.get(`${archiveKey}:chunk:0`));
  expect(storage.values.get(`${stateKey}:chunk:0`)).toBe(stored.get(`${stateKey}:chunk:0`));
  expect((await object.fetch(refreshRequest(start + 60_000))).status).toBe(204);
  expect(calls).toBe(2);
  storage.failKey = undefined;
  expect((await object.fetch(refreshRequest(start + 120_000))).status).toBe(204);
  expect(calls).toBe(3);
  expect(JSON.parse(await storage.get<string>(`${stateKey}:chunk:0`) ?? "{}").marker).toBe(3);
});

test("concurrent same-minute delivery shares work and a newer minute queues independently", async () => {
  const storage = new Storage();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const object = new ActivityStatusCache({ storage }, {}, async () => { calls++; if (calls === 1) await gate; });
  const start = time() - 60_000;
  const first = object.fetch(refreshRequest(start));
  const duplicate = object.fetch(refreshRequest(start));
  const next = object.fetch(refreshRequest(start + 60_000));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(calls).toBe(1);
  release();
  expect((await Promise.all([first, duplicate, next])).map(response => response.status)).toEqual([204, 204, 204]);
  expect(calls).toBe(2);
});

test("large archive chunks preserve Unicode and shrink without leaving stale chunks", async () => {
  const storage = new Storage();
  let large = true;
  const text = "中".repeat(65_535) + "🌱" + "b".repeat(4_300_000);
  const archive = JSON.stringify({ version: 3, events: [], marker: text });
  const object = new ActivityStatusCache({ storage }, {}, async ({ cache }) => {
    await cache!.put(archiveKey, large ? archive : '{"version":3,"events":[]}');
  });
  const start = time() - 60_000;
  expect((await object.fetch(refreshRequest(start))).status).toBe(204);
  const count = await storage.get<number>(`${archiveKey}:chunks`);
  expect(count).toBeGreaterThan(128);
  const joined = Array.from({ length: count! }, (_, i) => storage.values.get(`${archiveKey}:chunk:${i}`)).join("");
  expect(joined).toBe(archive);
  expect([...storage.values.values()].filter(value => typeof value === "string").every(value => Buffer.byteLength(value as string) < 128 * 1024)).toBe(true);
  large = false;
  expect((await object.fetch(refreshRequest(start + 60_000))).status).toBe(204);
  expect(storage.values.get(`${archiveKey}:chunks`)).toBe(1);
  expect(storage.values.has(`${archiveKey}:chunk:1`)).toBe(false);
});

test("incomplete history storage returns failure so paging can retry rather than exhaust", async () => {
  const storage = new Storage();
  storage.values.set(`${archiveKey}:chunks`, 1);
  const object = new ActivityStatusCache({ storage }, {}, async () => {});
  expect((await object.fetch(new Request("https://activity.internal/history?before=2026-01-01T00%3A00%3A00Z%7Cevent"))).status).toBe(503);
});

test("read-only visitor methods preserve old data, reject writes and do not refresh", async () => {
  let calls = 0;
  const storage = new Storage();
  const previousTime = new Date(Date.now() - 600_000).toISOString();
  const legacy = JSON.stringify({ version: 3, sources: { github: { fetchedAt: previousTime }, bluesky: { fetchedAt: previousTime } }, events: [] });
  const object = new ActivityStatusCache({ storage }, { ACTIVITY_CACHE: { get: async () => legacy, put: async () => { throw new Error("No legacy writes"); } } }, async () => { calls++; });
  const response = await object.fetch(new Request("https://activity.internal/head"));
  expect(response.status).toBe(200);
  expect((await response.json() as { delayed: boolean }).delayed).toBe(true);
  expect((await object.fetch(new Request("https://activity.internal/head", { method: "POST" }))).status).toBe(404);
  expect((await object.fetch(refreshRequest(-1))).status).toBe(400);
  expect(calls).toBe(0);
});

test("cron hands off to private object without invoking D1 or provider work in page Worker", async () => {
  let path = "";
  const env: Cloudflare.Env = { ACTIVITY_STORE: {
    idFromName: name => name,
    get: () => ({ fetch: async (input, init) => { path = String(input); expect(init?.method).toBe("POST"); return new Response(null, { status: 204 }); } }),
  } };
  await runActivityCron(env, time(), async () => { throw new Error("Page Worker must not refresh"); });
  expect(path).toBe("https://activity.internal/refresh");
  env.ACTIVITY_STORE!.get = () => ({ fetch: async () => new Response("private failure", { status: 503 }) });
  await expect(runActivityCron(env, time())).rejects.toThrow("Activity store refresh failed");
  env.ACTIVITY_STORE_MODE = "legacy";
  await expect(runActivityCron(env, time())).rejects.toThrow("Activity cron bindings are missing");
});

test("hanging object response bodies cannot block HTML; strict polling preserves visible snapshot", async () => {
  const env: Cloudflare.Env = { ACTIVITY_STORE: { idFromName: name => name, get: () => ({ fetch: async () => new Response(new ReadableStream({ start() {} })) }) } };
  const start = performance.now();
  const feed = await getSharedActivityFeed(env);
  expect(performance.now() - start).toBeLessThan(500);
  expect(feed.delayed).toBe(true);
  await expect(getSharedActivityFeed(env, true)).rejects.toThrow("preserving visible snapshot");
});

test("a busy object falls back to the last head this data centre served, judged against now", async () => {
  const kept = new Map<string, Response>();
  const scope = globalThis as { caches?: unknown };
  scope.caches = { default: {
    put: async (key: string, response: Response) => { kept.set(key, response.clone()); },
    match: async (key: string) => kept.get(key)?.clone(),
  } };
  try {
    const now = Date.now();
    const at = (offset: number) => new Date(now + offset).toISOString();
    const head: ActivityFeed = {
      events: [], lastSeenAt: at(-60_000), presence: "definitely-alive",
      sources: { github: { status: "fresh", fetchedAt: at(-10 * 60_000) }, bluesky: { status: "fresh", fetchedAt: at(-10 * 60_000) } },
      delayed: false, freshUntil: at(-5 * 60_000), trustedUntil: at(60_000),
      completeSince: null, coverageLimitedBy: null, cursor: null,
    };
    let respond = () => Response.json(head);
    const env: Cloudflare.Env = { ACTIVITY_STORE: { idFromName: name => name, get: () => ({ fetch: async () => respond() }) } };
    const work: Promise<unknown>[] = [];
    const edge = { origin: "https://kualta.dev", waitUntil: (promise: Promise<unknown>) => { work.push(promise); } };

    expect((await getSharedActivityFeed(env, false, edge)).delayed).toBe(false);
    await Promise.all(work);
    respond = () => new Response(new ReadableStream({ start() {} }));

    const start = performance.now();
    const feed = await getSharedActivityFeed(env, false, edge);
    expect(performance.now() - start).toBeLessThan(500);
    expect(feed.lastSeenAt).toBe(head.lastSeenAt);
    expect(feed.presence).toBe("definitely-alive");
    expect(feed.delayed).toBe(true);

    kept.set("https://kualta.dev/_activity/last-head", Response.json({ ...head, trustedUntil: at(-1) }));
    expect((await getSharedActivityFeed(env, false, edge)).presence).toBe("unknown");
  } finally {
    scope.caches = undefined;
  }
});
