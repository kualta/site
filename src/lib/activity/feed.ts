import {
  coverageBoundary,
  encodeActivityCursor,
  getActivityCoverage,
  HEAD_EVENTS,
  mergeIntoArchive,
  reconcileSource,
  sliceEventsBefore,
  sortEventsNewestFirst,
} from "./archive";
import { getPresenceState } from "./presence";
import { sanitizeBlueskyPostView } from "./bluesky-post";
import { blueskyProvider } from "./providers/bluesky";
import { githubProvider } from "./providers/github";
import {
  ACTIVITY_SOURCES,
  GITHUB_ACTIVITY_ACTIONS,
  type ActivityCacheStore,
  type ActivityEvent,
  type ActivityFeed,
  type ActivityFetch,
  type ActivityProvider,
  type ActivitySource,
  type BlueskyActivity,
  type GitHubActivity,
  type GitHubActivityAction,
  type GitHubContributionsActivity,
  type SourceHealth,
} from "./types";
import { asRecord, safeDate, type UnknownRecord } from "./validation";

const STORE_VERSION = 3;
const STATE_KEY = `activity:state:v${STORE_VERSION}`;
const ARCHIVE_KEY = `activity:archive:v${STORE_VERSION}`;
// how often we go back to the providers; both cache their responses for about
// this long, so polling faster only re-reads bytes we already have
const FRESH_FOR_MS = 60 * 1000;
// how far behind a source has to fall before the widget admits it is behind
const DELAYED_AFTER_MS = 5 * 60 * 1000;
const TRUST_FOR_MS = 24 * 60 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 5 * 1000;
const GITHUB_EVENT_ID = /^github:[a-f0-9]{24}$/;
const GITHUB_CONTRIBUTIONS_ID = /^github:contributions:\d{4}-\d{2}-\d{2}$/;
const MAX_CONTRIBUTIONS_PER_DAY = 10_000;
const GITHUB_EVENT_TYPE = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
const GITHUB_REPOSITORY_NAME = /^[^/\s]+\/[^/\s]+$/;
const GITHUB_ACTIONS = new Set<string>(GITHUB_ACTIVITY_ACTIONS);

const DEFAULT_PROVIDERS: readonly ActivityProvider[] = [githubProvider, blueskyProvider];

type ActivityLogger = Pick<Console, "info" | "warn">;

interface GetActivityFeedOptions {
  cache?: ActivityCacheStore;
  githubToken?: string;
  fetch?: ActivityFetch;
  logger?: ActivityLogger;
  now?: Date;
  providers?: readonly ActivityProvider[];
  timeoutMs?: number;
  /** hands the refresh to the platform so a visitor never waits on providers */
  waitUntil?: (work: Promise<unknown>) => void;
}

interface SourceState {
  /** last successful fetch; drives how far behind the widget says it is */
  fetchedAt: string | null;
  /** last attempt, successful or not, so a failing provider is not retried per request */
  attemptedAt: string | null;
}

interface StoredState {
  version: number;
  sources: Record<ActivitySource, SourceState>;
  /** oldest event held per source, computed over the whole archive */
  coverage: Partial<Record<ActivitySource, string>>;
  events: ActivityEvent[];
}

interface StoredEntry<T> {
  value: T;
  serialized: string;
}

interface SourceResult {
  source: ActivitySource;
  events: ActivityEvent[] | null;
}

function safeUrl(value: unknown, hostname: string): string | undefined {
  if (typeof value !== "string") return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== hostname) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function sanitizeGitHubContributions(event: UnknownRecord): GitHubContributionsActivity | undefined {
  const id = typeof event.id === "string" ? event.id : undefined;
  const occurredAt = safeDate(event.occurredAt);
  const count = event.count;

  if (!id || !GITHUB_CONTRIBUTIONS_ID.test(id) || !occurredAt) return undefined;
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0 || count > MAX_CONTRIBUTIONS_PER_DAY) {
    return undefined;
  }

  return { id, source: "github", kind: "contributions", occurredAt, count };
}

