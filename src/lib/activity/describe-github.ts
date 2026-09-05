import { formatDay, formatDayOfMonth } from "./presence";
import { GITHUB_USERNAME } from "./providers/github";
import type { GitHubActivity } from "./types";

export interface GitHubDescription {
  text: string;
  url?: string;
}

// Every row says where the work landed rather than which of GitHub's two dozen
// event types it was. A private repository gives nothing away and neither does
// its row; a public one reads better as a place than as a list of verbs.
const PRIVATE_CONTRIBUTION = "contribution in private repo";
const UNPLACED_CONTRIBUTION = "contribution on GitHub";
/** a day's total is only ever visible on the profile it was counted from */
const GITHUB_PROFILE = `https://github.com/${GITHUB_USERNAME}`;

function contributionTotal(events: readonly GitHubActivity[]): number {
  return events.reduce((total, event) => total + (event.kind === "contributions" ? event.count : 0), 0);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A collapsed row covers a stretch of days, so it names that stretch. Counting
 * the days it happens to hold would overstate it: quiet days carry no entry at
 * all, so the tally never matches the span.
 */
function formatDaySpan(oldest: string, newest: string, now: number): string {
  const start = new Date(oldest);
  const end = new Date(newest);
  if (oldest.slice(0, 10) === newest.slice(0, 10)) return `on ${formatDay(oldest, now)}`;
  if (start.getUTCFullYear() !== end.getUTCFullYear()) {
    return `${formatDay(oldest, now)} – ${formatDay(newest, now)}`;
  }

  // one year for the whole span, and only once it is no longer this one
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const head = formatDayOfMonth(oldest);
  const tail = sameMonth ? end.getUTCDate() : formatDayOfMonth(newest);
  const year = start.getUTCFullYear() === new Date(now).getUTCFullYear() ? "" : `, ${start.getUTCFullYear()}`;
  return `${head} – ${tail}${year}`;
}

export function describeGitHubActivity(event: GitHubActivity, now: number = Date.now()): GitHubDescription {
  if (event.kind === "contributions") {
    return {
      text: `${plural(event.count, "contribution")} on ${formatDay(event.occurredAt, now)}`,
      url: GITHUB_PROFILE,
    };
  }
  if (event.visibility === "private") return { text: PRIVATE_CONTRIBUTION };

  // the link still points at whatever the event touched, but the row no longer
  // prints its title: without a verb in front, a bare issue name says nothing
  const repository = event.repository;
  return {
    text: repository ? `contribution in ${repository.name}` : UNPLACED_CONTRIBUTION,
    url: event.target?.url ?? repository?.url,
  };
}

/** rows only collapse when they read alike, so the group says what they say */
export function describeGitHubActivityGroup(
  events: readonly GitHubActivity[],
  now: number = Date.now(),
): GitHubDescription {
  const [newest] = events;
  if (newest.kind === "contributions") {
    const oldest = events[events.length - 1];
    const span = formatDaySpan(oldest.occurredAt, newest.occurredAt, now);
    const total = plural(contributionTotal(events), "contribution");
    return {
      text: span.startsWith("on ") ? `${total} ${span}` : `${total}, ${span}`,
      url: GITHUB_PROFILE,
    };
  }

  // the specific target belongs to one event, not to the group
  const url = newest.visibility === "public" ? newest.repository?.url : undefined;
  return {
    text: describeGitHubActivity(newest, now).text,
    ...(url ? { url } : {}),
  };
}
