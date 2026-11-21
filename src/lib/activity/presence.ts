import type { PresenceState } from "./types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});
const DAY_FORMATTER = new Intl.DateTimeFormat("en", { month: "long", day: "numeric", timeZone: "UTC" });
const DATED_DAY_FORMATTER = new Intl.DateTimeFormat("en", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Even odds after a week of silence. Gaps between a person's public activity
 * are heavy-tailed (Barabási, "The origin of bursts and heavy tails in human
 * dynamics", 2005), so the chance follows a log-logistic survival curve: it
 * falls quickly over the first days, then ever more slowly, and never reaches 0.
 */
const PRESENCE_MEDIAN_SILENCE = 7 * DAY;
const PRESENCE_SHAPE = 1.5;

/** split so the half that actually changes can be styled on its own */
export const PRESENCE_PARTS: Record<PresenceState, { lead: string; status: string }> = {
  "almost-certain": { lead: "kualta is", status: "almost certainly alive" },
  "very-likely": { lead: "kualta is", status: "very likely alive" },
  likely: { lead: "kualta is", status: "likely alive" },
  "even-odds": { lead: "kualta is", status: "as likely alive as not" },
  unlikely: { lead: "kualta is", status: "unlikely to be alive" },
  "very-unlikely": { lead: "kualta is", status: "very unlikely to be alive" },
  "almost-no-chance": { lead: "kualta is", status: "almost certainly dead" },
  unknown: { lead: "kualta's whereabouts are", status: "unknown" },
};

/**
 * The bands of US Intelligence Community Directive 203, by the lowest whole
 * percentage each one covers; a shared edge belongs to the band above.
 */
const PRESENCE_TIERS: ReadonlyArray<{
  minimumPercent: number;
  state: Exclude<PresenceState, "unknown">;
}> = [
  { minimumPercent: 95, state: "almost-certain" },
  { minimumPercent: 80, state: "very-likely" },
  { minimumPercent: 55, state: "likely" },
  { minimumPercent: 45, state: "even-odds" },
  { minimumPercent: 20, state: "unlikely" },
  { minimumPercent: 5, state: "very-unlikely" },
  { minimumPercent: 0, state: "almost-no-chance" },
];

/** the chance, from 0 to 1, that kualta is alive after this long without a public sign */
export function getPresenceChance(lastSeenAt: string | null, now: Date | number = Date.now()): number {
  if (!lastSeenAt) return 0;

  const occurredAt = Date.parse(lastSeenAt);
  if (!Number.isFinite(occurredAt)) return 0;

  const nowMs = typeof now === "number" ? now : now.getTime();
  const age = Math.max(0, nowMs - occurredAt);
  return 1 / (1 + (age / PRESENCE_MEDIAN_SILENCE) ** PRESENCE_SHAPE);
}

/** the words follow the shown percentage, so "95%" never sits beside "very likely" */
export function getPresenceTier(chance: number): Exclude<PresenceState, "unknown"> {
  const percent = Math.round(chance * 100);
  return PRESENCE_TIERS.find(({ minimumPercent }) => percent >= minimumPercent)?.state ?? "almost-no-chance";
}

export function getPresenceState(
  lastSeenAt: string | null,
  now: Date | number = Date.now(),
): Exclude<PresenceState, "unknown"> {
  return getPresenceTier(getPresenceChance(lastSeenAt, now));
}

/** 0 and 1 are not probabilities, so the ends read as ">99%" and "<1%" */
export function formatPresenceChance(chance: number): string {
  if (chance > 0.99) return ">99%";
  if (chance < 0.01) return "<1%";
  return `${Math.round(chance * 100)}%`;
}

export function formatRelativeTime(occurredAt: string, now: number = Date.now()): string {
  const timestamp = Date.parse(occurredAt);
  if (!Number.isFinite(timestamp)) return "";

  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  return `${Math.floor(hours / 24)}d`;
}

export function formatLastSeenTime(occurredAt: string, now: number = Date.now()): string {
  const relativeTime = formatRelativeTime(occurredAt, now);
  if (!relativeTime) return "";
  return relativeTime === "now" ? "last seen just now" : `last seen ${relativeTime} ago`;
}

export function formatAbsoluteTime(occurredAt: string): string {
  return ABSOLUTE_TIME_FORMATTER.format(new Date(occurredAt));
}

/** a calendar day in the site's voice; the year shows only once it is not this one */
export function formatDay(occurredAt: string, now: number = Date.now()): string {
  const day = new Date(occurredAt);
  const formatter = day.getUTCFullYear() === new Date(now).getUTCFullYear() ? DAY_FORMATTER : DATED_DAY_FORMATTER;
  return formatter.format(day).toLowerCase();
}

/** the same day without its year, for spans that carry the year once at the end */
export function formatDayOfMonth(occurredAt: string): string {
  return DAY_FORMATTER.format(new Date(occurredAt)).toLowerCase();
}

/** A failed poll must not keep a previously fresh snapshot looking current. */
export function isActivityDelayed(freshUntil: string | null | undefined, now = Date.now()): boolean {
  const deadline = Date.parse(freshUntil ?? "");
  return !Number.isFinite(deadline) || now > deadline;
}

/** Age a server snapshot using elapsed time, independent of the visitor's wall clock. */
export function createServerClock(
  serverNow: string | undefined,
  receivedAt: number,
): ((monotonicNow: number) => number) | undefined {
  const timestamp = Date.parse(serverNow ?? "");
  if (!Number.isFinite(timestamp) || !Number.isFinite(receivedAt)) return;
  return (monotonicNow) => timestamp + Math.max(0, monotonicNow - receivedAt);
}
