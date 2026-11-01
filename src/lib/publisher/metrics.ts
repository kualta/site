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
export type Sample = { target_id: string; observed_at: number; metrics: Metrics };
export type SeriesPoint = { at: number; value: number; coverage: number };
const HOUR = 3_600_000;
/** One point per hour. Carry forward each destination's latest observation; never fill missing counts with zero. */
export function metricSeries(samples: Sample[], metric: Metric) {
  const latest = new Map<string, number>();
  const hours = new Map<number, SeriesPoint>();
  for (const sample of [...samples].sort((a, b) => a.observed_at - b.observed_at)) {
    const value = metricValue(sample.metrics, metric);
    if (value === null) continue;
    latest.set(sample.target_id, value);
    hours.set(Math.floor(sample.observed_at / HOUR), {
      at: sample.observed_at,
      value: combined([...latest.values()])!,
      coverage: latest.size,
    });
  }
  return [...hours.values()];
}
/** Whole-number axis marks from zero, at a round step, reaching at least `max`. */
export function valueTicks(max: number) {
  const scale = 10 ** Math.floor(Math.log10(Math.max(1, max / 3)));
  const step = [1, 2, 5, 10].map((n) => n * scale).find((n) => n >= max / 3)!;
  const ticks = [0];
  while (ticks.at(-1)! < max || ticks.length < 2) ticks.push(ticks.at(-1)! + step);
  return ticks;
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
