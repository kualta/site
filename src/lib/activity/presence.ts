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

/** split so the half that actually changes can be styled on its own */
export const PRESENCE_PARTS: Record<PresenceState, { lead: string; status: string }> = {
  "definitely-alive": { lead: "kualta is", status: "definitely alive" },
  "most-likely-alive": { lead: "kualta is", status: "most likely alive" },
  "somewhere-else": { lead: "kualta is", status: "somewhere else" },
  "kinda-lost": { lead: "kualta is", status: "kinda lost" },
  "not-around": { lead: "kualta is", status: "not around" },
  "most-likely-dead": { lead: "kualta is", status: "most likely dead" },
  unknown: { lead: "kualta's whereabouts are", status: "unknown" },
};

/** `within` is the same threshold in words, so the two cannot drift apart */
export const PRESENCE_BANDS: ReadonlyArray<{
  maximumAge: number;
  state: Exclude<PresenceState, "unknown">;
  within: string;
}> = [
  { maximumAge: 6 * HOUR, state: "definitely-alive", within: "< 6h" },
  { maximumAge: 2 * DAY, state: "most-likely-alive", within: "< 2d" },
  { maximumAge: 7 * DAY, state: "somewhere-else", within: "< 1w" },
  { maximumAge: 14 * DAY, state: "kinda-lost", within: "< 2w" },
  { maximumAge: 60 * DAY, state: "not-around", within: "< 2mo" },
  { maximumAge: Number.POSITIVE_INFINITY, state: "most-likely-dead", within: "> 2mo" },
];

export function getPresenceState(
  lastSeenAt: string | null,
  now: Date | number = Date.now(),
): Exclude<PresenceState, "unknown"> {
  if (!lastSeenAt) return "most-likely-dead";

  const occurredAt = Date.parse(lastSeenAt);
  if (!Number.isFinite(occurredAt)) return "most-likely-dead";

  const nowMs = typeof now === "number" ? now : now.getTime();
  const age = Math.max(0, nowMs - occurredAt);
  const band = PRESENCE_BANDS.find(({ maximumAge }) => age <= maximumAge);

  return band?.state ?? "most-likely-dead";
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
