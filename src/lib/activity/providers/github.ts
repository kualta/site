import {
  GITHUB_ACTIVITY_ACTIONS,
  type ActivityEvent,
  type ActivityProvider,
  type GitHubActivity,
  type GitHubActivityAction,
  type GitHubTarget,
  type ProviderContext,
  type PublicGitHubActivity,
} from "../types";
import { asRecord, recordField, safeDate, stringField, type UnknownRecord } from "../validation";

export const GITHUB_USERNAME = "kualta";
const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const ALLOWED_ACTIONS = new Set<string>(GITHUB_ACTIVITY_ACTIONS);

function safeAction(payload: UnknownRecord | undefined): GitHubActivityAction | undefined {
  const action = stringField(payload, "action");
  return action && ALLOWED_ACTIONS.has(action) ? (action as GitHubActivityAction) : undefined;
}

function safeGitHubUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function safeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.trim();
  return title ? title.slice(0, 200) : undefined;
}

function repositoryFromEvent(event: UnknownRecord): PublicGitHubActivity["repository"] {
  const name = stringField(recordField(event, "repo"), "name");
  if (!name || !/^[^/\s]+\/[^/\s]+$/.test(name)) return undefined;

  return {
    name,
    url: `https://github.com/${name}`,
  };
}

function targetFromResource(resource: UnknownRecord | undefined, titleKeys: string[]): GitHubTarget | undefined {
  const url = safeGitHubUrl(resource?.html_url);
  if (!url) return undefined;

  let title: string | undefined;
  for (const key of titleKeys) {
    title = safeTitle(resource?.[key]);
    if (title) break;
  }

  return title ? { title, url } : { url };
}

function targetFromEvent(
  eventType: string,
  payload: UnknownRecord | undefined,
  repository: PublicGitHubActivity["repository"],
): GitHubTarget | undefined {
  switch (eventType) {
    case "CommitCommentEvent":
      return targetFromResource(recordField(payload, "comment"), ["body"]);
    case "DiscussionEvent":
      return targetFromResource(recordField(payload, "discussion"), ["title"]);
    case "ForkEvent":
      return targetFromResource(recordField(payload, "forkee"), ["full_name", "name"]);
    case "IssueCommentEvent":
      return (
        targetFromResource(recordField(payload, "comment"), ["body"]) ??
        targetFromResource(recordField(payload, "issue"), ["title"])
      );
    case "IssuesEvent":
      return targetFromResource(recordField(payload, "issue"), ["title"]);
    case "PullRequestEvent":
    case "PullRequestReviewEvent":
    case "PullRequestReviewCommentEvent":
      return targetFromResource(recordField(payload, "pull_request"), ["title"]);
    case "ReleaseEvent":
      return targetFromResource(recordField(payload, "release"), ["name", "tag_name"]);
    case "PushEvent": {
      const head = stringField(payload, "head");
      if (!repository || !head || !/^[a-f0-9]{7,64}$/i.test(head)) return undefined;
      return { url: `${repository.url}/commit/${head}` };
    }
    case "GollumEvent": {
      const pages = payload?.pages;
      if (!Array.isArray(pages)) return undefined;
      return targetFromResource(asRecord(pages[0]), ["title", "page_name"]);
    }
    default:
      return undefined;
  }
}

function refTypeFromPayload(payload: UnknownRecord | undefined): PublicGitHubActivity["refType"] {
  const refType = stringField(payload, "ref_type");
  if (refType === "branch" || refType === "repository" || refType === "tag") {
    return refType;
  }
  return undefined;
}

async function hashIdentifier(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
  return `github:${hash}`;
}

async function normalizeGitHubEvent(value: unknown): Promise<GitHubActivity | undefined> {
  const event = asRecord(value);
  const rawId = stringField(event, "id");
  const eventType = stringField(event, "type")?.slice(0, 80);
  const occurredAt = safeDate(event?.created_at);
  const isPublic = event?.public;

  if (!event || !rawId || !eventType || !occurredAt || typeof isPublic !== "boolean") {
    return undefined;
  }

  const payload = recordField(event, "payload");
  const action = safeAction(payload);
  const id = await hashIdentifier(rawId);

  if (!isPublic) {
    return {
      id,
      source: "github",
      kind: "event",
      occurredAt,
      visibility: "private",
      eventType,
      ...(action ? { action } : {}),
    };
  }

  const repository = repositoryFromEvent(event);
  const target = targetFromEvent(eventType, payload, repository);
  const refType = refTypeFromPayload(payload);

  return {
    id,
    source: "github",
    kind: "event",
    occurredAt,
    visibility: "public",
    eventType,
    ...(action ? { action } : {}),
    ...(repository ? { repository } : {}),
    ...(target ? { target } : {}),
    ...(refType ? { refType } : {}),
  };
}

