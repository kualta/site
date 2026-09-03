import type { Post as BlueskyPostView } from "@astro-community/astro-embed-bluesky";

export const ACTIVITY_SOURCES = ["github", "bluesky"] as const;

export const GITHUB_ACTIVITY_ACTIONS = [
  "added",
  "answered",
  "assigned",
  "category_changed",
  "closed",
  "created",
  "deleted",
  "demilestoned",
  "dismissed",
  "edited",
  "forked",
  "labeled",
  "locked",
  "merged",
  "milestoned",
  "opened",
  "pinned",
  "prereleased",
  "published",
  "released",
  "reopened",
  "review_request_removed",
  "review_requested",
  "started",
  "submitted",
  "synchronize",
  "transferred",
  "unanswered",
  "unassigned",
  "unlabeled",
  "unlocked",
  "unpinned",
  "unpublished",
  "updated",
] as const;

export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];
export type GitHubActivityAction = (typeof GITHUB_ACTIVITY_ACTIONS)[number];

interface BaseActivity {
  id: string;
  source: ActivitySource;
  occurredAt: string;
}

export interface GitHubRepository {
  name: string;
  url: string;
}

export interface GitHubTarget {
  title?: string;
  url: string;
}

interface GitHubActivityBase extends BaseActivity {
  source: "github";
  kind: "event";
  eventType: string;
  action?: GitHubActivityAction;
}

export interface PrivateGitHubActivity extends GitHubActivityBase {
  visibility: "private";
  repository?: never;
  target?: never;
  refType?: never;
}

export interface PublicGitHubActivity extends GitHubActivityBase {
  visibility: "public";
  repository?: GitHubRepository;
  target?: GitHubTarget;
  refType?: "branch" | "repository" | "tag";
}

/**
 * The events API only reaches back three days, so older GitHub history arrives
 * as the contribution calendar's daily totals instead — coarser, but it covers
 * the year the detailed feed cannot.
 */
export interface GitHubContributionsActivity extends BaseActivity {
  source: "github";
  kind: "contributions";
  /** what GitHub counted that day, private work included as an opaque total */
  count: number;
}

export type GitHubEventActivity = PrivateGitHubActivity | PublicGitHubActivity;
export type GitHubActivity = GitHubEventActivity | GitHubContributionsActivity;

export interface BlueskyActivity extends BaseActivity {
  source: "bluesky";
  action: "post" | "reply" | "repost";
  uri: string;
  url: string;
  text: string;
  author: {
    displayName?: string;
    handle: string;
  };
  post: BlueskyPostView;
}

export type ActivityEvent = GitHubActivity | BlueskyActivity;

export type PresenceState =
  | "definitely-alive"
  | "most-likely-alive"
  | "somewhere-else"
  | "kinda-lost"
  | "not-around"
  | "most-likely-dead"
  | "unknown";

export interface SourceHealth {
  status: "fresh" | "stale" | "unavailable";
  fetchedAt: string | null;
}

export interface ActivityFeed {
  /** newest events only; older ones are paged in from the archive */
  events: ActivityEvent[];
  lastSeenAt: string | null;
  presence: PresenceState;
  sources: Record<ActivitySource, SourceHealth>;
  delayed: boolean;
  trustedUntil: string | null;
  /** oldest point every source still reaches; below it the feed is partial */
  completeSince: string | null;
  /** the source that runs out at `completeSince` */
  coverageLimitedBy: ActivitySource | null;
  /** feed position to request the next page from */
  cursor: string | null;
}

export interface ActivityCacheStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export type ActivityFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProviderContext {
  fetch: ActivityFetch;
  signal: AbortSignal;
  now: Date;
  secrets: {
    githubToken?: string;
  };
}

export interface ActivityProvider {
  id: ActivitySource;
  fetch(context: ProviderContext): Promise<ActivityEvent[]>;
}
