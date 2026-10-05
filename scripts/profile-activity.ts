/** Synthetic local CPU comparison; never calls providers or remote storage. */
import { getActivityHistory, getInitialActivityFeed, refreshScheduledActivity } from "../src/lib/activity/feed";
import type { ActivityEvent, ActivityProvider } from "../src/lib/activity/types";

const now = new Date("2026-10-05T13:00:00.000Z");
const did = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const cid = "bafyreid3l3mpwbadpafmoajnc2ukaaf42cmnti6shcomrrqnqq4ctap5xy";
const calendarDays = Number(process.env.PROFILE_CALENDAR_DAYS ?? 2000);
const postCount = Number(process.env.PROFILE_POSTS ?? 300);
const runs = Number(process.env.PROFILE_RUNS ?? 100);
const mode = process.env.PROFILE_MODE ?? "cron";
if (!["cron", "head", "history"].includes(mode)) throw new Error("PROFILE_MODE must be cron, head, or history");
if (![calendarDays, postCount, runs].every(Number.isSafeInteger) || calendarDays < 0 || postCount < 0 || runs < 2) {
  throw new Error("Fixture counts must be nonnegative integers and PROFILE_RUNS must be at least 2");
}
const events: ActivityEvent[] = [];
for (let i = 0; i < calendarDays; i++) {
  const occurredAt = new Date(+now - (i + 1) * 86_400_000).toISOString();
  events.push({ id: `github:contributions:${occurredAt.slice(0, 10)}`, source: "github", kind: "contributions", occurredAt, count: 20 });
}
for (let i = 0; i < postCount; i++) {
  const occurredAt = new Date(+now - i * 2 * 86_400_000).toISOString();
  const uri = `at://${did}/app.bsky.feed.post/fixture${i}` as const;
  const text = "Public synthetic post. ".repeat(30);
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
const values = new Map([
  ["activity:state:v3", JSON.stringify({ version: 3, sources, coverage: {}, events: events.slice(0, 40) })],
  ["activity:archive:v3", JSON.stringify({ version: 3, events })],
]);
const bytes = Object.fromEntries([...values].map(([key, value]) => [key, Buffer.byteLength(value)]));
const cache = { async get(key: string) { return values.get(key) ?? null; }, async put(key: string, value: string) { values.set(key, value); } };
const providers: ActivityProvider[] = [
  { id: "github", async fetch() { return events.filter(event => event.source === "github"); } },
  { id: "bluesky", async fetch() { return events.filter(event => event.source === "bluesky").slice(0, 100); } },
];
const logger = { info() {}, warn() {} };
const samples: { cpuMs: number; elapsedMs: number }[] = [];
for (let i = 0; i < runs; i++) {
  const date = new Date(+now + i * 60_000);
  const started = performance.now();
  const cpu = process.cpuUsage();
  if (mode === "head") await getInitialActivityFeed({ cache, logger, now: date });
  else if (mode === "history") await getActivityHistory({ cache, logger });
  else await refreshScheduledActivity({ cache, logger, now: date, providers });
  const used = process.cpuUsage(cpu);
  samples.push({ cpuMs: (used.user + used.system) / 1000, elapsedMs: performance.now() - started });
}
const ordered = samples.slice(1).map(sample => sample.cpuMs).sort((a, b) => a - b);
console.log(JSON.stringify({ mode, calendarDays, postCount, events: events.length, bytes, runs, first: samples[0],
  cpuMedianMs: ordered[Math.floor(ordered.length * 0.5)], cpuP95Ms: ordered[Math.floor(ordered.length * 0.95)],
  note: "Synthetic Node/V8 process CPU; includes local GC, excludes network/API normalization and D1. Not Cloudflare CPU accounting." }));
