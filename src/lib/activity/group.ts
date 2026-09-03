import { describeGitHubActivity } from "./describe-github";
import type { ActivityEvent } from "./types";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Recent activity is worth reading event by event; a year back, a day of commits
 * is one line at most. The window a row may span therefore widens with age.
 */
const COLLAPSE_BANDS: ReadonlyArray<{ olderThan: number; window: number }> = [
  { olderThan: 3 * DAY, window: 0 },
  { olderThan: 7 * DAY, window: HOUR },
  { olderThan: 14 * DAY, window: 3 * HOUR },
  { olderThan: 30 * DAY, window: 12 * HOUR },
  { olderThan: 90 * DAY, window: DAY },
  { olderThan: Number.POSITIVE_INFINITY, window: 7 * DAY },
];

export interface ActivityGroup {
  /** the newest event in the group; its id keys the rendered row */
  id: string;
  occurredAt: string;
  events: [ActivityEvent, ...ActivityEvent[]];
}

/** events without a key are never grouped, so every other source stays one row per event */
function groupKey(event: ActivityEvent): string | undefined {
  if (event.source !== "github") return undefined;
  if (event.kind === "contributions") return "github:contributions";
  if (event.visibility === "private") return "github:private";
  return event.repository && `github:${event.repository.name}`;
}

/**
 * What the row would say. Two events that would print the same line are worth
 * one line and a count, however recent they are — a dated calendar row is never
 * the same twice, so those keep collapsing by age alone.
 */
function rowLabel(event: ActivityEvent): string | undefined {
  if (event.source !== "github" || event.kind === "contributions") return undefined;
  return describeGitHubActivity(event).text;
}

function sameDay(left: string, right: string): boolean {
  return left.slice(0, 10) === right.slice(0, 10);
}

export function collapseWindowFor(occurredAt: string, now: number): number {
  const age = now - Date.parse(occurredAt);
  return COLLAPSE_BANDS.find(({ olderThan }) => age <= olderThan)?.window ?? 0;
}

function joins(group: ActivityGroup, event: ActivityEvent, key: string, now: number): boolean {
  const first = group.events[0];
  if (groupKey(first) !== key) return false;

  const age = Date.parse(group.occurredAt) - Date.parse(event.occurredAt);
  if (!Number.isFinite(age) || age < 0) return false;

  const window = collapseWindowFor(group.occurredAt, now);
  if (window > 0 && age <= window) return true;

  const label = rowLabel(first);
  return Boolean(label) && label === rowLabel(event) && sameDay(group.occurredAt, event.occurredAt);
}

/** expects the newest-first order the archive stores events in */
export function groupActivityEvents(events: readonly ActivityEvent[], now: number = Date.now()): ActivityGroup[] {
  const groups: ActivityGroup[] = [];

  for (const event of events) {
    const key = groupKey(event);
    const open = groups.at(-1);

    if (key && open && joins(open, event, key, now)) {
      open.events.push(event);
      continue;
    }

    groups.push({ id: event.id, occurredAt: event.occurredAt, events: [event] });
  }

  return groups;
}