export async function normalizeGitHubEvents(value: unknown): Promise<GitHubActivity[]> {
  if (!Array.isArray(value)) throw new Error("GitHub returned an invalid event list");

  const events: GitHubActivity[] = [];
  for (const item of value) {
    const event = await normalizeGitHubEvent(item);
    if (!event) throw new Error("GitHub returned a malformed event");
    events.push(event);
  }
  return events;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "kualta.dev",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

async function fetchGitHubJson(context: ProviderContext, path: string, token: string): Promise<unknown> {
  const response = await context.fetch(`${GITHUB_API}${path}`, {
    headers: githubHeaders(token),
    signal: context.signal,
  });

  if (!response.ok) throw new Error(`GitHub request failed with status ${response.status}`);
  return response.json();
}

const CONTRIBUTION_YEARS_QUERY = `query($login: String!) {
  user(login: $login) { contributionsCollection { contributionYears } }
}`;
const CONTRIBUTION_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CONTRIBUTIONS_PER_DAY = 10_000;
const FIRST_GITHUB_YEAR = 2008;

async function fetchGraphQL(context: ProviderContext, token: string, body: unknown): Promise<UnknownRecord> {
  const response = await context.fetch(`${GITHUB_API}/graphql`, {
    method: "POST",
    headers: { ...githubHeaders(token), "content-type": "application/json" },
    signal: context.signal,
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`GitHub request failed with status ${response.status}`);

  const parsed = asRecord(await response.json());
  if (!parsed || (Array.isArray(parsed.errors) && parsed.errors.length)) {
    throw new Error("GitHub returned an invalid contributions response");
  }
  return parsed;
}

/** the years GitHub actually holds contributions for, newest first */
async function fetchContributionYears(context: ProviderContext, token: string, now: Date): Promise<number[]> {
  const body = await fetchGraphQL(context, token, {
    query: CONTRIBUTION_YEARS_QUERY,
    variables: { login: GITHUB_USERNAME },
  });
  const collection = recordField(recordField(recordField(body, "data"), "user"), "contributionsCollection");
  const years = collection?.contributionYears;
  if (!Array.isArray(years)) throw new Error("GitHub returned an invalid contributions response");

  const currentYear = now.getUTCFullYear();
  const usable = years.filter(
    (year): year is number =>
      typeof year === "number" && Number.isInteger(year) && year >= FIRST_GITHUB_YEAR && year <= currentYear,
  );
  return [...new Set(usable)].sort((left, right) => right - left);
}

function contributionsQuery(years: readonly number[]): string {
  const fields = years
    .map(
      (year) =>
        `y${year}: contributionsCollection(from: "${year}-01-01T00:00:00Z", to: "${year}-12-31T23:59:59Z") {
          contributionCalendar { weeks { contributionDays { date contributionCount } } }
        }`,
    )
    .join("\n");
  return `query($login: String!) { user(login: $login) { ${fields} } }`;
}

function collectContributionDays(collection: unknown, now: Date, days: ActivityEvent[]): void {
  const weeks = recordField(asRecord(collection), "contributionCalendar")?.weeks;
  if (!Array.isArray(weeks)) throw new Error("GitHub returned an invalid contributions response");

  for (const week of weeks) {
    const contributionDays = asRecord(week)?.contributionDays;
    if (!Array.isArray(contributionDays)) throw new Error("GitHub returned an invalid contributions response");

    for (const entry of contributionDays) {
      const day = asRecord(entry);
      const date = stringField(day, "date");
      const count = day?.contributionCount;
      if (!date || !CONTRIBUTION_DAY.test(date) || typeof count !== "number" || !Number.isInteger(count)) {
        throw new Error("GitHub returned an invalid contributions response");
      }
      if (count <= 0) continue;

      // a day is summarised at its end, but never dated into the future
      const endOfDay = Date.parse(`${date}T23:59:59.999Z`);
      const occurredAt = safeDate(new Date(Math.min(endOfDay, now.getTime())).toISOString());
      if (!occurredAt) continue;

      days.push({
        id: `github:contributions:${date}`,
        source: "github",
        kind: "contributions",
        occurredAt,
        count: Math.min(count, MAX_CONTRIBUTIONS_PER_DAY),
      });
    }
  }
}

/**
 * The calendar is the only GitHub history that reaches past the events API's
 * three-day window. A collection covers at most a year, so every year the
 * account has contributions for is aliased into one request — the whole history
 * for a single point of the GraphQL budget.
 */
async function fetchContributionDays(context: ProviderContext, token: string, now: Date): Promise<ActivityEvent[]> {
  const years = await fetchContributionYears(context, token, now);
  if (!years.length) return [];

  const body = await fetchGraphQL(context, token, {
    query: contributionsQuery(years),
    variables: { login: GITHUB_USERNAME },
  });
  const user = recordField(recordField(body, "data"), "user");
  if (!user) throw new Error("GitHub returned an invalid contributions response");

  const days: ActivityEvent[] = [];
  for (const year of years) collectContributionDays(user[`y${year}`], now, days);
  return days;
}

async function fetchGitHubActivity(context: ProviderContext): Promise<ActivityEvent[]> {
  const token = context.secrets.githubToken;
  if (!token) throw new Error("GitHub activity token is missing");

  const viewer = asRecord(await fetchGitHubJson(context, "/user", token));
  const login = stringField(viewer, "login");
  if (login?.toLowerCase() !== GITHUB_USERNAME) {
    throw new Error("GitHub activity token belongs to the wrong account");
  }

  const [events, contributions] = await Promise.all([
    fetchGitHubJson(context, `/users/${GITHUB_USERNAME}/events?per_page=100`, token).then(normalizeGitHubEvents),
    fetchContributionDays(context, token, context.now),
  ]);

  return [...events, ...contributions];
}

export const githubProvider: ActivityProvider = {
  id: "github",
  fetch: fetchGitHubActivity,
};
