/*
 * Dates as the composer shows them, the same whatever the browser's language: day, month, year, as in Britain. An ISO
 * day (2026-11-24) stays in addresses, ids and data; it's only ever shown like this.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

interface Options {
  /** With its weekday first: "Sat 21 Nov". */
  weekday?: boolean;
  /** What "this year" is reckoned from. */
  now?: number;
}

/**
 * A day: "24 Nov", with its year when it isn't this one ("24 Nov 2025"). From an ISO day, or a local time that starts
 * with one (a clip's recorded time), or a moment, by this browser's clock. Anything else is said as it is.
 */
export function dayLabel(day: string | number | Date, { weekday = false, now = Date.now() }: Options = {}): string {
  let ymd: number[];
  if (typeof day === "string") {
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(day);
    if (!iso) return day;
    ymd = iso.slice(1).map(Number);
  } else {
    const date = new Date(day);
    ymd = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  }
  const [year, month, date] = ymd;
  const text = `${date} ${MONTHS[month - 1]}${year === new Date(now).getFullYear() ? "" : ` ${year}`}`;
  return weekday ? `${WEEKDAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()]} ${text}` : text;
}

/**
 * A moment by this browser's clock: "21 Nov, 10:15", its day as dayLabel says it. With `today`, a moment today is just
 * its time.
 */
export function momentLabel(at: number, { today = false, now = Date.now() }: { today?: boolean; now?: number } = {}) {
  const date = new Date(at);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (today && date.toDateString() === new Date(now).toDateString()) return time;
  return `${dayLabel(date, { now })}, ${time}`;
}

/** A camera clip by when the camera started it and its number: "21 Nov, 10:15:00 · clip 0402"; null for another file. */
export function clipTitle(name: string, { now = Date.now() }: { now?: number } = {}) {
  const shot = /^DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_(\d+)/.exec(name);
  if (!shot) return null;
  const [, year, month, date, hour, minute, second, number] = shot;
  return `${dayLabel(`${year}-${month}-${date}`, { now })}, ${hour}:${minute}:${second} · clip ${number}`;
}
