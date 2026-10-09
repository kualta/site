import { describe, expect, test } from "bun:test";
import type {
  ActivityCacheStore,
  ActivityEvent,
  ActivityProvider,
  ActivitySource,
  BlueskyActivity,
  ProviderContext,
} from "./types";
import { getInitialActivityFeed, getActivityFeed, getActivityHistory, refreshScheduledActivity } from "./feed";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const BLUESKY_DID = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const BLUESKY_CID = "bafyreid3l3mpwbadpafmoajnc2ukaaf42cmnti6shcomrrqnqq4ctap5xy";

class MemoryCache implements ActivityCacheStore {
  values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const logger = {
  info() {},
  warn() {},
};

function githubId(value: string): string {
  const hex = Array.from(value, (character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `github:${hex.padEnd(24, "0").slice(0, 24)}`;
}

function githubActivity(id: string, occurredAt: string): ActivityEvent {
  return {
    id: githubId(id),
    source: "github",
    kind: "event",
    occurredAt,
    visibility: "private",
    eventType: "PushEvent",
  };
}

function blueskyActivity(id: string, occurredAt: string): ActivityEvent {
  const uri = `at://${BLUESKY_DID}/app.bsky.feed.post/${id}`;
  return {
    id: `bluesky:${id}`,
    source: "bluesky",
    occurredAt,
    action: "post",
    uri,
    url: `https://bsky.app/profile/${BLUESKY_DID}/post/${id}`,
    text: id,
    author: { handle: "kualta.dev" },
    post: {
      uri,
      cid: BLUESKY_CID,
      indexedAt: occurredAt,
      author: {
        did: BLUESKY_DID,
        handle: "kualta.dev",
      },
      record: {
        $type: "app.bsky.feed.post",
        createdAt: occurredAt,
        text: id,
      },
    } as BlueskyActivity["post"],
  };
}

function provider(
  id: ActivitySource,
  fetchActivity: (context: ProviderContext) => Promise<ActivityEvent[]>,
): ActivityProvider {
  return { id, fetch: fetchActivity };
}

function successfulProviders(calls?: Record<ActivitySource, number>): ActivityProvider[] {
  return [
    provider("github", async () => {
      if (calls) calls.github += 1;
      return [githubActivity("github-new", "2026-08-30T11:59:00Z")];
    }),
    provider("bluesky", async () => {
      if (calls) calls.bluesky += 1;
      return [blueskyActivity("bluesky-new", "2026-08-30T11:58:00Z")];
    }),
  ];
}

function failingProviders(): ActivityProvider[] {
  return [
    provider("github", async () => {
      throw new Error("github unavailable");
    }),
    provider("bluesky", async () => {
      throw new Error("bluesky unavailable");
    }),
  ];
}

describe("getActivityFeed", () => {
  test("refreshes sources concurrently and caches separate snapshots", async () => {
    const cache = new MemoryCache();
    let waiting = 2;
    let release: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const makeConcurrentProvider = (source: ActivitySource): ActivityProvider =>
      provider(source, async () => {
        waiting -= 1;
        if (waiting === 0) release?.();
        await bothStarted;
        return source === "github"
          ? [githubActivity("github", "2026-08-30T12:00:00Z")]
          : [blueskyActivity("bluesky", "2026-08-30T11:00:00Z")];
      });

    const feed = await getActivityFeed({
      cache,
      logger,
      now: NOW,
      providers: [makeConcurrentProvider("github"), makeConcurrentProvider("bluesky")],
    });

    expect(feed.events.map(({ id }) => id)).toEqual([githubId("github"), "bluesky:bluesky"]);
    expect(cache.values.has("activity:state:v3")).toBe(true);
    expect(cache.values.has("activity:archive:v3")).toBe(true);
  });

  test("sanitizes provider events again before writing KV", async () => {
    const cache = new MemoryCache();
    const unsafePrivateEvent = {
      ...githubActivity("unsafe", "2026-08-30T12:00:00Z"),
      repository: { name: "secret-org/secret-repo", url: "https://github.com/secret" },
      target: { title: "Secret launch", url: "https://github.com/secret/pull/1" },
      refType: "branch",
      rawId: "private-event-id",
    } as unknown as ActivityEvent;

    await getActivityFeed({
      cache,
      logger,
      now: NOW,
      providers: [
        provider("github", async () => [unsafePrivateEvent]),
        provider("bluesky", async () => [blueskyActivity("public", "2026-08-30T11:00:00Z")]),
      ],
    });

    const serialized = [...cache.values.values()].join("");
    expect(serialized).toContain(githubId("unsafe"));
    expect(serialized).not.toContain("secret-org");
    expect(serialized).not.toContain("secret-repo");
    expect(serialized).not.toContain("Secret launch");
    expect(serialized).not.toContain("private-event-id");
    expect(serialized).not.toContain("repository");
    expect(serialized).not.toContain("target");
  });

  test("caches Bluesky render data without viewer state or unused counters", async () => {
    const cache = new MemoryCache();
    const event = blueskyActivity("sanitized", "2026-08-30T12:00:00Z");
    if (event.source !== "bluesky") throw new Error("expected Bluesky fixture");
    const eventWithViewerState = {
      ...event,
      post: {
        ...event.post,
        debug: { trace: "not-for-kv" },
        likeCount: 99,
        viewer: {},
      },
    } as BlueskyActivity;

    await getActivityFeed({
      cache,
      logger,
      now: NOW,
      providers: [
        provider("github", async () => [githubActivity("private", "2026-08-30T11:00:00Z")]),
        provider("bluesky", async () => [eventWithViewerState]),
      ],
    });

    const serialized = [...cache.values.values()].join("");
    expect(serialized).toContain('"post"');
    expect(serialized).not.toContain("viewer");
    expect(serialized).not.toContain("debug");
    expect(serialized).not.toContain("likeCount");
    expect(serialized).not.toContain("not-for-kv");
  });

  test("serves fresh cache entries without calling providers", async () => {
    const cache = new MemoryCache();
    const calls = { github: 0, bluesky: 0 };
    await getActivityFeed({ cache, logger, now: NOW, providers: successfulProviders(calls) });
    const feed = await getActivityFeed({
      cache,
      logger,
      now: new Date(NOW.getTime() + 60_000),
      providers: successfulProviders(calls),
    });

    expect(calls).toEqual({ github: 1, bluesky: 1 });
    expect(feed.delayed).toBe(false);
    expect(feed.presence).toBe("definitely-alive");
  });

  test("uses a trusted stale snapshot when refresh fails", async () => {
    const cache = new MemoryCache();
    await getActivityFeed({ cache, logger, now: NOW, providers: successfulProviders() });
    const feed = await getActivityFeed({
      cache,
      logger,
      now: new Date(NOW.getTime() + 6 * 60_000),
      providers: failingProviders(),
    });

    expect(feed.events).toHaveLength(2);
    expect(feed.sources.github.status).toBe("stale");
    expect(feed.sources.bluesky.status).toBe("stale");
    expect(feed.delayed).toBe(true);
    expect(feed.presence).not.toBe("unknown");
  });

  test("keeps old events but refuses to infer presence from untrusted snapshots", async () => {
    const cache = new MemoryCache();
    await getActivityFeed({ cache, logger, now: NOW, providers: successfulProviders() });
    const feed = await getActivityFeed({
      cache,
      logger,
      now: new Date(NOW.getTime() + 25 * 60 * 60_000),
      providers: failingProviders(),
    });

    expect(feed.events).toHaveLength(2);
    expect(feed.sources.github.status).toBe("unavailable");
    expect(feed.presence).toBe("unknown");
    expect(feed.trustedUntil).toBeNull();
  });

  test("marks the feed unknown when a configured source is absent", async () => {
    const feed = await getActivityFeed({
      logger,
      now: NOW,
      providers: [successfulProviders()[0]],
    });

    expect(feed.sources.bluesky.status).toBe("unavailable");
    expect(feed.presence).toBe("unknown");
  });

  test("bounds providers that do not settle", async () => {
    const stalled = provider("github", () => new Promise<ActivityEvent[]>(() => undefined));
    const bluesky = successfulProviders()[1];
    const feed = await getActivityFeed({
      logger,
      now: NOW,
      providers: [stalled, bluesky],
      timeoutMs: 5,
    });

    expect(feed.sources.github.status).toBe("unavailable");
    expect(feed.sources.bluesky.status).toBe("fresh");
    expect(feed.presence).toBe("unknown");
  });

  test("refuses refresh when cached history cannot be read", async () => {
    const brokenCache: ActivityCacheStore = {
      async get() {
        throw new Error("read failed");
      },
      async put() {
        throw new Error("write failed");
      },
    };

    await expect(getActivityFeed({
      cache: brokenCache,
      logger,
      now: NOW,
      providers: successfulProviders(),
    })).rejects.toThrow("preserving existing snapshot");
  });

  test("does not copy provider error details into logs", async () => {
    const entries: unknown[][] = [];
    const capturingLogger = {
      info(...entry: unknown[]) {
        entries.push(entry);
      },
      warn(...entry: unknown[]) {
        entries.push(entry);
      },
    };

    await getActivityFeed({
      logger: capturingLogger,
      now: NOW,
      providers: [
        provider("github", async () => {
          throw new Error("secret-org/secret-repo failed");
        }),
        successfulProviders()[1],
      ],
    });

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("secret-org");
    expect(serialized).not.toContain("secret-repo");
    expect(serialized).toContain('"error":"unknown"');
  });

  test("stores a bare link's card once and keeps it across refreshes", async () => {
    const cache = new MemoryCache();
    const link = "https://www.youtube.com/watch?v=nEX-9exMc1A";
    const event = blueskyActivity("link", "2026-08-30T11:00:00Z") as BlueskyActivity;
    const linked: BlueskyActivity = {
      ...event,
      post: {
        ...event.post,
        record: {
          ...event.post.record,
          text: link,
          facets: [
            {
              index: { byteStart: 0, byteEnd: link.length },
              features: [{ $type: "app.bsky.richtext.facet#link", uri: link }],
            },
          ],
        },
      } as BlueskyActivity["post"],
    };
    let lookups = 0;
    const options = {
      cache,
      logger,
      providers: [provider("github", async () => []), provider("bluesky", async () => [linked])],
      fetch: async () => {
        lookups += 1;
        return Response.json({ title: "A video", description: "", image: "https://elsewhere.example/thumb.jpg" });
      },
    };

    await getActivityFeed({ ...options, now: NOW });
    const feed = await getActivityFeed({ ...options, now: new Date(NOW.getTime() + 2 * 60_000) });

    expect(lookups).toBe(1);
    const [stored] = feed.events;
    expect(stored.source === "bluesky" && stored.linkPreview).toEqual({ uri: link, title: "A video", description: "" });
  });
});

describe("activity history", () => {
  test("keeps events after they scroll out of the provider's window", async () => {
    const cache = new MemoryCache();
    await getActivityFeed({
      cache,
      logger,
      now: NOW,
      providers: [
        provider("github", async () => [
          githubActivity("first", "2026-08-30T11:00:00Z"),
          githubActivity("second", "2026-08-30T10:00:00Z"),
        ]),
        provider("bluesky", async () => [blueskyActivity("post", "2026-08-30T09:00:00Z")]),
      ],
    });

    // GitHub only ever returns its newest hundred, so a later fetch no longer
    // mentions the earlier events
    const feed = await getActivityFeed({
      cache,
      logger,
      now: new Date(NOW.getTime() + 2 * 60_000),
      providers: [
        provider("github", async () => [githubActivity("third", "2026-08-30T11:59:00Z")]),
        provider("bluesky", async () => [blueskyActivity("post", "2026-08-30T09:00:00Z")]),
      ],
    });

    expect(feed.events.map(({ id }) => id)).toEqual([
      githubId("third"),
      githubId("first"),
      githubId("second"),
      "bluesky:post",
    ]);
  });

  test("reports where full coverage ends", async () => {
    const cache = new MemoryCache();
    const feed = await getActivityFeed({
      cache,
      logger,
      now: NOW,
      providers: [
        provider("github", async () => [githubActivity("recent", "2026-08-30T11:00:00Z")]),
        provider("bluesky", async () => [
          blueskyActivity("recent-post", "2026-08-30T10:00:00Z"),
          blueskyActivity("ancient-post", "2025-08-30T10:00:00Z"),
        ]),
      ],
    });

    expect(feed.completeSince).toBe("2026-08-30T11:00:00.000Z");
    expect(feed.coverageLimitedBy).toBe("github");
  });

  test("pages older events without calling providers", async () => {
    const cache = new MemoryCache();
    const feed = await getActivityFeed({
      cache,
      logger,
      now: NOW,
      providers: [
        provider("github", async () => [
          githubActivity("newest", "2026-08-30T11:00:00Z"),
          githubActivity("middle", "2026-08-30T10:00:00Z"),
          githubActivity("oldest", "2026-08-30T09:00:00Z"),
        ]),
        provider("bluesky", async () => []),
      ],
    });

    const page = await getActivityHistory({
      cache,
      logger,
      before: `2026-08-30T11:00:00.000Z|${githubId("newest")}`,
      limit: 1,
    });

    expect(feed.cursor).toBe(`2026-08-30T09:00:00.000Z|${githubId("oldest")}`);
    expect(page.events.map(({ id }) => id)).toEqual([githubId("middle")]);
    expect(page.cursor).toBe(`2026-08-30T10:00:00.000Z|${githubId("middle")}`);
  });

  test("answers from cache and refreshes behind the response when it can", async () => {
    const cache = new MemoryCache();
    const calls = { github: 0, bluesky: 0 };
    await getActivityFeed({ cache, logger, now: NOW, providers: successfulProviders(calls) });

    const background: Promise<unknown>[] = [];
    const feed = await getActivityFeed({
      cache,
      logger,
      now: new Date(NOW.getTime() + 2 * 60_000),
      providers: successfulProviders(calls),
      waitUntil: (work) => background.push(work),
    });

    expect(feed.events).toHaveLength(2);
    expect(calls).toEqual({ github: 1, bluesky: 1 });

    await Promise.all(background);
    expect(calls).toEqual({ github: 2, bluesky: 2 });
  });

  test("waits for the refresh when there is nothing cached to show", async () => {
    const background: Promise<unknown>[] = [];
    const calls = { github: 0, bluesky: 0 };
    const feed = await getActivityFeed({
      cache: new MemoryCache(),
      logger,
      now: NOW,
      providers: successfulProviders(calls),
      waitUntil: (work) => background.push(work),
    });

    expect(background).toHaveLength(0);
    expect(calls).toEqual({ github: 1, bluesky: 1 });
    expect(feed.events).toHaveLength(2);
  });
});


describe("initial activity snapshot", () => {
  test("cold visitors never call providers", async () => {
    const calls = { github: 0, bluesky: 0 };
    const feed = await getInitialActivityFeed({ cache: new MemoryCache(), providers: successfulProviders(calls), now: NOW });
    expect(calls).toEqual({ github: 0, bluesky: 0 });
    expect(feed.presence).toBe("unknown");
    expect(feed.delayed).toBe(true);
  });

  test("retains last successful data with honest freshness", async () => {
    const cache = new MemoryCache();
    await getActivityFeed({ cache, providers: successfulProviders(), logger, now: NOW });
    const lastSeen = (await getInitialActivityFeed({ cache, now: NOW })).lastSeenAt;
    const feed = await getInitialActivityFeed({ cache, now: new Date(+NOW + 25 * 3_600_000), providers: failingProviders() });
    expect(feed.lastSeenAt).toBe(lastSeen);
    expect(feed.presence).toBe("unknown");
    expect(feed.sources.github.fetchedAt).toBe(NOW.toISOString());
    expect(feed.sources.github.status).toBe("unavailable");
  });

  test("a hanging cache cannot delay a cold visitor beyond its budget", async () => {
    const started = performance.now();
    const feed = await getInitialActivityFeed({ cache: { get: () => new Promise(() => {}), put: async () => {} }, logger });
    expect(performance.now() - started).toBeLessThan(600);
    expect(feed.presence).toBe("unknown");
  });
});

test("scheduled refresh preserves snapshots when KV reads fail", async () => {
  const cache = new MemoryCache();
  await getActivityFeed({ cache, providers: successfulProviders(), logger, now: NOW });
  const before = new Map(cache.values);
  let writes = 0;
  const unavailable = { get: async () => { throw new Error("offline"); }, put: async () => { writes++; } };
  await expect(refreshScheduledActivity({ cache: unavailable, providers: failingProviders(), logger })).rejects.toThrow("preserving");
  expect(writes).toBe(0);
  expect(cache.values).toEqual(before);
});

test("cron tolerates a slow shared cache, while initial HTML remains bounded", async () => {
  const cache = new MemoryCache();
  const slow = {
    async get(key: string) { await new Promise((resolve) => setTimeout(resolve, 350)); return cache.get(key); },
    put: (key: string, value: string) => cache.put(key, value),
  };
  await refreshScheduledActivity({ cache: slow, providers: successfulProviders(), logger, now: NOW });
  const started = performance.now();
  const initial = await getInitialActivityFeed({ cache: slow, logger, now: NOW });
  expect(performance.now() - started).toBeLessThan(600);
  expect(initial.delayed).toBe(true);
  const recovered = await getInitialActivityFeed({ cache: slow, logger, now: NOW, cacheReadTimeoutMs: 2_000, requireReadableCache: true });
  expect(recovered.delayed).toBe(false);
  expect(recovered.presence).toBe("definitely-alive");
});

test("freshness survives a failed refresh and recovers only after successful scheduled work", async () => {
  const cache = new MemoryCache();
  const options = { cache, logger, now: NOW, providers: successfulProviders() };
  await refreshScheduledActivity(options);
  const first = await getInitialActivityFeed(options);
  expect(first.delayed).toBe(false);
  expect(first.freshUntil).toBe(new Date(+NOW + 300_000).toISOString());
  expect((await getInitialActivityFeed({ ...options, now: new Date(+NOW + 300_000) })).delayed).toBe(false);
  const later = new Date(+NOW + 300_001);
  await refreshScheduledActivity({ ...options, now: later, providers: failingProviders() });
  const failed = await getInitialActivityFeed({ ...options, now: later });
  expect(failed.delayed).toBe(true);
  expect(failed.lastSeenAt).toBe(first.lastSeenAt);
  expect(failed.freshUntil).toBe(first.freshUntil);
  expect(failed.sources.github.fetchedAt).toBe(NOW.toISOString());
  await refreshScheduledActivity({ ...options, now: later });
  const recovered = await getInitialActivityFeed({ ...options, now: later });
  expect(recovered.delayed).toBe(false);
  expect(recovered.sources.github.fetchedAt).toBe(later.toISOString());
});

test("poll cache errors are rejected instead of replacing a healthy client snapshot", async () => {
  await expect(getInitialActivityFeed({
    cache: { get: async () => { throw new Error("cache down"); }, put: async () => {} },
    requireReadableCache: true, logger,
  })).rejects.toThrow("preserving existing snapshot");
});

test("failed cron persistence preserves freshness, reports only safe codes, and recovers next minute", async () => {
  const cache = new MemoryCache();
  await refreshScheduledActivity({ cache, providers: successfulProviders(), logger, now: NOW });
  const before = new Map(cache.values);
  const warnings: unknown[] = [];
  const diagnostics = { info() {}, warn(...args: unknown[]) { warnings.push(args); } };
  let fail = true;
  const limited = {
    get: (key: string) => cache.get(key),
    put: async (key: string, value: string) => {
      if (fail) throw new Error("KV put() limit exceeded for the day. token=private-credential");
      await cache.put(key, value);
    },
  };
  const later = new Date(+NOW + 6 * 60_000);
  await expect(refreshScheduledActivity({ cache: limited, providers: successfulProviders(), logger: diagnostics, now: later })).rejects.toThrow("persistence failed");
  expect(cache.values).toEqual(before);
  const stale = await getInitialActivityFeed({ cache, now: later });
  expect(stale.delayed).toBe(true);
  expect(stale.sources.github.fetchedAt).toBe(NOW.toISOString());
  const logs = JSON.stringify(warnings);
  expect(logs).toContain("quota-exceeded");
  expect(logs).toContain('"stage":"persistence"');
  expect(logs).not.toContain("private-credential");
  expect(logs).not.toContain("KV put()");
  fail = false;
  const recoveredAt = new Date(+later + 60_000);
  await refreshScheduledActivity({ cache: limited, providers: successfulProviders(), logger, now: recoveredAt });
  const recovered = await getInitialActivityFeed({ cache, now: recoveredAt });
  expect(recovered.delayed).toBe(false);
  expect(recovered.sources.github.fetchedAt).toBe(recoveredAt.toISOString());
});

test("cache diagnostics distinguish throttling, corrupt data and bounded read timeouts", async () => {
  for (const [cache, code] of [
    [{ get: async () => { throw new Error("429 Too Many Requests secret=hidden"); }, put: async () => {} }, "rate-limited"],
    [{ get: async () => "invalid-json", put: async () => {} }, "invalid-snapshot"],
    [{ get: () => new Promise<null>(() => {}), put: async () => {} }, "timeout"],
  ] as const) {
    const warnings: unknown[] = [];
    await expect(getInitialActivityFeed({ cache, cacheReadTimeoutMs: 5, requireReadableCache: true,
      logger: { info() {}, warn(...args: unknown[]) { warnings.push(args); } },
    })).rejects.toThrow("preserving existing snapshot");
    expect(JSON.stringify(warnings)).toContain(code);
    expect(JSON.stringify(warnings)).not.toContain("secret=hidden");
  }
});

test("partial cache writes fail cron, preserve the failed key, and retry independently", async () => {
  for (const failedKey of ["activity:archive:v3", "activity:state:v3"]) {
    const cache = new MemoryCache();
    await refreshScheduledActivity({ cache, providers: successfulProviders(), logger, now: NOW });
    const before = new Map(cache.values);
    const writes: string[] = [];
    let fail = true;
    const partial = {
      get: (key: string) => cache.get(key),
      async put(key: string, value: string) {
        writes.push(key);
        if (fail && key === failedKey) throw new Error("cache unavailable");
        await cache.put(key, value);
      },
    };
    const providers = [
      provider("github", async () => [githubActivity("newer", "2026-08-30T12:05:00Z")]),
      provider("bluesky", async () => [blueskyActivity("newer", "2026-08-30T12:04:00Z")]),
    ];
    const later = new Date(+NOW + 6 * 60_000);
    await expect(refreshScheduledActivity({ cache: partial, providers, logger, now: later })).rejects.toThrow("persistence failed");
    expect(writes).toEqual(["activity:archive:v3", "activity:state:v3"]);
    expect(cache.values.get(failedKey)).toBe(before.get(failedKey));
    const feed = await getInitialActivityFeed({ cache, now: later });
    // Head freshness describes the successfully stored head, independently of history.
    expect(feed.delayed).toBe(failedKey === "activity:state:v3");
    fail = false;
    const retryAt = new Date(+later + 60_000);
    await refreshScheduledActivity({ cache: partial, providers, logger, now: retryAt });
    expect((await getInitialActivityFeed({ cache, now: retryAt })).delayed).toBe(false);
    expect((await getActivityHistory({ cache })).events.some(event => event.id === "bluesky:newer")).toBe(true);
  }
});
