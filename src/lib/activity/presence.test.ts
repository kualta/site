import { describe, expect, test } from "bun:test";
import {
  formatLastSeenTime,
  formatPresenceChance,
  formatRelativeTime,
  getPresenceChance,
  getPresenceState,
  getPresenceTier,
} from "./presence";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function seenAgo(age: number): string {
  return new Date(NOW - age).toISOString();
}

describe("getPresenceChance", () => {
  test.each([
    [0, 1],
    [6 * HOUR, 0.9933],
    [2 * DAY, 0.8675],
    [7 * DAY, 0.5],
    [14 * DAY, 0.2612],
    [60 * DAY, 0.0383],
  ] as const)("gives an age of %i ms a chance of %d", (age, expected) => {
    expect(getPresenceChance(seenAgo(age), NOW)).toBeCloseTo(expected, 4);
  });

  test("falls with every minute of silence and never reaches 0", () => {
    let previous = 1;
    for (let age = HOUR; age <= 365 * DAY; age += HOUR) {
      const chance = getPresenceChance(seenAgo(age), NOW);
      expect(chance).toBeLessThan(previous);
      expect(chance).toBeGreaterThan(0);
      previous = chance;
    }
  });

  test("treats future activity as just seen", () => {
    expect(getPresenceChance(new Date(NOW + HOUR).toISOString(), NOW)).toBe(1);
  });

  test("gives no chance without a valid sign", () => {
    expect(getPresenceChance(null, NOW)).toBe(0);
    expect(getPresenceChance("not-a-date", NOW)).toBe(0);
  });
});

describe("getPresenceTier", () => {
  test.each([
    [1, "almost-certain"],
    [0.945, "almost-certain"],
    [0.9449, "very-likely"],
    [0.795, "very-likely"],
    [0.7949, "likely"],
    [0.545, "likely"],
    [0.5449, "even-odds"],
    [0.445, "even-odds"],
    [0.4449, "unlikely"],
    [0.195, "unlikely"],
    [0.1949, "very-unlikely"],
    [0.045, "very-unlikely"],
    [0.0449, "almost-no-chance"],
    [0, "almost-no-chance"],
  ] as const)("puts a chance of %d in %s, matching the rounded percentage", (chance, expected) => {
    expect(getPresenceTier(chance)).toBe(expected);
  });

  test("reads the tier straight from the time since last seen", () => {
    expect(getPresenceState(seenAgo(HOUR), NOW)).toBe("almost-certain");
    expect(getPresenceState(seenAgo(7 * DAY), NOW)).toBe("even-odds");
    expect(getPresenceState(null, NOW)).toBe("almost-no-chance");
  });
});

describe("formatPresenceChance", () => {
  test.each([
    [1, ">99%"],
    [0.991, ">99%"],
    [0.99, "99%"],
    [0.5, "50%"],
    [0.0383, "4%"],
    [0.01, "1%"],
    [0.0099, "<1%"],
    [0, "<1%"],
  ] as const)("shows a chance of %d as %s", (chance, expected) => {
    expect(formatPresenceChance(chance)).toBe(expected);
  });
});

describe("formatRelativeTime", () => {
  test.each([
    [0, "now"],
    [59_000, "now"],
    [60_000, "1m"],
    [59 * 60_000, "59m"],
    [60 * 60_000, "1h"],
    [24 * 60 * 60_000, "1d"],
  ] as const)("formats an age of %i ms as %s", (age, expected) => {
    expect(formatRelativeTime(seenAgo(age), NOW)).toBe(expected);
  });
});

describe("formatLastSeenTime", () => {
  test("uses the newest event timestamp", () => {
    expect(formatLastSeenTime(seenAgo(60_000), NOW)).toBe("last seen 1m ago");
  });

  test("handles activity from the current minute", () => {
    expect(formatLastSeenTime(seenAgo(0), NOW)).toBe("last seen just now");
  });
});

test("delayed status follows cache freshness even when polls fail", async () => {
  const { isActivityDelayed } = await import("./presence");
  const until = "2026-10-04T13:05:00Z";
  expect(isActivityDelayed(until, Date.parse(until))).toBe(false);
  expect(isActivityDelayed(until, Date.parse(until) + 1)).toBe(true);
  expect(isActivityDelayed(null)).toBe(true);
  expect(isActivityDelayed(undefined)).toBe(true);
});

test("server clock ages independently of skew and later wall-clock corrections", async () => {
  const { createServerClock, isActivityDelayed } = await import("./presence");
  const timestamp = "2026-10-04T13:00:00Z";
  const deadline = "2026-10-04T13:05:00Z";
  for (const skew of [-3_600_000, 3_600_000]) {
    const original = Date.now;
    try {
      Date.now = () => Date.parse(timestamp) + skew;
      const clock = createServerClock(timestamp, 100)!;
      expect(isActivityDelayed(deadline, clock(100))).toBe(false);
      Date.now = () => Date.parse(timestamp) - skew * 2;
      expect(isActivityDelayed(deadline, clock(300_101))).toBe(true);
      expect(isActivityDelayed("2026-10-04T12:59:00Z", clock(100))).toBe(true);
      expect(clock(50)).toBe(Date.parse(timestamp));
    } finally {
      Date.now = original;
    }
  }
  expect(createServerClock("invalid", 100)).toBeUndefined();
});