function sanitizeGitHubEvent(value: unknown): GitHubActivity | undefined {
  const event = asRecord(value);
  if (event?.kind === "contributions") return sanitizeGitHubContributions(event);
  if (event?.kind !== "event") return undefined;

  const id = typeof event?.id === "string" ? event.id : undefined;
  const eventType = typeof event?.eventType === "string" ? event.eventType.slice(0, 80) : undefined;
  const occurredAt = safeDate(event?.occurredAt);
  const action =
    typeof event?.action === "string" && GITHUB_ACTIONS.has(event.action)
      ? (event.action as GitHubActivityAction)
      : undefined;

  if (!id || !GITHUB_EVENT_ID.test(id) || !eventType || !GITHUB_EVENT_TYPE.test(eventType)) {
    return undefined;
  }
  if (!occurredAt) return undefined;

  if (event?.visibility === "private") {
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

  if (event?.visibility !== "public") return undefined;

  const rawRepository = asRecord(event.repository);
  const repositoryName = typeof rawRepository?.name === "string" ? rawRepository.name.slice(0, 200) : undefined;
  const repositoryUrl = safeUrl(rawRepository?.url, "github.com");
  const repository =
    repositoryName && GITHUB_REPOSITORY_NAME.test(repositoryName) && repositoryUrl
      ? { name: repositoryName, url: repositoryUrl }
      : undefined;

  const rawTarget = asRecord(event.target);
  const targetUrl = safeUrl(rawTarget?.url, "github.com");
  const targetTitle = typeof rawTarget?.title === "string" ? rawTarget.title.trim().slice(0, 200) : undefined;
  const target = targetUrl
    ? {
        url: targetUrl,
        ...(targetTitle ? { title: targetTitle } : {}),
      }
    : undefined;

  const refType = event.refType;
  const safeRefType = refType === "branch" || refType === "repository" || refType === "tag" ? refType : undefined;

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
    ...(safeRefType ? { refType: safeRefType } : {}),
  };
}

function sanitizeBlueskyEvent(value: unknown): BlueskyActivity | undefined {
  const event = asRecord(value);
  const id = typeof event?.id === "string" ? event.id : undefined;
  const occurredAt = safeDate(event?.occurredAt);
  const uri = typeof event?.uri === "string" ? event.uri : undefined;
  const url = safeUrl(event?.url, "bsky.app");
  const post = sanitizeBlueskyPostView(event?.post);
  const handle = post?.author.handle;
  const displayName = post?.author.displayName?.trim().slice(0, 200);
  const text = post?.record.text;
  const action = event?.action;

  if (
    !id?.startsWith("bluesky:") ||
    !occurredAt ||
    !uri?.startsWith("at://") ||
    !url ||
    !post ||
    post.uri !== uri ||
    !handle ||
    text === undefined ||
    (action !== "post" && action !== "reply" && action !== "repost")
  ) {
    return undefined;
  }

  return {
    id,
    source: "bluesky",
    occurredAt,
    action,
    uri,
    url,
    text,
    author: {
      handle,
      ...(displayName ? { displayName } : {}),
    },
    post,
  };
}

function sanitizeEvent(value: unknown, source: ActivitySource): ActivityEvent | undefined {
  const event = asRecord(value);
  if (event?.source !== source) return undefined;

  if (source === "github") return sanitizeGitHubEvent(event);
  return sanitizeBlueskyEvent(event);
}

/**
 * Stored events are re-validated on the way out, and a single bad entry is
 * dropped rather than discarding the history around it.
 */
function parseStoredEvents(value: unknown): ActivityEvent[] {
  if (!Array.isArray(value)) return [];

  const events: ActivityEvent[] = [];
  for (const raw of value) {
    const source = asRecord(raw)?.source;
    if (source !== "github" && source !== "bluesky") continue;

    const event = sanitizeEvent(raw, source);
    if (event) events.push(event);
  }
  return sortEventsNewestFirst(events);
}

function emptySources(): Record<ActivitySource, SourceState> {
  const entries = ACTIVITY_SOURCES.map((source) => [source, { fetchedAt: null, attemptedAt: null }] as const);
  return Object.fromEntries(entries) as Record<ActivitySource, SourceState>;
}

function parseSourceStates(value: unknown): Record<ActivitySource, SourceState> {
  const stored = asRecord(value);
  const sources = emptySources();

  for (const source of ACTIVITY_SOURCES) {
    const entry = asRecord(stored?.[source]);
    sources[source] = {
      fetchedAt: safeDate(entry?.fetchedAt) ?? null,
      attemptedAt: safeDate(entry?.attemptedAt) ?? null,
    };
  }
  return sources;
}

function parseCoverage(value: unknown): Partial<Record<ActivitySource, string>> {
  const stored = asRecord(value);
  const coverage: Partial<Record<ActivitySource, string>> = {};

  for (const source of ACTIVITY_SOURCES) {
    const occurredAt = safeDate(stored?.[source]);
    if (occurredAt) coverage[source] = occurredAt;
  }
  return coverage;
}

async function readStored<T>(
  cache: ActivityCacheStore | undefined,
  key: string,
  parse: (value: unknown) => T | undefined,
  logger: ActivityLogger,
): Promise<StoredEntry<T> | undefined> {
  if (!cache) return undefined;

  try {
    const serialized = await cache.get(key);
    if (!serialized) return undefined;

    const value = parse(JSON.parse(serialized));
    return value ? { value, serialized } : undefined;
  } catch {
    logger.warn("activity cache result", { key, cacheState: "read-error", error: "cache-read-failed" });
    return undefined;
  }
}

