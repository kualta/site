import { expect, test } from "bun:test";
import { storyAge, storyTime } from "./stories-viewer";

test("a story says how long ago it went up, as Instagram does, and its exact time on its own clock", () => {
  const now = Date.parse("2026-11-17T04:30:00Z");
  const ages = [
    ["2026-11-16T23:29:40-05:00", "now"],
    ["2026-11-16T23:18:00-05:00", "12m"],
    ["2026-11-16T17:12:08-05:00", "6h"],
    ["2026-11-15T23:31:25-05:00", "23h"],
    ["2026-11-15T22:00:00-05:00", "1d"],
    ["2026-11-01T23:46:00-05:00", "2w"],
    ["2025-09-14T11:29:02-05:00", "1y"],
    ["not a date", ""],
  ];
  for (const [date, age] of ages) expect(storyAge(date, now)).toBe(age);
  // a story dated after the clock of whoever reads it is new, not negative
  expect(storyAge("2026-11-17T04:31:00Z", now)).toBe("now");
  expect(storyTime("2026-11-16T17:12:08-05:00")).toBe("Nov 16, 17:12");
});
