/** Synthetic local CPU comparison; never calls upstreams or remote storage. */
import { getActivityHistory, getInitialActivityFeed, refreshScheduledActivity } from "../src/lib/activity/feed";
import { githubProvider } from "../src/lib/activity/providers/github";
import { blueskyProvider } from "../src/lib/activity/providers/bluesky";
import type { ActivityEvent, ActivityProvider, ProviderContext } from "../src/lib/activity/types";

const now = new Date("2026-10-05T13:00:00.000Z");
const did = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const cid = "bafyreid3l3mpwbadpafmoajnc2ukaaf42cmnti6shcomrrqnqq4ctap5xy";
const calendarDays = Number(process.env.PROFILE_CALENDAR_DAYS ?? 2000);
const postCount = Number(process.env.PROFILE_POSTS ?? 300);
const providerDays = Number(process.env.PROFILE_PROVIDER_CALENDAR_DAYS ?? calendarDays);
const githubEvents = Number(process.env.PROFILE_GITHUB_EVENTS ?? 100);
const runs = Number(process.env.PROFILE_RUNS ?? 100);
const mode = process.env.PROFILE_MODE ?? "cron";
if (!["cron", "full-cron", "bounded-cron", "providers", "head", "history"].includes(mode)) throw new Error("Invalid PROFILE_MODE");
if (![calendarDays, postCount, providerDays, githubEvents, runs].every(Number.isSafeInteger) || Math.min(calendarDays, postCount, providerDays, githubEvents) < 0 || githubEvents > 100 || runs < 2) {
  throw new Error("Fixture counts must be nonnegative integers, PROFILE_GITHUB_EVENTS at most 100, and PROFILE_RUNS at least 2");
}
const events: ActivityEvent[] = [];
for (let i = 0; i < calendarDays; i++) {
  const occurredAt = new Date(+now - (i + 1) * 86_400_000).toISOString();
  events.push({ id: `github:contributions:${occurredAt.slice(0, 10)}`, source: "github", kind: "contributions", occurredAt, count: 20 });
}
for (let i = 0; i < postCount; i++) {
  const occurredAt = new Date(+now - i * 2 * 86_400_000).toISOString();
  const uri = `at://${did}/app.bsky.feed.post/fixture${i}` as const;
  const text = "Public synthetic post. ".repeat(8);
  events.push({ id: `bluesky:post:${uri}:${occurredAt}`, source: "bluesky", action: "post", occurredAt, uri,
    url: `https://bsky.app/profile/${did}/post/fixture${i}`, text, author: { handle: "kualta.dev" },
    post: { uri, cid, indexedAt: occurredAt, author: { did, handle: "kualta.dev" },
      record: { $type: "app.bsky.feed.post", createdAt: occurredAt, text },
      embed: { $type: "app.bsky.embed.images#view", images: [{ alt: "Synthetic image", thumb: "https://cdn.bsky.app/fixture.jpg", fullsize: "https://cdn.bsky.app/fixture.jpg", aspectRatio: { width: 1, height: 1 } }] },
    },
  });
}
events.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
const sources = { github: { fetchedAt: now.toISOString(), attemptedAt: now.toISOString() }, bluesky: { fetchedAt: now.toISOString(), attemptedAt: now.toISOString() } };
// Diagnostic upper bound on the saving from moving history to another store.
// This deliberately omits retained history; it is not a deployable cache design.
const cachedArchive = mode === "bounded-cron" ? events.slice(0, 40) : events;
const values = new Map([
  ["activity:state:v3", JSON.stringify({ version: 3, sources, coverage: {}, events: events.slice(0, 40) })],
  ["activity:archive:v3", JSON.stringify({ version: 3, events: cachedArchive })],
]);
const bytes = Object.fromEntries([...values].map(([key, value]) => [key, Buffer.byteLength(value)]));
const cache = { async get(key: string) { return values.get(key) ?? null; }, async put(key: string, value: string) { values.set(key, value); } };
const providers: ActivityProvider[] = [
  { id: "github", async fetch() { return events.filter(event => event.source === "github"); } },
  { id: "bluesky", async fetch() { return events.filter(event => event.source === "bluesky").slice(0, 100); } },
];
// All raw response bytes are prepared outside the samples. The real providers
// still parse JSON, validate schemas and hash synthetic GitHub identifiers.
const days = Array.from({ length: providerDays }, (_, i) => ({
  date: new Date(+now - (i + 1) * 86_400_000).toISOString().slice(0, 10),
  contributionCount: 20,
}));
const years = [...new Set(days.map(day => Number(day.date.slice(0, 4))))];
const calendars = Object.fromEntries(years.map(year => [`y${year}`, { contributionCalendar: { weeks: [{ contributionDays:
  days.filter(day => day.date.startsWith(String(year)))
}] } }]));
const rawEvents = JSON.stringify(Array.from({ length: githubEvents }, (_, i) => ({ id: `synthetic-${i}`, type: "PushEvent", public: i % 2 === 0,
  created_at: now.toISOString(), repo: { name: "kualta/site" }, payload: { head: "a".repeat(40) } })));