async function writeStored(
  cache: ActivityCacheStore | undefined,
  key: string,
  value: unknown,
  previous: string | undefined,
  logger: ActivityLogger,
): Promise<void> {
  if (!cache) return;

  const serialized = JSON.stringify(value);
  if (serialized === previous) return;

  try {
    await cache.put(key, serialized);
  } catch {
    logger.warn("activity cache result", { key, cacheState: "write-error", error: "cache-write-failed" });
  }
}

function parseState(value: unknown): StoredState | undefined {
  const stored = asRecord(value);
  if (stored?.version !== STORE_VERSION) return undefined;

  return {
    version: STORE_VERSION,
    sources: parseSourceStates(stored.sources),
    coverage: parseCoverage(stored.coverage),
    events: parseStoredEvents(stored.events),
  };
}

function parseArchive(value: unknown): ActivityEvent[] | undefined {
  const stored = asRecord(value);
  if (stored?.version !== STORE_VERSION) return undefined;
  return parseStoredEvents(stored.events);
}

/** how long ago a stored timestamp was; something never recorded is infinitely old */
function ageSince(timestamp: string | null | undefined, now: Date): number {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? now.getTime() - parsed : Number.POSITIVE_INFINITY;
}

function sanitizedProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("timed out")) return "timeout";
  if (message.includes("token is missing")) return "missing-token";
  if (message.includes("wrong account")) return "wrong-account";
  if (message.includes("invalid") || message.includes("malformed")) return "malformed-response";
  if (message.includes("request failed")) return "upstream-response";
  return "unknown";
}

