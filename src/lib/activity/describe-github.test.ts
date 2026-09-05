import { describe, expect, test } from "bun:test";
import { describeGitHubActivity, describeGitHubActivityGroup } from "./describe-github";
import type { GitHubActivity } from "./types";

function privateEvent(eventType: string): GitHubActivity {
  return {
    id: "github:0123456789abcdef01234567",
    source: "github",
    kind: "event",
    occurredAt: "2026-08-30T12:00:00.000Z",
    visibility: "private",
    eventType,
  };
}

function publicEvent(eventType: string, extra: Partial<GitHubActivity> = {}): GitHubActivity {
  return {
    id: "github:0123456789abcdef01234567",
    source: "github",
    kind: "event",
    occurredAt: "2026-08-30T12:00:00.000Z",
    visibility: "public",
    eventType,
    repository: { name: "kualta/site", url: "https://github.com/kualta/site" },
    ...extra,
  } as GitHubActivity;
}

describe("describeGitHubActivity", () => {
  test("says nothing about what happened inside a private repository", () => {
    for (const eventType of ["PushEvent", "PullRequestEvent", "ForkEvent", "NewEventFamily"]) {
      expect(describeGitHubActivity(privateEvent(eventType))).toEqual({
        text: "contribution in private repo",
      });
    }
  });

  test("names the repository rather than the action for public activity", () => {
    for (const eventType of ["PushEvent", "PullRequestEvent", "ForkEvent", "NewEventFamily"]) {
      expect(describeGitHubActivity(publicEvent(eventType)).text).toBe("contribution in kualta/site");
    }
  });

  test("falls back to GitHub itself when the repository did not survive sanitizing", () => {
    expect(describeGitHubActivity(publicEvent("PushEvent", { repository: undefined })).text).toBe(
      "contribution on GitHub",
    );
  });

  test("links public activity to its most specific sanitized target", () => {
    const event: GitHubActivity = {
      id: "github:0123456789abcdef01234567",
      source: "github",
      kind: "event",
      occurredAt: "2026-08-30T12:00:00.000Z",
      visibility: "public",
      eventType: "IssuesEvent",
      action: "opened",
      repository: { name: "kualta/site", url: "https://github.com/kualta/site" },
      target: { title: "Public issue", url: "https://github.com/kualta/site/issues/1" },
    };

    expect(describeGitHubActivity(event)).toEqual({
      text: "contribution in kualta/site",
      url: "https://github.com/kualta/site/issues/1",
    });
  });
});

describe("describeGitHubActivityGroup", () => {
  test("keeps the anonymous label when a private burst collapses", () => {
    const events = [privateEvent("PushEvent"), privateEvent("PullRequestEvent")];

    expect(describeGitHubActivityGroup(events)).toEqual({
      text: "contribution in private repo",
    });
  });

  test("keeps the shared label when a public burst collapses", () => {
    const events = [publicEvent("PushEvent"), publicEvent("IssuesEvent", { action: "opened" })];

    expect(describeGitHubActivityGroup(events)).toEqual({
      text: "contribution in kualta/site",
      url: "https://github.com/kualta/site",
    });
  });

  test("links a collapsed row to the repository rather than one event's target", () => {
    const events = [
      publicEvent("IssuesEvent", { target: { title: "Public issue", url: "https://github.com/kualta/site/issues/1" } }),
      publicEvent("PushEvent"),
    ];

    expect(describeGitHubActivityGroup(events).url).toBe("https://github.com/kualta/site");
  });
});

describe("contribution days", () => {
  const day = (date: string, count: number): GitHubActivity => ({
    id: `github:contributions:${date}`,
    source: "github",
    kind: "contributions",
    occurredAt: `${date}T23:59:59.999Z`,
    count,
  });

  const NOW = Date.parse("2026-08-31T12:00:00.000Z");
  const PROFILE = "https://github.com/kualta";

  test("names the day a single row covers", () => {
    expect(describeGitHubActivity(day("2026-05-20", 12), NOW)).toEqual({
      text: "12 contributions on may 20",
      url: PROFILE,
    });
  });

  test("names the span a collapsed row covers instead of counting its days", () => {
    expect(describeGitHubActivityGroup([day("2026-05-25", 12), day("2026-05-19", 8)], NOW)).toEqual({
      text: "20 contributions, may 19 – 25",
      url: PROFILE,
    });
  });

  test("spells out both months when a span crosses one", () => {
    expect(describeGitHubActivityGroup([day("2026-06-02", 5), day("2026-05-28", 5)], NOW)).toEqual({
      text: "10 contributions, may 28 – june 2",
      url: PROFILE,
    });
  });

  test("collapses a span that turns out to be a single day", () => {
    expect(describeGitHubActivityGroup([day("2026-05-20", 12), day("2026-05-20", 8)], NOW)).toEqual({
      text: "20 contributions on may 20",
      url: PROFILE,
    });
  });

  test("names an earlier year once for the whole span", () => {
    expect(describeGitHubActivityGroup([day("2021-03-07", 15), day("2021-02-28", 14)], NOW)).toEqual({
      text: "29 contributions, february 28 – march 7, 2021",
      url: PROFILE,
    });
    expect(describeGitHubActivityGroup([day("2021-02-27", 12), day("2021-02-21", 10)], NOW)).toEqual({
      text: "22 contributions, february 21 – 27, 2021",
      url: PROFILE,
    });
  });

  test("spells both years when a span crosses new year", () => {
    expect(describeGitHubActivityGroup([day("2026-01-02", 4), day("2025-12-30", 6)], NOW)).toEqual({
      text: "10 contributions, december 30, 2025 – january 2",
      url: PROFILE,
    });
  });

  test("dates rows from an earlier year", () => {
    expect(describeGitHubActivity(day("2021-03-04", 3), NOW)).toEqual({
      text: "3 contributions on march 4, 2021",
      url: PROFILE,
    });
  });

  test("keeps the singular readable", () => {
    expect(describeGitHubActivity(day("2026-05-20", 1), NOW)).toEqual({
      text: "1 contribution on may 20",
      url: PROFILE,
    });
  });
});
