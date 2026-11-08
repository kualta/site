import { platforms, type Platform } from "./presets";

/** When a platform's posts go out: its best times of day, how often, and on which days. */
export interface PlatformSchedule {
  /** "HH:MM" in the platform's time zone, best first. */
  times: string[];
  /** Hours that must pass between two posts on the platform. */
  minGapHours: number;
  /** The most posts in any seven days. */
  perWeek: number;
  /** Weekdays to post on, Sunday 0. Empty for any day. */
  days: number[];
  /** The audience's IANA time zone, such as "Asia/Shanghai"; empty for the browser's. */
  timeZone: string;
}
export type Schedule = Record<Platform, PlatformSchedule>;
export const SCHEDULE_KEY = "publisher.schedule.v1";
/** Uploads expire a week after they go up, so a post can be scheduled at most this far after its first upload. */
export const UPLOAD_LIFETIME = 7 * 86_400_000;
/** The laptop needs a little time before an upload expires. */
export const EXPIRY_MARGIN = 60 * 60_000;
/** How far ahead "Next free slot" looks. */
const HORIZON_DAYS = 14;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HOUR = 3_600_000;
const WEEK = 7 * 86_400_000;

/**
 * Defaults from published posting-time studies (Buffer, Sprout Social, Hootsuite, Adobe, vidIQ; 2025–2026) for a small
 * account posting short vertical videos. Farcaster, Lens and Grain have no published data, so theirs are reasoned
 * from their audiences. Sources and reasons are in docs/publisher-scheduling.md.
 */
export function defaultSchedule(): Schedule {
  return {
    instagram: { times: ["18:00", "12:00", "21:00"], minGapHours: 18, perWeek: 4, days: [1, 2, 3, 4], timeZone: "" },
    tiktok: { times: ["18:00", "21:00", "13:00"], minGapHours: 4, perWeek: 5, days: [], timeZone: "" },
    youtube: { times: ["16:00", "18:00", "19:00"], minGapHours: 12, perWeek: 4, days: [], timeZone: "" },
    twitter: { times: ["09:00", "13:00", "10:00"], minGapHours: 4, perWeek: 7, days: [], timeZone: "" },
    bluesky: { times: ["20:00", "17:00", "09:00"], minGapHours: 4, perWeek: 5, days: [], timeZone: "" },
    farcaster: { times: ["10:00", "14:00"], minGapHours: 4, perWeek: 5, days: [1, 2, 3, 4, 5], timeZone: "" },
    lens: { times: ["10:00", "20:00"], minGapHours: 12, perWeek: 3, days: [], timeZone: "" },
    // Its audience is in China, so its times are China's.
    xiaohongshu: {
      times: ["20:00", "12:00", "07:30"],
      minGapHours: 24,
      perWeek: 3,
      days: [],
      timeZone: "Asia/Shanghai",
    },
    grain: { times: ["20:00", "17:00"], minGapHours: 24, perWeek: 3, days: [], timeZone: "" },
  };
}

/** Whether this runtime knows the time zone. */
export function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Read untrusted local storage, keeping only valid values, and the defaults for the rest. */
export function parseSchedule(raw: string | null): Schedule {
  const schedule = defaultSchedule();
  let value: Record<string, Partial<PlatformSchedule>> | null = null;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    return schedule;
  }
  for (const platform of platforms) {
    const saved = value?.[platform];
    if (!saved || typeof saved !== "object") continue;
    const fallback = schedule[platform];
    const times = Array.isArray(saved.times) ? saved.times.filter((time) => TIME.test(String(time))).slice(0, 6) : [];
    const gap = Number(saved.minGapHours);
    const perWeek = Number(saved.perWeek);
    const days = Array.isArray(saved.days)
      ? saved.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      : null;
    const zone = saved.timeZone;
    schedule[platform] = {
      times: times.length ? [...new Set(times)] : fallback.times,
      minGapHours: Number.isFinite(gap) && gap >= 0 && gap <= 168 ? gap : fallback.minGapHours,
      perWeek: Number.isInteger(perWeek) && perWeek >= 1 && perWeek <= 50 ? perWeek : fallback.perWeek,
      days: days ? [...new Set(days)].sort() : fallback.days,
      timeZone: typeof zone === "string" && (zone === "" || validTimeZone(zone)) ? zone : fallback.timeZone,
    };
  }
  return schedule;
}

/** Parses a typed list of times such as "9:00, 18:30"; null when any of them isn't a time. */
export function parseTimes(text: string): string[] | null {
  const times = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((time) => (/^\d:\d\d$/.test(time) ? `0${time}` : time));
  return times.length && times.every((time) => TIME.test(time)) ? times : null;
}

/** How far ahead of UTC a time zone is at `time`, in ms; the browser's for an empty one. */
function offset(time: number, timeZone: string): number {
  if (!timeZone) return -new Date(time).getTimezoneOffset() * 60_000;
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(time))
    parts[part.type] = part.value;
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wall - Math.floor(time / 1000) * 1000;
}
/** A calendar day: year, month from 0, day of the month. */
type Day = [number, number, number];
/** The calendar day `time` falls on in a time zone. */
function dayOf(time: number, timeZone: string): Day {
  const date = new Date(time + offset(time, timeZone));
  return [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
}
/** A wall-clock time on a day in a time zone, as a timestamp. */
function at([year, month, date]: Day, time: string, timeZone: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  if (!timeZone) return new Date(year, month, date, hours, minutes).getTime();
  const wall = Date.UTC(year, month, date, hours, minutes);
  return wall - offset(wall - offset(wall, timeZone), timeZone);
}
/** A platform's slots on one day of its time zone, best first, as its times are listed. */
function slotsOn(day: Day, schedule: PlatformSchedule): number[] {
  return schedule.times.map((time) => at(day, time, schedule.timeZone));
}
/** Whether every seven days around `slot` keeps to the platform's posts a week with it added. */
function fitsWeek(slot: number, busy: number[], perWeek: number): boolean {
  const near = busy.filter((time) => time > slot - WEEK && time < slot + WEEK);
  const starts = [slot - WEEK + 1, ...near.flatMap((time) => [time, time - WEEK + 1])].filter(
    (start) => start > slot - WEEK && start <= slot,
  );
  return starts.every((start) => near.filter((time) => time >= start && time < start + WEEK).length < perWeek);
}

/**
 * The platform's best slot on its first free day: at or after `from`, on one of its days, at least its gap away from
 * every busy time (its posts already out or scheduled) and within its posts a week. Null when none falls in the next
 * two weeks.
 */
export function nextSlot(schedule: PlatformSchedule, busy: number[], from: number): number | null {
  const [year, month, date] = dayOf(from, schedule.timeZone);
  for (let ahead = 0; ahead < HORIZON_DAYS; ahead++) {
    const day = new Date(Date.UTC(year, month, date + ahead));
    if (schedule.days.length && !schedule.days.includes(day.getUTCDay())) continue;
    for (const slot of slotsOn([day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()], schedule))
      if (
        slot >= from &&
        busy.every((time) => Math.abs(time - slot) >= schedule.minGapHours * HOUR) &&
        fitsWeek(slot, busy, schedule.perWeek)
      )
        return slot;
  }
  return null;
}

/** The platform's best slot on a chosen day ("YYYY-MM-DD", that day in its time zone) that hasn't passed, or null. */
export function slotOnDay(schedule: PlatformSchedule, day: string, from: number): number | null {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return null;
  return slotsOn([year, month - 1, date], schedule).find((slot) => slot >= from) ?? null;
}

/** A timestamp as a `datetime-local` input's value, in the browser's time. */
export function localInput(time: number): string {
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}