const rawPosts = JSON.stringify({ feed: events.filter(event => event.source === "bluesky").slice(0, 100).map(event => ({ post: event.source === "bluesky" ? event.post : undefined })) });
const rawYears = JSON.stringify({ data: { user: { contributionsCollection: { contributionYears: years } } } });
const rawCalendar = JSON.stringify({ data: { user: calendars } });
const fixtureFetch: ProviderContext["fetch"] = async (input, init) => {
  const url = new URL(String(input));
  let payload: string;
  if (url.hostname === "public.api.bsky.app") payload = rawPosts;
  else if (url.hostname !== "api.github.com") throw new Error("Unexpected fixture upstream");
  else if (url.pathname === "/user") payload = '{"login":"kualta"}';
  else if (url.pathname === "/graphql") payload = String(init?.body).includes("contributionYears") ? rawYears : rawCalendar;
  else if (url.pathname === "/users/kualta/events") payload = rawEvents;
  else throw new Error("Unexpected fixture endpoint");
  return new Response(payload, { headers: { "Content-Type": "application/json" } });
};
const logger = { info() {}, warn() { throw new Error("Rejected fixture or failed cache operation; CPU result is invalid"); } };
const samples: { cpuMs: number; elapsedMs: number }[] = [];
for (let i = 0; i < runs; i++) {
  const date = new Date(+now + i * 60_000);
  const started = performance.now();
  const cpu = process.cpuUsage();
  if (mode === "head") await getInitialActivityFeed({ cache, logger, now: date });
  else if (mode === "history") await getActivityHistory({ cache, logger });
  else if (mode === "providers") {
    const context: ProviderContext = { fetch: fixtureFetch, signal: new AbortController().signal, now: date, secrets: { githubToken: "offline-fixture" } };
    await Promise.all([githubProvider.fetch(context), blueskyProvider.fetch(context)]);
  }
  else if (mode === "full-cron" || mode === "bounded-cron") await refreshScheduledActivity({ cache, logger, now: date, fetch: fixtureFetch, githubToken: "offline-fixture" });
  else await refreshScheduledActivity({ cache, logger, now: date, providers });
  const used = process.cpuUsage(cpu);
  samples.push({ cpuMs: (used.user + used.system) / 1000, elapsedMs: performance.now() - started });
}
const ordered = samples.slice(1).map(sample => sample.cpuMs).sort((a, b) => a - b);
console.log(JSON.stringify({ mode, calendarDays, postCount, providerDays, githubEvents, events: events.length, bytes, upstreamBytes: { events: rawEvents.length, posts: rawPosts.length, calendar: rawCalendar.length }, runs, first: samples[0],
  cpuMedianMs: ordered[Math.floor(ordered.length * 0.5)], cpuP95Ms: ordered[Math.floor(ordered.length * 0.95)],
  note: `Synthetic Node/V8 process CPU; includes local GC${["providers", "full-cron", "bounded-cron"].includes(mode) ? " and real provider normalization of fixture JSON" : ", excludes upstream normalization"}, excludes network and D1. ${mode === "bounded-cron" ? "Retained history intentionally omitted; persistence design not implemented. " : ""}Not Cloudflare CPU accounting.` }));
