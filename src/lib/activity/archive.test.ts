import { describe, expect, test } from "bun:test";
import {
  decodeActivityCursor,
  encodeActivityCursor,
  getActivityCoverage,
  mergeIntoArchive,
  reconcileSource,
  sliceEventsBefore,
} from "./archive";
import { collapsePastDays } from "./archive";
import type { ActivityEvent } from "./types";

const NOW = new Date("2026-08-30T12:00:00.000Z");

function githubEvent(id: string, occurredAt: string): ActivityEvent {
  return {
    id: `github:${id.padEnd(24, "0").slice(0, 24)}`,
    source: "github",
    kind: "event",
    occurredAt,
    visibility: "private",
    eventType: "PushEvent",
  };
}

function blueskyEvent(id: string, occurredAt: string): ActivityEvent {
  return {
    id: `bluesky:${id}`,
    source: "bluesky",
    occurredAt,
    action: "post",
    uri: `at://did:plc:example/app.bsky.feed.post/${id}`,
    url: `https://bsky.app/profile/kualta.dev/post/${id}`,
    text: id,
    author: { handle: "kualta.dev" },
    post: {} as Extract<ActivityEvent, { source: "bluesky" }>["post"],
  };
}

function contributionDay(date: string, count: number): ActivityEvent {
  return {
    id: `github:contributions:${date}`,
    source: "github",
    kind: "contributions",
    occurredAt: `${date}T23:59:59.999Z`,
    count,
  };
}

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

describe("mergeIntoArchive", () => {
  test("keeps events the provider no longer returns", () => {
    const archived = [githubEvent("old", hoursAgo(80)), githubEvent("older", hoursAgo(100))];
    const merged = mergeIntoArchive(archived, [githubEvent("new", hoursAgo(1))], NOW);

    expect(merged.map(({ id }) => id.slice(7, 12))).toEqual(["new00", "old00", "older"]);
  });

  test("orders every source together and keeps one row per id", () => {
    const merged = mergeIntoArchive(
      [],
      [
        blueskyEvent("middle", hoursAgo(2)),
        githubEvent("duplicate", hoursAgo(3)),
        githubEvent("newest", hoursAgo(1)),
        githubEvent("duplicate", hoursAgo(4)),
      ],
      NOW,
    );

    expect(merged.map(({ id }) => id)).toEqual([
      githubEvent("newest", hoursAgo(1)).id,
      "bluesky:middle",
      githubEvent("duplicate", hoursAgo(4)).id,
    ]);
  });

  test("prefers the freshly fetched copy of an event it already holds", () => {
    const archived = [blueskyEvent("post", hoursAgo(5))];
    const edited = { ...blueskyEvent("post", hoursAgo(5)), text: "edited" } as ActivityEvent;
    const merged = mergeIntoArchive(archived, [edited], NOW);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(edited);
  });

  test("drops events past the retention horizon", () => {
    const ancient = githubEvent("ancient", new Date(NOW.getTime() - 21 * 365 * 24 * 60 * 60 * 1000).toISOString());
    const merged = mergeIntoArchive([ancient], [githubEvent("new", hoursAgo(1))], NOW);

    expect(merged.map(({ id }) => id)).toEqual([githubEvent("new", hoursAgo(1)).id]);
  });

  test("caps each source on its own so a commit burst cannot evict older posts", () => {
    const burst = Array.from({ length: 2100 }, (_, index) =>
      githubEvent(`push${String(index).padStart(4, "0")}`, hoursAgo(1)),
    );
    const post = blueskyEvent("post", hoursAgo(20_000));
    const merged = mergeIntoArchive([post], burst, NOW);

    expect(merged.filter(({ source }) => source === "github")).toHaveLength(2000);
    expect(merged.filter(({ source }) => source === "bluesky")).toEqual([post]);
  });
});

describe("reconcileSource", () => {
  test("drops an archived event the provider stopped returning inside its window", () => {
    const kept = blueskyEvent("kept", hoursAgo(3));
    const deleted = blueskyEvent("deleted", hoursAgo(2));
    const events = reconcileSource([deleted, kept], "bluesky", [kept]);

    expect(events.map(({ id }) => id)).toEqual(["bluesky:kept"]);
  });

  test("leaves events older than the window the provider covered", () => {
    const archived = blueskyEvent("archived", hoursAgo(50));
    const fresh = blueskyEvent("fresh", hoursAgo(1));
    const events = reconcileSource([fresh, archived], "bluesky", [fresh]);

    expect(events.map(({ id }) => id)).toEqual(["bluesky:fresh", "bluesky:archived"]);
  });

  test("never touches another source", () => {
    const github = githubEvent("push", hoursAgo(1));
    const events = reconcileSource([github], "bluesky", [blueskyEvent("post", hoursAgo(2))]);

    expect(events).toEqual([github]);
  });
});

