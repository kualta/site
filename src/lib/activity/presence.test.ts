import { describe, expect, test } from "bun:test";
import { formatLastSeenTime, formatRelativeTime, getPresenceState } from "./presence";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function seenAgo(age: number): string {
  return new Date(NOW - age).toISOString();
}

describe("getPresenceState", () => {
  test.each([
    [6 * HOUR, "definitely-alive"],
    [6 * HOUR + 1, "most-likely-alive"],
    [2 * DAY, "most-likely-alive"],
    [2 * DAY + 1, "somewhere-else"],
    [7 * DAY, "somewhere-else"],
    [7 * DAY + 1, "kinda-lost"],
    [14 * DAY, "kinda-lost"],
    [14 * DAY + 1, "not-around"],
    [60 * DAY, "not-around"],
    [60 * DAY + 1, "most-likely-dead"],
  ] as const)("maps age %i to %s", (age, expected) => {
    expect(getPresenceState(seenAgo(age), NOW)).toBe(expected);
  });

  test("clamps future activity to the newest band", () => {
    expect(getPresenceState(new Date(NOW + HOUR).toISOString(), NOW)).toBe("definitely-alive");
  });

  test("uses the oldest band when no valid event exists", () => {
    expect(getPresenceState(null, NOW)).toBe("most-likely-dead");
    expect(getPresenceState("not-a-date", NOW)).toBe("most-likely-dead");
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
