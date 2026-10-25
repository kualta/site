import { describe, expect, test } from "bun:test";
import { describeGitHubActivity } from "../describe-github";
import { getInitialActivityFeed, refreshScheduledActivity } from "../feed";
import type { GitHubContributionsActivity, ProviderContext } from "../types";
import { githubProvider, normalizeContributionCalendar } from "./github";

const NOW = new Date("2026-10-25T13:00:00.000Z");

// GitHub's cells expose intensity in data-level; the exact total is in the
// tooltip associated by id/for, which need not be adjacent or in date order.
function calendar(entries: [string, number][]): string {
  return (
    entries
      .map(
        ([date], index) =>
          `<td tabindex="0" data-date="${date}" id="contribution-day-component-${index}" data-level="3" role="gridcell"></td>`,
      )
      .join("\n") +
    entries
      .map(
        ([, count], index) =>
          `<tool-tip id="tooltip-${index}" for="contribution-day-component-${index}" popover="manual" class="sr-only">${
            count === 0 ? "No" : count.toLocaleString("en-US")
          } ${count === 1 ? "contribution" : "contributions"} on October 21st.</tool-tip>`,
      )
      .reverse()
      .join("\n")
  );
}

function providerContext(html: string, status = 200): ProviderContext {
  return {
    now: NOW,
    secrets: { githubToken: "test-token" },
    signal: new AbortController().signal,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (url.hostname === "github.com") {
        expect(headers.has("Authorization")).toBe(false);
        expect(headers.has("Cookie")).toBe(false);
        expect(headers.get("Accept-Language")).toBe("en-US");
        expect(init?.signal).toBeDefined();
        expect(url.pathname).toBe("/users/kualta/contributions");
        const year = url.searchParams.get("from")?.slice(0, 4);
        expect(url.searchParams.get("to")).toBe(`${year}-12-31`);
        return new Response(year === "2026" ? html : calendar([["2020-10-12", 3]]), { status });
      }
      expect(url.hostname).toBe("api.github.com");
      expect(headers.get("Authorization")).toBe("Bearer test-token");
      if (url.pathname === "/user") return Response.json({ login: "kualta" });
      if (url.pathname === "/users/kualta/events") return Response.json([]);
      expect(url.pathname).toBe("/graphql");
      const body = JSON.parse(String(init?.body));
      expect(body.query).toContain("contributionYears");
      expect(body.query).not.toContain("contributionCalendar");
      return Response.json({ data: { user: { contributionsCollection: { contributionYears: [2026, 2020] } } } });
    },
  };
}

describe("public GitHub contribution calendar", () => {
  test("uses exact tooltip totals paired to dates, including zero and singular counts", () => {
    const days = normalizeContributionCalendar(
      calendar([
        ["2026-10-20", 29],
        ["2026-10-21", 103],
        ["2026-10-22", 172],
        ["2026-10-23", 0],
        ["2026-10-24", 1],
        ["2026-10-25", 1234],
        ["2026-10-26", 99],
      ]),
      2026,
      NOW,
    ) as GitHubContributionsActivity[];
    expect(days.map((day) => [day.id, day.count])).toEqual([
      ["github:contributions:2026-10-20", 29],
      ["github:contributions:2026-10-21", 103],
      ["github:contributions:2026-10-22", 172],
      ["github:contributions:2026-10-24", 1],
      ["github:contributions:2026-10-25", 1234],
    ]);
    expect(days[1].occurredAt).toBe("2026-10-21T23:59:59.999Z");
    expect(days.at(-1)?.occurredAt).toBe(NOW.toISOString());
    expect(describeGitHubActivity(days[1], +NOW).text).toBe("103 contributions on october 21");
  });

  test("accepts reordered attributes and single quotes", () => {
    expect(
      normalizeContributionCalendar(
        "<td id='day' data-date='2026-10-21'></td><tool-tip class='sr-only' for='day'>103 contributions on October 21st.</tool-tip>",
        2026,
        NOW,
      )[0],
    ).toMatchObject({ count: 103 });
  });

  test("an all-zero calendar is valid", () => {
    expect(normalizeContributionCalendar(calendar([["2026-10-21", 0]]), 2026, NOW)).toEqual([]);
  });

  test("rejects missing or invalid cells and totals instead of inferring inactivity", () => {
    for (const html of [
      "<html>Sign in</html>",
      calendar([["2026-10-21", 103]]).replace(/<tool-tip.*<\/tool-tip>/, ""),
      calendar([["2026-10-21", 103]]).replace("103 contributions", "many contributions"),
      calendar([["2026-02-30", 103]]),
      calendar([["2025-10-21", 103]]),
      calendar([
        ["2026-10-21", 103],
        ["2026-10-21", 103],
      ]),
    ]) {
      expect(() => normalizeContributionCalendar(html, 2026, NOW)).toThrow("invalid contributions calendar");
    }
  });

  test("the provider fetches the public calendar for every available year without credentials", async () => {
    const days = await githubProvider.fetch(
      providerContext(
        calendar([
          ["2026-10-21", 103],
          ["2026-10-22", 172],
        ]),
      ),
    );
    expect(days).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "github:contributions:2026-10-21", count: 103 }),
        expect.objectContaining({ id: "github:contributions:2026-10-22", count: 172 }),
        expect.objectContaining({ id: "github:contributions:2020-10-12", count: 3 }),
      ]),
    );
  });

  test("scheduled refresh repairs cached undercounts and preserves them on a later calendar failure", async () => {
    const events = [
      {
        id: "github:contributions:2026-10-21",
        source: "github",
        kind: "contributions",
        occurredAt: "2026-10-21T15:11:30.698Z",
        count: 4,
      },
    ];
    const values = new Map([["activity:archive:v3", JSON.stringify({ version: 3, events })]]);
    const cache = {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async put(key: string, value: string) {
        values.set(key, value);
      },
    };
    const context = providerContext(
      calendar([
        ["2026-10-21", 103],
        ["2026-10-22", 172],
      ]),
    );
    const logger = { info() {}, warn() {} };
    const options = {
      cache,
      fetch: context.fetch,
      githubToken: "test-token",
      providers: [githubProvider],
      now: NOW,
      logger,
    };
    await refreshScheduledActivity(options);
    const repaired = await getInitialActivityFeed(options);
    expect(repaired.events.find((event) => event.id === events[0].id)).toMatchObject({ count: 103 });
    expect(repaired.events.find((event) => event.id === "github:contributions:2026-10-22")).toMatchObject({
      count: 172,
    });

    for (const [index, failed] of [
      providerContext("Unavailable", 503),
      providerContext("<html>Sign in</html>"),
    ].entries()) {
      await refreshScheduledActivity({ ...options, fetch: failed.fetch, now: new Date(+NOW + (index + 1) * 120_000) });
      const retained = await getInitialActivityFeed(options);
      expect(retained.events).toEqual(repaired.events);
      expect(retained.sources.github.fetchedAt).toBe(repaired.sources.github.fetchedAt);
    }
  });
});
