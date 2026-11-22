import type { Tab } from "./route";

/** A share of 1 as the whole percentage the title shows; null for anything else, such as a message gone wrong. */
export function wholePercent(share: unknown): number | null {
  return typeof share === "number" && share >= 0 && share <= 1 ? Math.floor(share * 100) : null;
}

/** The page's title: the open tab, after the percentage of what's going up there, so a narrow browser tab shows it. */
export function tabTitle(tab: Tab, percent: number | null = null): string {
  const name = `${tab} · kualta`;
  return percent === null ? name : `${percent}% · ${name}`;
}
