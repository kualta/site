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
/** Carry forward each destination's latest observation; never fill missing counts with zero. */
export function dailySeries(samples: Sample[], metric: Metric) {
  const latest = new Map<string, number>();
  const days = new Map<string, { day: string; value: number; coverage: number }>();
  for (const sample of [...samples].sort((a, b) => a.observed_at - b.observed_at)) {
    const value = metricValue(sample.metrics, metric);
    if (value === null) continue;
    latest.set(sample.target_id, value);
    const day = new Date(sample.observed_at).toISOString().slice(0, 10);
    days.set(day, { day, value: combined([...latest.values()])!, coverage: latest.size });
  }
  return [...days.values()];
}
