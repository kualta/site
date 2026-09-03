import { ACTIVITY_SOURCES, type ActivityEvent, type ActivitySource } from "./types";

// GitHub only hands back its newest 100 events — about three days at this rate,
// and never more than 300 — so history has to be kept rather than re-fetched.
// Bluesky's 100 posts already reach back over a year, and the contribution
// calendar covers the year GitHub's events cannot. Each of those streams gets
// its own budget: a busy afternoon of commits must not evict a year of posts.
type ActivityLane = "github:event" | "github:contributions" | "bluesky";

const MAX_EVENTS_PER_LANE: Record<ActivityLane, number> = {
  // ~200 bytes each, and grouping collapses bursts, so this buys weeks of depth
  "github:event": 2000,
  // a day of contributions is ~110 bytes, so the whole account fits comfortably
  "github:contributions": 4000,
  bluesky: 400,
};

function laneOf(event: ActivityEvent): ActivityLane {
  if (event.source !== "github") return "bluesky";
  return event.kind === "contributions" ? "github:contributions" : "github:event";
}
// the per-lane counts are the real bound on storage; this only stops an event
// with a nonsense date from sitting at the top of the feed forever
const MAX_AGE_MS = 20 * 365 * 24 * 60 * 60 * 1000;

// the newest three days are not collapsed, so the head is dense; the rest of
// the feed is a scroll away rather than in the initial payload
/** what the page renders without touching the full archive */
export const HEAD_EVENTS = 40;

export interface ActivityCoverage {
  /** oldest event held per source; sources we have never seen are absent */
  oldest: Partial<Record<ActivitySource, string>>;
  /** every source reaches back this far, so the feed is complete above it */
  completeSince: string | null;
  /** the source whose history runs out first, and so sets the boundary */
  limitedBy: ActivitySource | null;
}

function occurredAtMs(event: ActivityEvent): number {
  return Date.parse(event.occurredAt);
}

export function sortEventsNewestFirst(events: readonly ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((left, right) => occurredAtMs(right) - occurredAtMs(left));
}

/**
 * Folds freshly fetched events into the stored history. Fresh copies win, so a
 * post edited upstream refreshes rather than sticking at its archived version.
 */
export function mergeIntoArchive(
  archived: readonly ActivityEvent[],
  fresh: readonly ActivityEvent[],
  now: Date = new Date(),
): ActivityEvent[] {
  const byId = new Map<string, ActivityEvent>();
  for (const event of archived) byId.set(event.id, event);
  for (const event of fresh) byId.set(event.id, event);

  const horizon = now.getTime() - MAX_AGE_MS;
  const kept: ActivityEvent[] = [];
  const perLane = new Map<ActivityLane, number>();

  for (const event of sortEventsNewestFirst([...byId.values()])) {
    const age = occurredAtMs(event);
    if (!Number.isFinite(age) || age < horizon) continue;

    const lane = laneOf(event);
    const used = perLane.get(lane) ?? 0;
    if (used >= MAX_EVENTS_PER_LANE[lane]) continue;

    perLane.set(lane, used + 1);
    kept.push(event);
  }

  return collapsePastDays(kept, now);
}

/**
 * Only the day in progress is worth reading event by event. Every day before it
 * is already described by its calendar total, so the detail gives way to the
 * summary — though only where a summary actually exists, so a day the calendar
 * has not reported yet keeps its events rather than vanishing.
 */
export function collapsePastDays(events: readonly ActivityEvent[], now: Date = new Date()): ActivityEvent[] {
  const today = now.toISOString().slice(0, 10);
  const summarised = new Set(
    events.filter((event) => laneOf(event) === "github:contributions").map((event) => event.occurredAt.slice(0, 10)),
  );

  return events.filter((event) => {
    const day = event.occurredAt.slice(0, 10);
    const lane = laneOf(event);

    if (lane === "github:contributions") return day !== today;
    if (lane === "github:event") return day === today || !summarised.has(day);
    return true;
  });
}

/**
 * The feed can only claim to be complete back to the point where its shallowest
 * source still has data; below that a quiet stretch means "not collected", not
 * "nothing happened".
 */
export function getActivityCoverage(events: readonly ActivityEvent[]): ActivityCoverage {
  const oldest: Partial<Record<ActivitySource, string>> = {};

  for (const event of events) {
    const current = oldest[event.source];
    if (!current || occurredAtMs(event) < Date.parse(current)) oldest[event.source] = event.occurredAt;
  }

  return { oldest, ...coverageBoundary(oldest) };
}

/** the shallowest source decides how far back the merged feed is trustworthy */
export function coverageBoundary(oldest: Partial<Record<ActivitySource, string>>): {
  completeSince: string | null;
  limitedBy: ActivitySource | null;
} {
  let completeSince: string | null = null;
  let limitedBy: ActivitySource | null = null;

  for (const source of ACTIVITY_SOURCES) {
    const held = oldest[source];
    if (!held) continue;
    if (!completeSince || Date.parse(held) > Date.parse(completeSince)) {
      completeSince = held;
      limitedBy = source;
    }
  }

  return { completeSince, limitedBy };
}

/** `<iso>|<id>`: the timestamp keeps the slice working if the id ages out */
export function encodeActivityCursor(event: ActivityEvent): string {
  return `${event.occurredAt}|${event.id}`;
}

export function decodeActivityCursor(cursor: string | null | undefined): { occurredAt: string; id: string } | null {
  if (!cursor) return null;

  const separator = cursor.indexOf("|");
  if (separator <= 0) return null;

  const occurredAt = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  if (!id || !Number.isFinite(Date.parse(occurredAt))) return null;

  return { occurredAt, id };
}

/** events strictly older than the cursor, newest first */
export function sliceEventsBefore(
  events: readonly ActivityEvent[],
  cursor: string | null | undefined,
): ActivityEvent[] {
  const decoded = decodeActivityCursor(cursor);
  if (!decoded) return [...events];

  const index = events.findIndex((event) => event.id === decoded.id);
  if (index >= 0) return events.slice(index + 1);

  const boundary = Date.parse(decoded.occurredAt);
  return events.filter((event) => occurredAtMs(event) < boundary);
}

/**
 * A provider's response is authoritative for the window it covers, so anything
 * archived inside that window and missing from it was deleted upstream.
 */
export function reconcileSource(
  archived: readonly ActivityEvent[],
  source: ActivitySource,
  fresh: readonly ActivityEvent[],
): ActivityEvent[] {
  if (!fresh.length) return [...archived];

  // how far back each lane of the response reaches, and everything in it
  const covered = new Map<ActivityLane, { since: number; ids: Set<string> }>();
  for (const event of fresh) {
    const at = occurredAtMs(event);
    if (!Number.isFinite(at)) continue;

    const lane = covered.get(laneOf(event));
    if (lane) {
      lane.since = Math.min(lane.since, at);
      lane.ids.add(event.id);
      continue;
    }
    covered.set(laneOf(event), { since: at, ids: new Set([event.id]) });
  }

  return archived.filter((event) => {
    if (event.source !== source) return true;

    const lane = covered.get(laneOf(event));
    if (!lane) return true;
    return occurredAtMs(event) < lane.since || lane.ids.has(event.id);
  });
}
