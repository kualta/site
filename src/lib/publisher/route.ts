import type { Metric } from "./metrics";
import type { PostKind } from "./presets";

export type Tab = "compose" | "history" | "calendar" | "analytics" | "accounts";
const TAB = /\/(history|calendar|analytics|accounts)\/?$/;
/**
 * Which tab a path opens, and the composer's own path: `/` or another tab's own, such as `/history`, on
 * post.kualta.dev, `/publish…` locally.
 */
export function readPath(pathname: string): { base: string; tab: Tab } {
  return {
    base: pathname.replace(TAB, "").replace(/\/+$/, ""),
    tab: (pathname.match(TAB)?.[1] as Tab | undefined) ?? "compose",
  };
}
export function tabPath(base: string, tab: Tab) {
  return tab === "compose" ? base || "/" : `${base}/${tab}`;
}

/** The month the Calendar tab shows, "YYYY-MM", from its address; this month without one. */
export function readMonth(search: string, now = new Date()): string {
  const month = new URLSearchParams(search).get("month") ?? "";
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return month;
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export const postTypes = ["video", "photo", "text"] as const;
export type PostType = (typeof postTypes)[number];
export const typeNames: Record<PostType, string> = { video: "Videos", photo: "Photos", text: "Text" };
/** A carousel with a video in it counts as a video. */
const typeKinds: Record<PostType, PostKind[]> = { video: ["video", "mixed"], photo: ["photo"], text: ["text"] };
export const kindsOf = (types: readonly PostType[]) => types.flatMap((type) => typeKinds[type]);
/** Days a chart reaches back; 0 is all time. */
export const periods = [7, 30, 90, 0] as const;
const metrics: Metric[] = ["exposure", "views", "impressions", "reach", "likes", "comments", "shares", "saves"];

/** Everything the Analytics tab is showing, kept in its URL so a reload, a link or Back opens the same view. */
export interface AnalyticsView {
  /** The kinds of post listed and counted. */
  types: PostType[];
  period: number;
  daily: boolean;
  /** The page of posts, by the cursor it starts after. */
  before: string | null;
  post: string | null;
  platform: string;
  metric: Metric;
}
export const defaultView: AnalyticsView = {
  types: ["video", "photo"],
  period: 30,
  daily: false,
  before: null,
  post: null,
  platform: "all",
  metric: "exposure",
};
export function readView(search: string): AnalyticsView {
  const params = new URLSearchParams(search);
  const types = params.get("type")?.split(",") ?? [];
  const period = params.get("period") === "all" ? 0 : Number(params.get("period"));
  const metric = params.get("metric") as Metric;
  const chosen = postTypes.filter((type) => types.includes(type));
  return {
    types: chosen.length ? chosen : defaultView.types,
    period: params.has("period") && (periods as readonly number[]).includes(period) ? period : defaultView.period,
    daily: params.get("chart") === "daily",
    before: params.get("before") || null,
    post: params.get("post") || null,
    platform: params.get("platform") || "all",
    metric: metrics.includes(metric) ? metric : "exposure",
  };
}
/** The query that opens `view`, without what's already the default, so a plain view keeps a plain link. */
export function writeView(view: AnalyticsView): string {
  const entries: [string, string][] = [];
  const types = postTypes.filter((type) => view.types.includes(type));
  if (view.post) entries.push(["post", view.post]);
  if (view.platform !== "all") entries.push(["platform", view.platform]);
  if (view.metric !== "exposure") entries.push(["metric", view.metric]);
  if (view.period !== defaultView.period) entries.push(["period", view.period ? String(view.period) : "all"]);
  if (view.daily) entries.push(["chart", "daily"]);
  if (types.length && types.join() !== defaultView.types.join()) entries.push(["type", types.join(",")]);
  if (view.before) entries.push(["before", view.before]);
  const query = entries.map(
    ([key, value]) => `${key}=${encodeURIComponent(value).replace(/%2C/g, ",").replace(/%3A/g, ":")}`,
  );
  return query.length ? `?${query.join("&")}` : "";
}
