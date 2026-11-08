import { describe, expect, test } from "bun:test";
import { defaultSchedule, localInput, nextSlot, parseSchedule, parseTimes, slotOnDay } from "./schedule";

// The test runs in whatever time zone the machine has; these are the browser's local times.
const at = (day: number, hours: number, minutes = 0) => new Date(2026, 10, day, hours, minutes).getTime();
const hour = 3_600_000;
const daily = { times: ["11:00", "18:00"], minGapHours: 20, perWeek: 7, days: [], timeZone: "" };

describe("posting times", () => {
  test("a day's slot is its best time still open, as the times are listed, not the earliest", () => {
    const evenings = { ...daily, times: ["20:00", "09:00"] };
    expect(slotOnDay(evenings, "2026-11-09", at(8, 20))).toBe(at(9, 20));
    expect(nextSlot(evenings, [], at(9, 8))).toBe(at(9, 20));
    // Its best time taken by another post, the day's next best stands in.
    expect(nextSlot({ ...evenings, minGapHours: 4 }, [at(9, 19)], at(9, 8))).toBe(at(9, 9));
    expect(nextSlot(evenings, [], at(9, 21))).toBe(at(10, 20));
  });

  test("the next slot is the platform's first time that hasn't passed", () => {
    expect(nextSlot(daily, [], at(8, 9))).toBe(at(8, 11));
    expect(nextSlot(daily, [], at(8, 12))).toBe(at(8, 18));
    expect(nextSlot(daily, [], at(8, 19))).toBe(at(9, 11));
  });

  test("keeps the platform's gap from its posts already out or scheduled, before and after", () => {
    // Posted this morning: the next is tomorrow at 11, 25 hours on.
    expect(nextSlot(daily, [at(8, 10)], at(8, 12))).toBe(at(9, 11));
    // Tomorrow 11:00 is taken by another post, and 18:00 is only 7 hours after it.
    expect(nextSlot(daily, [at(9, 11)], at(8, 19))).toBe(at(10, 11));
    // A post scheduled later doesn't let an earlier slot crowd it either.
    expect(nextSlot(daily, [at(9, 18)], at(9, 9))).toBe(at(10, 18));
    // Two posts scheduled one after the other land on consecutive days.
    const first = nextSlot(daily, [], at(8, 19)) as number;
    expect(nextSlot(daily, [first], at(8, 19))).toBe(at(10, 11));
  });

  test("keeps to the platform's posts a week", () => {
    const twice = { ...daily, minGapHours: 0, perWeek: 2 };
    // Two posts on the 3rd and 5th: the next fits once the 3rd is a week back.
    expect(nextSlot(twice, [at(3, 11), at(5, 11)], at(8, 9))).toBe(at(10, 11));
    // A post a week ahead counts too: the 9th would make three in the seven days to the 15th.
    expect(nextSlot(twice, [at(12, 11), at(15, 11)], at(8, 9))).toBe(at(8, 11));
    // With posts on the 8th and 12th, the next fits once the 8th is a week back.
    expect(nextSlot(twice, [at(8, 11), at(12, 11)], at(8, 9))).toBe(at(15, 11));
  });

  test("keeps to the platform's days", () => {
    // 8 Nov 2026 is a Sunday; this platform posts on Tuesdays and Thursdays.
    expect(nextSlot({ ...daily, days: [2, 4] }, [], at(8, 9))).toBe(at(10, 11));
  });

  test("gives up after two weeks", () => {
    expect(nextSlot({ ...daily, days: [3] }, [at(11, 11), at(18, 11)], at(8, 9))).toBeNull();
    expect(nextSlot({ ...daily, minGapHours: 24 * 15 }, [at(8, 8)], at(8, 9))).toBeNull();
  });

  test("a platform's times are in its audience's time zone", () => {
    const china = { ...daily, times: ["20:00"], timeZone: "Asia/Shanghai" };
    // 20:00 in Shanghai (UTC+8, no daylight saving) is 12:00 UTC.
    expect(nextSlot(china, [], Date.UTC(2026, 10, 8, 0))).toBe(Date.UTC(2026, 10, 8, 12));
    expect(nextSlot(china, [], Date.UTC(2026, 10, 8, 13))).toBe(Date.UTC(2026, 10, 9, 12));
    // A day there starts eight hours before a day in UTC.
    expect(slotOnDay(china, "2026-11-09", 0)).toBe(Date.UTC(2026, 10, 9, 12));
    const newYork = { ...daily, times: ["09:00"], timeZone: "America/New_York" };
    // Across the daylight-saving change on 1 Nov 2026: 13:00 UTC before it, 14:00 UTC after.
    expect(slotOnDay(newYork, "2026-10-31", 0)).toBe(Date.UTC(2026, 9, 31, 13));
    expect(slotOnDay(newYork, "2026-11-02", 0)).toBe(Date.UTC(2026, 10, 2, 14));
  });

  test("a chosen day gives the platform's first time on it that hasn't passed", () => {
    expect(slotOnDay(daily, "2026-11-09", at(8, 20))).toBe(at(9, 11));
    expect(slotOnDay(daily, "2026-11-09", at(9, 12))).toBe(at(9, 18));
    expect(slotOnDay(daily, "2026-11-09", at(9, 19))).toBeNull();
    expect(slotOnDay(daily, "", at(9, 9))).toBeNull();
  });

  test("saved times keep valid values only, with the defaults for the rest", () => {
    const defaults = defaultSchedule();
    expect(parseSchedule(null)).toEqual(defaults);
    expect(parseSchedule("{")).toEqual(defaults);
    const saved = parseSchedule(
      JSON.stringify({
        tiktok: {
          times: ["21:00", "25:00", "21:00"],
          minGapHours: 12,
          perWeek: 3,
          days: [5, 9, 5, 1],
          timeZone: "Asia/Tokyo",
        },
        instagram: { times: [], minGapHours: -1, perWeek: 0, days: "all", timeZone: "Mars/Olympus" },
        xiaohongshu: { timeZone: "" },
        nowhere: { times: ["10:00"] },
      }),
    );
    expect(saved.tiktok).toEqual({
      times: ["21:00"],
      minGapHours: 12,
      perWeek: 3,
      days: [1, 5],
      timeZone: "Asia/Tokyo",
    });
    expect(saved.instagram).toEqual(defaults.instagram);
    // Cleared, it follows the browser's time zone.
    expect(saved.xiaohongshu.timeZone).toBe("");
    expect(saved).not.toHaveProperty("nowhere");
  });

  test("typed times read as HH:MM, and anything else is refused", () => {
    expect(parseTimes("9:00, 18:30")).toEqual(["09:00", "18:30"]);
    expect(parseTimes("18:00 7pm")).toBeNull();
    expect(parseTimes(" ")).toBeNull();
  });

  test("a time shows in a datetime-local input as local time", () => {
    expect(localInput(at(9, 7, 5))).toBe("2026-11-09T07:05");
    expect(localInput(at(9, 7, 5) + 30 * hour)).toBe("2026-11-10T13:05");
  });
});