async function fetchProvider(
  provider: ActivityProvider,
  options: GetActivityFeedOptions,
  now: Date,
): Promise<ActivityEvent[]> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("activity provider timed out"));
    }, timeoutMs);
  });

  try {
    const fetchActivity: ActivityFetch = (input, init) => {
      if (options.fetch) return options.fetch(input, init);
      return globalThis.fetch(input, init);
    };

    return await Promise.race([
      provider.fetch({
        fetch: fetchActivity,
        signal: controller.signal,
        now,
        secrets: { githubToken: options.githubToken },
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadSource(
  provider: ActivityProvider,
  options: GetActivityFeedOptions,
  now: Date,
  logger: ActivityLogger,
): Promise<SourceResult> {
  const startedAt = Date.now();

  try {
    const fetchedEvents = await fetchProvider(provider, options, now);
    const events = fetchedEvents
      .map((event) => sanitizeEvent(event, provider.id))
      .filter((event): event is ActivityEvent => Boolean(event));
    if (events.length !== fetchedEvents.length) {
      throw new Error("activity provider returned an invalid normalized event");
    }

    logger.info("activity provider result", {
      provider: provider.id,
      durationMs: Date.now() - startedAt,
      resultCount: events.length,
      cacheState: "refreshed",
    });
    return { source: provider.id, events };
  } catch (error) {
    logger.warn("activity provider result", {
      provider: provider.id,
      durationMs: Date.now() - startedAt,
      resultCount: 0,
      cacheState: "unavailable",
      error: sanitizedProviderError(error),
    });
    return { source: provider.id, events: null };
  }
}

/** everything the state says apart from when we last tried a provider */
function contentSignature(state: StoredState): string {
  return JSON.stringify({
    coverage: state.coverage,
    events: state.events,
    fetchedAt: ACTIVITY_SOURCES.map((source) => state.sources[source].fetchedAt),
  });
}

/**
 * KV allows a thousand writes a day on the free plan, so the state is only
 * rewritten when it carries new information — an unchanged retry marker is not
 * worth a write until it goes properly stale.
 */
function shouldWriteState(previous: StoredState | undefined, next: StoredState, now: Date): boolean {
  if (!previous) return true;
  if (contentSignature(previous) !== contentSignature(next)) return true;

  return ACTIVITY_SOURCES.some((source) => ageSince(previous.sources[source].attemptedAt, now) > DELAYED_AFTER_MS);
}

async function refreshActivity(
  options: GetActivityFeedOptions,
  now: Date,
  logger: ActivityLogger,
  known?: StoredEntry<StoredState>,
): Promise<StoredState> {
  const providers = options.providers ?? DEFAULT_PROVIDERS;
  const state = known ?? (await readStored(options.cache, STATE_KEY, parseState, logger));
  const archive = await readStored(options.cache, ARCHIVE_KEY, parseArchive, logger);
  const results = await Promise.all(providers.map((provider) => loadSource(provider, options, now, logger)));

  const sources = { ...(state?.value.sources ?? emptySources()) };
  const attemptedAt = now.toISOString();
  let history = archive?.value ?? state?.value.events ?? [];
  const fresh: ActivityEvent[] = [];

  for (const result of results) {
    sources[result.source] = {
      fetchedAt: result.events ? attemptedAt : sources[result.source].fetchedAt,
      attemptedAt,
    };
    if (!result.events) continue;

    history = reconcileSource(history, result.source, result.events);
    fresh.push(...result.events);
  }

  const events = mergeIntoArchive(history, fresh, now);
  const next: StoredState = {
    version: STORE_VERSION,
    sources,
    coverage: getActivityCoverage(events).oldest,
    events: events.slice(0, HEAD_EVENTS),
  };

  await writeStored(options.cache, ARCHIVE_KEY, { version: STORE_VERSION, events }, archive?.serialized, logger);
  if (shouldWriteState(state?.value, next, now)) {
    await writeStored(options.cache, STATE_KEY, next, state?.serialized, logger);
  }

  return next;
}

function healthStatus(age: number): SourceHealth["status"] {
  if (age <= DELAYED_AFTER_MS) return "fresh";
  if (age <= TRUST_FOR_MS) return "stale";
  return "unavailable";
}

function healthFor(state: StoredState | undefined, now: Date): Record<ActivitySource, SourceHealth> {
  const entries = ACTIVITY_SOURCES.map((source) => {
    const fetchedAt = state?.sources[source].fetchedAt ?? null;
    const health: SourceHealth = { status: healthStatus(ageSince(fetchedAt, now)), fetchedAt };
    return [source, health] as const;
  });
  return Object.fromEntries(entries) as Record<ActivitySource, SourceHealth>;
}

function trustedUntilFor(sources: Record<ActivitySource, SourceHealth>): string | null {
  let earliestDeadline = Number.POSITIVE_INFINITY;

  for (const source of ACTIVITY_SOURCES) {
    const health = sources[source];
    if (health.status === "unavailable" || !health.fetchedAt) return null;
    earliestDeadline = Math.min(earliestDeadline, Date.parse(health.fetchedAt) + TRUST_FOR_MS);
  }

  return new Date(earliestDeadline).toISOString();
}

function buildFeed(state: StoredState | undefined, now: Date): ActivityFeed {
  const events = state?.events ?? [];
  const sources = healthFor(state, now);
  const trustedUntil = trustedUntilFor(sources);
  const lastSeenAt = events[0]?.occurredAt ?? null;
  const oldest = events[events.length - 1];
  const coverage = coverageBoundary(state?.coverage ?? {});

  return {
    events,
    lastSeenAt,
    presence: trustedUntil ? getPresenceState(lastSeenAt, now) : "unknown",
    sources,
    delayed: Object.values(sources).some(({ status }) => status !== "fresh"),
    trustedUntil,
    completeSince: coverage.completeSince,
    coverageLimitedBy: coverage.limitedBy,
    cursor: oldest ? encodeActivityCursor(oldest) : null,
  };
}

export async function getActivityFeed(options: GetActivityFeedOptions = {}): Promise<ActivityFeed> {
  const now = options.now ?? new Date();
  const logger = options.logger ?? console;
  const providers = options.providers ?? DEFAULT_PROVIDERS;
  const state = await readStored(options.cache, STATE_KEY, parseState, logger);

  const due = providers.some((provider) => ageSince(state?.value.sources[provider.id].attemptedAt, now) > FRESH_FOR_MS);
  if (!due) return buildFeed(state?.value, now);

  // something renderable is already cached, so the refresh can run after the
  // response instead of holding a visitor behind two upstream APIs
  if (state?.value.events.length && options.waitUntil) {
    options.waitUntil(refreshActivity(options, now, logger, state).catch(() => undefined));
    return buildFeed(state.value, now);
  }

  return buildFeed(await refreshActivity(options, now, logger, state), now);
}

interface ActivityHistoryOptions {
  cache?: ActivityCacheStore;
  logger?: ActivityLogger;
  before?: string | null;
  limit?: number;
}

export interface ActivityHistory {
  events: ActivityEvent[];
  completeSince: string | null;
  coverageLimitedBy: ActivitySource | null;
  cursor: string | null;
}

/** pages the archive without touching the providers */
export async function getActivityHistory(options: ActivityHistoryOptions = {}): Promise<ActivityHistory> {
  const logger = options.logger ?? console;
  const archive = await readStored(options.cache, ARCHIVE_KEY, parseArchive, logger);
  let events = archive?.value ?? [];
  if (!archive) {
    const state = await readStored(options.cache, STATE_KEY, parseState, logger);
    events = state?.value.events ?? [];
  }

  const page = sliceEventsBefore(events, options.before).slice(0, options.limit ?? HEAD_EVENTS);
  const oldest = page[page.length - 1];
  const coverage = getActivityCoverage(events);

  return {
    events: page,
    completeSince: coverage.completeSince,
    coverageLimitedBy: coverage.limitedBy,
    cursor: oldest ? encodeActivityCursor(oldest) : null,
  };
}
