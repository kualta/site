import { expect, test } from "bun:test";
import { clipTitle, dayLabel, momentLabel } from "./dates";

const now = new Date(2026, 10, 25, 9, 0).getTime();

test("a day is its date and month, with its year when that isn't this one, and its weekday when asked", () => {
  expect(dayLabel("2026-11-24", { now })).toBe("24 Nov");
  expect(dayLabel("2026-01-01", { now })).toBe("1 Jan");
  expect(dayLabel("2025-12-30", { now })).toBe("30 Dec 2025");
  expect(dayLabel("2026-11-21", { weekday: true, now })).toBe("Sat 21 Nov");
  expect(dayLabel("2025-11-21", { weekday: true, now })).toBe("Fri 21 Nov 2025");
  // A clip's recorded time, a moment, a Date: each by its own day.
  expect(dayLabel("2026-09-08T23:59:00", { now })).toBe("8 Sep");
  expect(dayLabel(new Date(2027, 1, 3, 0, 30), { now })).toBe("3 Feb 2027");
  expect(dayLabel(new Date(2026, 4, 9).getTime(), { now })).toBe("9 May");
  // What isn't a day is said as it is.
  expect(dayLabel("", { now })).toBe("");
  expect(dayLabel("Others", { now })).toBe("Others");
});

test("a moment is its day and time on a 24-hour clock, just the time when asked for today's", () => {
  expect(momentLabel(new Date(2026, 10, 21, 14, 5).getTime(), { now })).toBe("21 Nov, 14:05");
  expect(momentLabel(new Date(2025, 11, 31, 9, 0).getTime(), { now })).toBe("31 Dec 2025, 09:00");
  expect(momentLabel(new Date(2026, 10, 25, 8, 1).getTime(), { now })).toBe("25 Nov, 08:01");
  expect(momentLabel(new Date(2026, 10, 25, 8, 1).getTime(), { today: true, now })).toBe("08:01");
  expect(momentLabel(new Date(2026, 10, 24, 8, 1).getTime(), { today: true, now })).toBe("24 Nov, 08:01");
});

test("a camera clip is titled by when it was started and its number", () => {
  expect(clipTitle("DJI_20261121101500_0402_D.mp4", { now })).toBe("21 Nov, 10:15:00 · clip 0402");
  expect(clipTitle("DJI_20251121101500_0402_D", { now })).toBe("21 Nov 2025, 10:15:00 · clip 0402");
  expect(clipTitle("IMG_4857.MOV", { now })).toBeNull();
});
