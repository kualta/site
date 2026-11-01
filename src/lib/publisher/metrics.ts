import type { Platform } from "./presets";

export const metricKeys = ["views", "impressions", "reach", "likes", "comments", "shares", "saves"] as const;
export type Metrics = Partial<Record<(typeof metricKeys)[number], number>>;
export type Metric = keyof Metrics | "exposure";
export function metricValue(metrics: Metrics | null | undefined, metric: Metric): number | null {
  if (!metrics) return null;
  return metric === "exposure" ? metrics.impressions ?? metrics.views ?? null : metrics[metric] ?? null;
}
export function combined(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}
export function validMetrics(value: unknown): Metrics {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Invalid metrics");
  const result: Metrics = {};
  for (const [key, count] of Object.entries(value)) {
    if (
      !metricKeys.includes(key as keyof Metrics) ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    )
      throw new SyntaxError("Invalid metrics");
    result[key as keyof Metrics] = count;
  }
  if (!Object.keys(result).length) throw new SyntaxError("No metrics available");
  return result;
}
export type Sample = { target_id: string; platform: Platform; observed_at: number; metrics: Metrics };
export type SeriesPoint = { at: number; value: number; coverage: number; parts: Partial<Record<Platform, number>> };
/** Bottom of the chart first. Fixed, so a platform's place never depends on its rank, and look-alike colors don't touch. */
export const stackOrder: readonly Platform[] = [
  "youtube",
  "bluesky",
  "tiktok",
  "lens",
  "farcaster",
  "xiaohongshu",
  "twitter",
  "grain",
  "instagram",
];
export function platformColor(platform: Platform) {
  return `var(--platform-${platform})`;
}
/** The platforms with a count at this point, top of the stack first to match what's on screen. */
export function reportingPlatforms(point: SeriesPoint) {
  return [...stackOrder].reverse().filter((platform) => point.parts[platform] !== undefined);
}
const HOUR = 3_600_000;
/** One point per hour. Carry forward each destination's latest observation; never fill missing counts with zero. */
export function metricSeries(samples: Sample[], metric: Metric) {
  const latest = new Map<Platform, number>();
  const hours = new Map<number, SeriesPoint>();
  for (const sample of [...samples].sort((a, b) => a.observed_at - b.observed_at)) {
    const value = metricValue(sample.metrics, metric);
    if (value === null) continue;
    latest.set(sample.platform, value);
    hours.set(Math.floor(sample.observed_at / HOUR), {
      at: sample.observed_at,
      value: combined([...latest.values()])!,
      coverage: latest.size,
      parts: Object.fromEntries(latest),
    });
  }
  return [...hours.values()];
}
export type DailyChange = { platform: Platform; day: number; at: number; change: number };
/** Running totals by day, from each platform's change that day; a day with no change carries the total. Rows arrive oldest first. */
export function cumulativeSeries(changes: DailyChange[]) {
  const totals = new Map<Platform, number>();
  const days = new Map<number, SeriesPoint>();
  for (const { platform, day, at, change } of changes) {
    totals.set(platform, (totals.get(platform) ?? 0) + change);
    days.set(day, {
      at: Math.max(at, days.get(day)?.at ?? 0),
      value: combined([...totals.values()])!,
      coverage: totals.size,
      parts: Object.fromEntries(totals),
    });
  }
  const points: SeriesPoint[] = [];
  let previousDay = 0;
  for (const [day, point] of days) {
    const previous = points.at(-1);
    if (previous) {
      for (let gap = 1; gap < day - previousDay; gap++) {
        points.push({ ...previous, at: previous.at + gap * 24 * HOUR });
      }
    }
    points.push(point);
    previousDay = day;
  }
  return points;
}
/**
 * Each day's change by platform, placed at the middle of the reader's day. A day nothing was read has no point: its
 * views land on the next day that was, instead of showing as a day with none. `utcOffset` is in minutes.
 */
export function dailySeries(changes: DailyChange[], utcOffset: number) {
  const days = new Map<number, SeriesPoint>();
  for (const { platform, day, change } of changes) {
    const point = days.get(day) ?? {
      at: (day + 0.5) * 24 * HOUR - utcOffset * 60_000,
      value: 0,
      coverage: 0,
      parts: {},
    };
    point.parts[platform] = change;
    point.value += change;
    point.coverage += 1;
    days.set(day, point);
  }
  return [...days.values()];
}
/** A period's days added into one, for what each platform brought in across all of them. */
export function addUp(points: SeriesPoint[]): SeriesPoint {
  const total: SeriesPoint = { at: points.at(-1)?.at ?? 0, value: 0, coverage: 0, parts: {} };
  for (const point of points) {
    total.value += point.value;
    for (const platform of stackOrder) {
      const part = point.parts[platform];
      if (part !== undefined) total.parts[platform] = (total.parts[platform] ?? 0) + part;
    }
  }
  total.coverage = Object.keys(total.parts).length;
  return total;
}
/** How far a stack reaches below and above zero. Only a platform correcting its count can go below. */
export function stackExtent(point: SeriesPoint) {
  let low = 0;
  let high = 0;
  for (const part of Object.values(point.parts)) {
    if (part < 0) low += part;
    else high += part;
  }
  return { low, high };
}
const ago = new Intl.RelativeTimeFormat("en");
/** "just now", "12 minutes ago", "9 hours ago", "3 days ago". */
export function timeAgo(at: number, now: number) {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return ago.format(-minutes, "minute");
  if (minutes < 48 * 60) return ago.format(-Math.floor(minutes / 60), "hour");
  return ago.format(-Math.floor(minutes / (24 * 60)), "day");
}
export type VideoMark = { id: string; at: number; label: string; thumbnail: string | null };
/** Videos too close together to mark separately on an axis of this span share one mark. Marks arrive oldest first. */
export function groupMarks(marks: VideoMark[], [start, end]: [number, number]) {
  const reach = (end - start) * 0.04;
  const groups: VideoMark[][] = [];
  for (const mark of marks) {
    const group = groups.at(-1);
    if (group && mark.at - group[0].at <= reach) group.push(mark);
    else groups.push([mark]);
  }
  return groups;
}
/** Whole-number axis marks from zero, at a round step, reaching at least `max`. */
export function valueTicks(max: number, min = 0) {
  const third = Math.max(max, -min) / 3;
  const scale = 10 ** Math.floor(Math.log10(Math.max(1, third)));
  const step = [1, 2, 5, 10].map((n) => n * scale).find((n) => n >= third)!;
  const ticks = [0];
  while (ticks.at(-1)! < max || ticks.length < 2) ticks.push(ticks.at(-1)! + step);
  // A small correction isn't worth a whole step of axis below zero.
  while (ticks[0] - step / 2 >= min) ticks.unshift(ticks[0] - step);
  return ticks;
}
/** Up to seven days to label, picked from the ones that have a bar so each label sits under one. */
export function dayTicks(points: SeriesPoint[]) {
  const stride = Math.ceil(points.length / 7);
  return points.filter((_, index) => index % stride === 0).map((point) => point.at);
}
/** Up to five date marks on local hour or midnight boundaries. */
export function timeTicks(min: number, max: number) {
  const steps = [0.25, 0.5, 1, 3, 6, 12, 24, 48, 168, 336, 720, 2160, 4320].map((hours) => hours * HOUR);
  const step = steps.find((s) => (max - min) / s <= 5) ?? steps.at(-1)!;
  const offset = new Date(min).getTimezoneOffset() * 60_000;
  const ticks = [];
  for (let at = Math.ceil((min - offset) / step) * step + offset; at <= max; at += step) ticks.push(at);
  return ticks;
}
