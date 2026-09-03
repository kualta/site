import { describe, expect, test } from "bun:test";
import { collapseWindowFor, groupActivityEvents } from "./group";
import type { ActivityEvent, BlueskyActivity, GitHubActivity } from "./types";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function at(offsetMs: number): string {
  return new Date(NOW - offsetMs).toISOString();
}

function githubEvent(id: string, occurredAt: string, repository?: string, eventType = "PushEvent"): GitHubActivity {
  const base = {
    id: `github:${id.padEnd(24, "0").slice(0, 24)}`,
    source: "github",
    kind: "event",
    occurredAt,
    eventType,
  } as const;

  if (!repository) return { ...base, visibility: "private" };

  return {
    ...base,
    visibility: "public",
    repository: { name: repository, url: `https://github.com/${repository}` },
  };
}

function contributionDay(date: string, count: number): GitHubActivity {
  return {
    id: `github:contributions:${date}`,
    source: "github",
    kind: "contributions",
    occurredAt: `${date}T23:59:59.999Z`,
    count,
  };
}

function blueskyEvent(occurredAt: string): BlueskyActivity {
  return {
    id: `bluesky:${occurredAt}`,
    source: "bluesky",
    occurredAt,
    action: "post",
    uri: "at://did:plc:example/app.bsky.feed.post/1",
    url: "https://bsky.app/profile/kualta.dev/post/1",
    text: "hello",
    author: { handle: "kualta.dev" },
    post: {} as BlueskyActivity["post"],
  };
}

function shape(events: ActivityEvent[]): Array<{ occurredAt: string; count: number }> {
  return groupActivityEvents(events, NOW).map((group) => ({
    occurredAt: group.occurredAt,
    count: group.events.length,
  }));
}

describe("collapseWindowFor", () => {
  test("widens the window as activity ages", () => {
    expect(collapseWindowFor(at(2 * HOUR), NOW)).toBe(0);
    expect(collapseWindowFor(at(2 * DAY), NOW)).toBe(0);
    expect(collapseWindowFor(at(5 * DAY), NOW)).toBe(HOUR);
    expect(collapseWindowFor(at(10 * DAY), NOW)).toBe(3 * HOUR);
    expect(collapseWindowFor(at(20 * DAY), NOW)).toBe(12 * HOUR);
    expect(collapseWindowFor(at(60 * DAY), NOW)).toBe(DAY);
    expect(collapseWindowFor(at(200 * DAY), NOW)).toBe(7 * DAY);
  });
});

describe("groupActivityEvents", () => {
  test("leaves distinct rows in the last three days uncollapsed", () => {
    const events = [
      githubEvent("a", at(0), "kualta/site"),
      githubEvent("b", at(5 * 60 * 1000), "kualta/flow"),
      githubEvent("c", at(10 * 60 * 1000)),
    ];

    expect(shape(events).map(({ count }) => count)).toEqual([1, 1, 1]);
  });

  test("collapses a repository's activity whatever the actions were", () => {
    const events = [
      githubEvent("a", at(0), "kualta/site", "PushEvent"),
      githubEvent("b", at(5 * 60 * 1000), "kualta/site", "IssuesEvent"),
      githubEvent("c", at(10 * 60 * 1000), "kualta/site", "ReleaseEvent"),
    ];

    expect(shape(events)).toEqual([{ occurredAt: at(0), count: 3 }]);
  });

  test("collapses rows that read the same however recent they are", () => {
    const events = [githubEvent("a", at(0)), githubEvent("b", at(5 * 60 * 1000)), githubEvent("c", at(2 * HOUR))];

    expect(shape(events)).toEqual([{ occurredAt: at(0), count: 3 }]);
  });

  test("does not carry an identical row across a day boundary while nothing else collapses", () => {
    const events = [githubEvent("a", "2026-08-30T01:00:00.000Z"), githubEvent("b", "2026-08-29T23:00:00.000Z")];

    expect(shape(events).map(({ count }) => count)).toEqual([1, 1]);
  });

  // once rows that read alike collapse on their own, the age bands are what
  // decides whether a row may also reach across midnight
  test("reaches across a day boundary once the window is wide enough", () => {
    const events = [githubEvent("a", "2026-08-10T01:00:00.000Z"), githubEvent("b", "2026-08-09T22:00:00.000Z")];

    expect(collapseWindowFor("2026-08-10T01:00:00.000Z", NOW)).toBe(12 * HOUR);
    expect(shape(events).map(({ count }) => count)).toEqual([2]);
  });

  test("stops at the day boundary when the gap outruns the window", () => {
    const events = [githubEvent("a", "2026-08-25T01:00:00.000Z"), githubEvent("b", "2026-08-24T21:00:00.000Z")];

    expect(collapseWindowFor("2026-08-25T01:00:00.000Z", NOW)).toBe(HOUR);
    expect(shape(events).map(({ count }) => count)).toEqual([1, 1]);
  });

  test("rolls old contribution days into one row", () => {
    const events = [contributionDay("2026-05-20", 12), contributionDay("2026-05-19", 8)];

    expect(shape(events)).toEqual([{ occurredAt: "2026-05-20T23:59:59.999Z", count: 2 }]);
  });

  test("keeps contribution days apart from detailed events", () => {
    const events = [githubEvent("a", at(5 * DAY)), contributionDay("2026-08-24", 9)];

    expect(shape(events).map(({ count }) => count)).toEqual([1, 1]);
  });

  test("keeps repositories apart", () => {
    const events = [
      githubEvent("a", at(5 * DAY), "kualta/site"),
      githubEvent("b", at(5 * DAY + 10 * 60 * 1000), "kualta/flow"),
    ];

    expect(shape(events).map(({ count }) => count)).toEqual([1, 1]);
  });

  test("never groups across another source, so the order still reads chronologically", () => {
    const events = [
      githubEvent("a", at(5 * DAY)),
      blueskyEvent(at(5 * DAY + 10 * 60 * 1000)),
      githubEvent("b", at(5 * DAY + 20 * 60 * 1000)),
      githubEvent("c", at(5 * DAY + 30 * 60 * 1000)),
    ];

    expect(shape(events).map(({ count }) => count)).toEqual([1, 1, 2]);
  });

  test("keys each row on its newest event", () => {
    const events = [githubEvent("a", at(5 * DAY)), githubEvent("b", at(5 * DAY + 20 * 60 * 1000))];
    const [group] = groupActivityEvents(events, NOW);

    expect(group.id).toBe(events[0].id);
    expect(group.events.map((event) => event.id)).toEqual([events[0].id, events[1].id]);
  });

  test("returns nothing for an empty feed", () => {
    expect(groupActivityEvents([], NOW)).toEqual([]);
  });
});
