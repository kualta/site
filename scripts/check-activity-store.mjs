import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

const did = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const cid = "bafyreid3l3mpwbadpafmoajnc2ukaaf42cmnti6shcomrrqnqq4ctap5xy";
const now = Date.now();
const makePost = (rkey, at) => ({ uri: `at://${did}/app.bsky.feed.post/${rkey}`, cid, indexedAt: at,
  author: { did, handle: "kualta.dev" }, record: { $type: "app.bsky.feed.post", text: "Public synthetic post. ".repeat(8), createdAt: at },
  embed: { $type: "app.bsky.embed.images#view", images: [{ alt: "fixture", thumb: "https://cdn.bsky.app/fixture.jpg", fullsize: "https://cdn.bsky.app/fixture.jpg" }] },
});
const oldTime = new Date(now - 3_600_000).toISOString();
const events = Array.from({ length: 2_000 }, (_, i) => {
  const at = new Date(now - (i + 1) * 86_400_000).toISOString();
  return { id: `github:contributions:${at.slice(0, 10)}`, source: "github", kind: "contributions", occurredAt: at, count: 20 };
});
for (let i = 0; i < 300; i++) {
  const at = new Date(now - (i + 1) * 86_400_000).toISOString();
  const post = makePost(`history${i}`, at);
  events.push({ id: `bluesky:post:${post.uri}:${at}`, source: "bluesky", action: "post", occurredAt: at, uri: post.uri,
    url: `https://bsky.app/profile/${did}/post/history${i}`, text: post.record.text, author: { handle: "kualta.dev" }, post });
}
events.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
const sources = { github: { fetchedAt: oldTime, attemptedAt: oldTime }, bluesky: { fetchedAt: oldTime, attemptedAt: oldTime } };
const legacyArchive = JSON.stringify({ version: 3, events });
let mode = "ok";
let requests = 0;
const modules = (await readdir("dist/server", { recursive: true })).filter(file => file.endsWith(".mjs"))
  .sort((a, b) => a === "entry.mjs" ? -1 : b === "entry.mjs" ? 1 : a.localeCompare(b))
  .map(file => ({ type: "ESModule", path: resolve("dist/server", file) }));
