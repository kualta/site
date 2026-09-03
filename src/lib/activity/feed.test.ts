import { describe, expect, test } from "bun:test";
import type {
  ActivityCacheStore,
  ActivityEvent,
  ActivityProvider,
  ActivitySource,
  BlueskyActivity,
  ProviderContext,
} from "./types";
import { getActivityFeed, getActivityHistory } from "./feed";

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

  test("keeps serving fresh results when cache reads and writes fail", async () => {
    const brokenCache: ActivityCacheStore = {
      async get() {
        throw new Error("read failed");
      },
      async put() {
        throw new Error("write failed");
      },
    };

    const feed = await getActivityFeed({
      cache: brokenCache,
      logger,
      now: NOW,
      providers: successfulProviders(),
    });

    expect(feed.events).toHaveLength(2);
    expect(feed.presence).toBe("definitely-alive");
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