describe("getActivityCoverage", () => {
  test("reports the shallowest source as the boundary", () => {
    const coverage = getActivityCoverage([
      githubEvent("push", hoursAgo(2)),
      blueskyEvent("post", hoursAgo(400)),
      githubEvent("oldest-push", hoursAgo(60)),
    ]);

    expect(coverage.completeSince).toBe(hoursAgo(60));
    expect(coverage.limitedBy).toBe("github");
  });

  test("has no boundary before anything is collected", () => {
    expect(getActivityCoverage([])).toEqual({ oldest: {}, completeSince: null, limitedBy: null });
  });
});

describe("activity cursors", () => {
  test("round-trips through encode and decode", () => {
    const event = githubEvent("push", hoursAgo(1));
    expect(decodeActivityCursor(encodeActivityCursor(event))).toEqual({
      occurredAt: event.occurredAt,
      id: event.id,
    });
  });

  test("rejects malformed cursors", () => {
    expect(decodeActivityCursor("not-a-cursor")).toBeNull();
    expect(decodeActivityCursor("|missing-timestamp")).toBeNull();
    expect(decodeActivityCursor(null)).toBeNull();
  });

  test("pages strictly past the cursor", () => {
    const events = [githubEvent("a", hoursAgo(1)), githubEvent("b", hoursAgo(2)), githubEvent("c", hoursAgo(3))];
    const page = sliceEventsBefore(events, encodeActivityCursor(events[1]));

    expect(page.map(({ id }) => id)).toEqual([events[2].id]);
  });

  test("falls back to the timestamp when the cursor's event is gone", () => {
    const events = [githubEvent("a", hoursAgo(1)), githubEvent("c", hoursAgo(3))];
    const page = sliceEventsBefore(events, `${hoursAgo(2)}|github:missing`);

    expect(page.map(({ id }) => id)).toEqual([events[1].id]);
  });

  test("returns everything without a cursor", () => {
    const events = [githubEvent("a", hoursAgo(1))];
    expect(sliceEventsBefore(events, null)).toEqual(events);
  });
});

describe("contribution days", () => {
  test("reads today event by event and leaves its total out", () => {
    const events = [
      githubEvent("push", "2026-08-30T09:00:00.000Z"),
      contributionDay("2026-08-30", 40),
      contributionDay("2026-08-29", 63),
    ];

    expect(collapsePastDays(events, NOW).map(({ id }) => id)).toEqual([
      githubEvent("push", "2026-08-30T09:00:00.000Z").id,
      "github:contributions:2026-08-29",
    ]);
  });

  test("hands a finished day over to its total", () => {
    const events = [githubEvent("push", "2026-08-29T09:00:00.000Z"), contributionDay("2026-08-29", 63)];

    expect(collapsePastDays(events, NOW).map(({ id }) => id)).toEqual(["github:contributions:2026-08-29"]);
  });

  test("keeps a finished day's events while no total covers it", () => {
    const events = [githubEvent("push", "2026-08-29T09:00:00.000Z"), contributionDay("2026-08-28", 12)];

    expect(collapsePastDays(events, NOW).map(({ id }) => id)).toEqual([
      githubEvent("push", "2026-08-29T09:00:00.000Z").id,
      "github:contributions:2026-08-28",
    ]);
  });

  test("never touches another source", () => {
    const events = [blueskyEvent("post", "2026-08-20T09:00:00.000Z")];
    expect(collapsePastDays(events, NOW)).toEqual(events);
  });

  test("gets its own budget so a commit burst cannot evict the calendar", () => {
    const burst = Array.from({ length: 2100 }, (_, index) =>
      githubEvent(`push${String(index).padStart(4, "0")}`, hoursAgo(1)),
    );
    const days = Array.from({ length: 30 }, (_, index) =>
      contributionDay(new Date(NOW.getTime() - (index + 40) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10), 5),
    );
    const merged = mergeIntoArchive(days, burst, NOW);

    expect(merged.filter((event) => event.source === "github" && event.kind === "contributions")).toHaveLength(30);
  });

  test("a calendar response does not evict detailed events", () => {
    const detailed = githubEvent("push", hoursAgo(2));
    const kept = reconcileSource([detailed], "github", [contributionDay("2025-08-30", 5)]);

    expect(kept.map(({ id }) => id)).toEqual([detailed.id]);
  });
});