const mf = new Miniflare({
  modules, modulesRoot: resolve("dist/server"), compatibilityDate: "2026-05-18", compatibilityFlags: ["nodejs_compat"],
  kvNamespaces: ["SESSION", "ACTIVITY_CACHE"], durableObjects: { ACTIVITY_STORE: { className: "ActivityStatusCache", useSQLite: true } },
  bindings: { GITHUB_ACTIVITY_TOKEN: "offline-fixture" },
  outboundService: async (request) => {
    requests++;
    if (mode === "failed") return new Response("Unavailable", { status: 503 });
    if (mode === "slow") await new Promise(resolve => setTimeout(resolve, 6_000));
    const url = new URL(request.url);
    if (url.hostname === "public.api.bsky.app") {
      const post = makePost("newpost", new Date(now).toISOString());
      return Response.json({ feed: [{ post: { ...post, viewer: { like: `at://${did}/app.bsky.feed.like/private-viewer` }, debug: { token: "private-debug" } } }] });
    }
    assert.equal(url.hostname, "api.github.com");
    if (url.pathname === "/user") return Response.json({ login: "kualta" });
    if (url.pathname === "/users/kualta/events") return Response.json([{ id: "private-raw-id", type: "PushEvent", public: false,
      created_at: new Date(now).toISOString(), repo: { name: "private-repository" }, payload: { head: "private-target" } }]);
    assert.equal(url.pathname, "/graphql");
    const body = await request.json();
    if (body.query.includes("contributionYears")) return Response.json({ data: { user: { contributionsCollection: { contributionYears: [new Date(now).getUTCFullYear()] } } } });
    return Response.json({ data: { user: { [`y${new Date(now).getUTCFullYear()}`]: { contributionCalendar: { weeks: [{ contributionDays: [{ date: new Date(now).toISOString().slice(0, 10), contributionCount: 20 }] }] } } } } });
  },
});
try {
  const legacy = await mf.getKVNamespace("ACTIVITY_CACHE");
  await legacy.put("activity:archive:v3", legacyArchive);
  await legacy.put("activity:state:v3", JSON.stringify({ version: 3, sources, coverage: {}, events: events.slice(0, 40) }));
  const namespace = await mf.getDurableObjectNamespace("ACTIVITY_STORE");
  const object = namespace.get(namespace.idFromName("kualta-public-activity-v1"));
  const callRefresh = time => object.fetch("https://activity.internal/refresh", { method: "POST", body: JSON.stringify({ scheduledTime: time }) });
  const head = async () => { const r = await object.fetch("https://activity.internal/head"); assert.equal(r.status, 200); return r.json(); };
  const old = await head();
  assert.equal(old.sources.github.fetchedAt, oldTime);
  assert.equal(requests, 0, "Visitor reads must not call providers");
  const start = Math.floor(now / 60_000) * 60_000 - 180_000;
  const started = performance.now();
  const response = await callRefresh(start);
  assert.equal(response.status, 204);
  const refreshMs = performance.now() - started;
  const fresh = await head();
  assert.equal(fresh.delayed, false);
  assert(Date.parse(fresh.sources.github.fetchedAt) > Date.parse(oldTime));
  for (const privateText of ["private-repository", "private-target", "private-raw-id", "private-viewer", "private-debug"]) assert(!JSON.stringify(fresh).includes(privateText));
  const calls = requests;
  assert.equal((await callRefresh(start)).status, 204);
  assert.equal(requests, calls, "Duplicate delivery must not fetch providers");
  const history = await (await object.fetch("https://activity.internal/history")).json();
  assert.equal(history.events.length, 100);
  assert.equal(history.completeSince, events.filter(event => event.source === "bluesky").at(-1).occurredAt);
  assert.equal(await legacy.get("activity:archive:v3"), legacyArchive, "Refresh must not write legacy KV");
  mode = "failed";
  assert.equal((await callRefresh(start + 60_000)).status, 204);
  const failed = await head();
  assert.equal(failed.sources.github.fetchedAt, fresh.sources.github.fetchedAt);
  assert.equal(failed.sources.bluesky.fetchedAt, fresh.sources.bluesky.fetchedAt);
  assert.deepEqual(failed.events, fresh.events);
  mode = "slow";
  const slowStart = performance.now();
  const pending = callRefresh(start + 120_000);
  await new Promise(resolve => setTimeout(resolve, 50));
  const readStart = performance.now();
  await head();
  const readDuringRefreshMs = performance.now() - readStart;
  assert(readDuringRefreshMs < 1_000, "Reads must not wait for provider refresh");
  assert.equal((await pending).status, 204);
  const slowRefreshMs = performance.now() - slowStart;
  assert(slowRefreshMs < 5_750, "Provider timeout must stay bounded");
  const timedOut = await head();
  assert.equal(timedOut.sources.github.fetchedAt, fresh.sources.github.fetchedAt);
  mode = "ok";
  assert.equal((await callRefresh(start + 180_000)).status, 204);
  assert(Date.parse((await head()).sources.github.fetchedAt) > Date.parse(fresh.sources.github.fetchedAt));
  console.log(JSON.stringify({ compiledSQLiteObject: true, archiveBytes: Buffer.byteLength(legacyArchive), bootstrapRetainsHistory: true,
    noLegacyKVWrites: true, noVisitorProviderCalls: true, deduplicatedRefresh: true, privacyPreserved: true,
    failedAndSlowSourcesPreserveFreshness: true, recovery: true, refreshMs, slowRefreshMs, readDuringRefreshMs }));
} finally { await mf.dispose(); }
