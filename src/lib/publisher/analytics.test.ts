import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  analyticsOverview,
  analyticsPage,
  analyticsSeries,
  claimAnalytics,
  requestRefresh,
  saveAnalytics,
} from "./analytics";
import {
  combined,
  cumulativeSeries,
  groupMarks,
  metricSeries,
  metricValue,
  stackOrder,
  timeAgo,
  timeTicks,
  validMetrics,
  valueTicks,
} from "./metrics";
import { platforms } from "./presets";
import type { NewsletterDB } from "../newsletter/types";
function fixture() {
  const sql = new Database(":memory:");
  for (const file of [
    "0002_publisher.sql",
    "0005_publisher_deletions.sql",
    "0006_publisher_analytics.sql",
    "0008_publisher_target_finished.sql",
  ])
    sql.exec(readFileSync(`migrations/${file}`, "utf8"));
  const db = {
    prepare(query: string) {
      let values: any[] = [];
      const statement = {
        bind(...args: any[]) {
          values = args;
          return statement;
        },
        async first() {
          return sql.query(query).get(...values);
        },
        async all() {
          return { results: sql.query(query).all(...values) };
        },
        async run() {
          return { meta: sql.query(query).run(...values) };
        },
        sync() {
          return sql.query(query).run(...values);
        },
      };
      return statement;
    },
    async batch(statements: any[]) {
      return sql.transaction(() => statements.map((s) => s.sync()))();
    },
  } as NewsletterDB;
  const job = crypto.randomUUID();
  sql
    .query("INSERT INTO publisher_jobs VALUES (?,?,?)")
    .run(job, JSON.stringify({ title: "Test post", kind: "photo", media: [] }), Date.now());
  function target(platform = "twitter", state = "succeeded") {
    const id = crypto.randomUUID();
    sql
      .query("INSERT INTO publisher_targets(id,job_id,platform,state,url) VALUES(?,?,?,?,?)")
      .run(id, job, platform, state, "https://example.com/post");
    return id;
  }
  return { sql, db, job, target };
}
test("analytics leases each eligible publication once and excludes deleted/pending destinations", async () => {
  const f = fixture();
  const x = f.target(),
    deleted = f.target("grain");
  f.target("bluesky", "queued");
  f.sql.query("INSERT INTO publisher_deletions(target_id,state,requested_at) VALUES(?,'deleted',0)").run(deleted);
  const claim = await claimAnalytics(f.db, ["twitter", "grain", "bluesky"]);
  expect(claim?.target_id).toBe(x);
  expect(await claimAnalytics(f.db, ["twitter", "grain", "bluesky"])).toBeNull();
  await saveAnalytics(f.db, x, claim!.claim, { views: 0, likes: 3 });
  const page = await analyticsPage(f.db, null);
  expect(page.posts[0].targets.find((t: any) => t.id === x)?.metrics).toEqual({ views: 0, likes: 3 });
  expect(await claimAnalytics(f.db, ["twitter"])).toBeNull();
  f.sql.close();
});
test("errors preserve snapshots and stale receipts cannot overwrite a newer lease", async () => {
  const f = fixture();
  const id = f.target();
  const first = (await claimAnalytics(f.db, ["twitter"]))!;
  await saveAnalytics(f.db, id, first.claim, { views: 100 });
  await saveAnalytics(f.db, id, first.claim, { views: 500 });
  f.sql.query("UPDATE publisher_metric_checks SET next_at=0").run();
  const next = (await claimAnalytics(f.db, ["twitter"]))!;
  await saveAnalytics(f.db, id, first.claim, { views: 900 });
  await saveAnalytics(f.db, id, next.claim, null, "Session expired");
  const rows = f.sql.query("SELECT * FROM publisher_metric_snapshots").all();
  expect(rows).toHaveLength(1);
  const target = (await analyticsPage(f.db, null)).posts[0].targets[0];
  expect(target.metrics.views).toBe(100);
  expect(target.analytics_error).toBe("Session expired");
  f.sql.close();
});
test("expired read leases can retry and history returns daily closing samples", async () => {
  const f = fixture();
  const id = f.target();
  const old = (await claimAnalytics(f.db, ["twitter"]))!;
  f.sql.query("UPDATE publisher_metric_checks SET next_at=0").run();
  const next = (await claimAnalytics(f.db, ["twitter"]))!;
  expect(next.claim).not.toBe(old.claim);
  for (const [at, views] of [
    [86400000, 10],
    [86400001, 20],
    [172800000, 30],
  ])
    f.sql.query("INSERT INTO publisher_metric_snapshots VALUES(?,?,?)").run(id, at, JSON.stringify({ views }));
  expect((await analyticsSeries(f.db, f.job)).map((s) => s.metrics.views)).toEqual([20, 30]);
  f.sql.close();
});
test("history keeps hourly closes for the last three days and daily closes before that", async () => {
  const f = fixture();
  const id = f.target();
  const hour = 3_600_000;
  const now = 1000 * 24 * hour;
  const old = now - 10 * 24 * hour;
  for (const [at, views] of [
    [old + hour, 1],
    [old + 2 * hour, 2],
    [now - 5 * hour, 3],
    [now - 5 * hour + 60_000, 4],
    [now - 4 * hour, 5],
  ])
    f.sql.query("INSERT INTO publisher_metric_snapshots VALUES(?,?,?)").run(id, at, JSON.stringify({ views }));
  const series = await analyticsSeries(f.db, f.job, now);
  expect(series.map((s) => s.metrics.views)).toEqual([2, 4, 5]);
  expect(series[0].platform).toBe("twitter");
  f.sql.close();
});
test("a refresh queues only readable destinations not checked in the last five minutes", async () => {
  const f = fixture();
  const due = f.target("bluesky");
  const recent = f.target("twitter");
  const deleted = f.target("grain");
  f.target("tiktok", "queued");
  f.sql.query("UPDATE publisher_metric_checks SET next_at=9e15,checked_at=? WHERE target_id=?").run(Date.now(), recent);
  f.sql.query("UPDATE publisher_metric_checks SET next_at=9e15,checked_at=1 WHERE target_id=?").run(due);
  f.sql.query("INSERT INTO publisher_deletions(target_id,state,requested_at) VALUES(?,'deleted',0)").run(deleted);
  const before = Date.now();
  const { at, queued } = await requestRefresh(f.db, f.job);
  expect(at).toBeGreaterThanOrEqual(before);
  expect(queued).toEqual([due]);
  const row = f.sql.query("SELECT next_at FROM publisher_metric_checks WHERE target_id=?").get(due) as {
    next_at: number;
  };
  expect(row.next_at).toBe(0);
  f.sql.close();
});
test("the overview adds up each destination's closing views by day", async () => {
  const f = fixture();
  const day = 86_400_000;
  const start = 20_000 * day;
  const youtube = f.target("youtube");
  const tiktok = f.target("tiktok");
  const bluesky = f.target("bluesky");
  for (const [id, at, metrics] of [
    [youtube, start + 1_000, { views: 10 }],
    [youtube, start + 2_000, { views: 15 }],
    [tiktok, start + 3_000, { impressions: 7, views: 99 }],
    [bluesky, start + 4_000, { likes: 40 }],
    [youtube, start + day, { views: 12 }],
    [tiktok, start + 3 * day, { impressions: 20 }],
  ] as const)
    f.sql.query("INSERT INTO publisher_metric_snapshots VALUES(?,?,?)").run(id, at, JSON.stringify(metrics));
  const { changes } = await analyticsOverview(f.db, 0);
  expect(cumulativeSeries(changes).map((point) => [point.at, point.value, point.parts])).toEqual([
    [start + 3_000, 22, { youtube: 15, tiktok: 7 }],
    [start + day, 19, { youtube: 12, tiktok: 7 }],
    [start + 2 * day, 19, { youtube: 12, tiktok: 7 }],
    [start + 3 * day, 32, { youtube: 12, tiktok: 20 }],
  ]);
  // Five hours behind UTC, the first readings belong to the day before.
  const local = await analyticsOverview(f.db, -300);
  expect(local.changes.map((row) => row.day)).toEqual([19_999, 19_999, 20_000, 20_002]);
  f.sql.close();
});
test("the overview marks videos that are still up, when they went out, with YouTube's thumbnail", async () => {
  const f = fixture();
  const job = (kind: string, title: string) => {
    const id = crypto.randomUUID();
    f.sql
      .query("INSERT INTO publisher_jobs VALUES (?,?,?)")
      .run(id, JSON.stringify({ title, caption: "", kind, media: [] }), 100);
    return id;
  };
  const target = (jobId: string, platform: string, url: string, finished: number | null, state = "succeeded") => {
    const id = crypto.randomUUID();
    f.sql
      .query("INSERT INTO publisher_targets(id,job_id,platform,state,url,finished_at) VALUES(?,?,?,?,?,?)")
      .run(id, jobId, platform, state, url, finished);
    return id;
  };
  const short = job("video", "Short");
  target(short, "tiktok", "https://www.tiktok.com/@_/video/1", 500);
  target(short, "youtube", "https://www.youtube.com/shorts/abcdefghijk", 400);
  target(short, "instagram", "https://www.instagram.com/p/x/", 300, "failed");
  const elsewhere = job("mixed", "Elsewhere");
  target(elsewhere, "xiaohongshu", "https://www.rednote.com/explore/1", null);
  const gone = job("video", "Gone");
  const deleted = target(gone, "youtube", "https://youtu.be/abcdefghijk", 50);
  f.sql.query("INSERT INTO publisher_deletions(target_id,state,requested_at) VALUES(?,'deleted',0)").run(deleted);
  target(job("video", "Never out"), "youtube", "https://youtu.be/abcdefghijk", 60, "failed");
  target(job("photo", "Photo"), "instagram", "https://www.instagram.com/p/y/", 70);
  const { videos } = await analyticsOverview(f.db, 0);
  expect(videos).toEqual([
    { id: elsewhere, at: 100, label: "Elsewhere", thumbnail: null },
    { id: short, at: 400, label: "Short", thumbnail: "https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg" },
  ]);
  f.sql.close();
});
test("the last update reads in plain language at any age", () => {
  const minute = 60_000;
  const now = 1000 * 24 * 60 * minute;
  expect(timeAgo(now - 30_000, now)).toBe("just now");
  expect(timeAgo(now - minute, now)).toBe("1 minute ago");
  expect(timeAgo(now - 59 * minute, now)).toBe("59 minutes ago");
  expect(timeAgo(now - 9 * 60 * minute, now)).toBe("9 hours ago");
  expect(timeAgo(now - 3 * 24 * 60 * minute, now)).toBe("3 days ago");
});
test("videos too close to mark separately share one mark", () => {
  const mark = (at: number) => ({ id: String(at), at, label: "", thumbnail: null });
  const groups = groupMarks([mark(0), mark(3), mark(5), mark(50)], [0, 100]);
  expect(groups.map((group) => group.map((m) => m.at))).toEqual([[0, 3], [5], [50]]);
});
test("metrics preserve unavailable versus zero and never double count views plus impressions", () => {
  expect(metricValue({ views: 10, impressions: 20 }, "exposure")).toBe(20);
  expect(metricValue({ likes: 3 }, "exposure")).toBeNull();
  expect(combined([null, null])).toBeNull();
  expect(combined([null, 0])).toBe(0);
  for (const input of [{ views: -1 }, { views: 1.5 }, { views: "10" }, { views: Infinity }, { bad: 2 }, {}])
    expect(() => validMetrics(input)).toThrow();
  const series = metricSeries(
    [
      { target_id: "a", platform: "youtube", observed_at: 86400000, metrics: { views: 10 } },
      { target_id: "b", platform: "tiktok", observed_at: 86400001, metrics: { views: 20 } },
      { target_id: "a", platform: "youtube", observed_at: 172800000, metrics: { views: 15 } },
    ],
    "exposure",
  );
  expect(series.map((p) => [p.value, p.coverage])).toEqual([
    [30, 2],
    [35, 2],
  ]);
  expect(series.at(-1)?.parts).toEqual({ youtube: 15, tiktok: 20 });
});
test("a platform's band only starts once it reports, and every platform has a place in the stack", () => {
  const series = metricSeries(
    [
      { target_id: "a", platform: "youtube", observed_at: 0, metrics: { views: 10 } },
      { target_id: "b", platform: "bluesky", observed_at: 3_600_000, metrics: { likes: 1 } },
      { target_id: "c", platform: "instagram", observed_at: 7_200_000, metrics: { views: 5 } },
    ],
    "exposure",
  );
  expect(series.map((p) => p.parts)).toEqual([{ youtube: 10 }, { youtube: 10, instagram: 5 }]);
  expect([...stackOrder].sort()).toEqual([...platforms].sort());
});
test("chart axes use whole numbers from zero and evenly spaced dates", () => {
  expect(valueTicks(0)).toEqual([0, 1]);
  expect(valueTicks(1)).toEqual([0, 1]);
  expect(valueTicks(4)).toEqual([0, 2, 4]);
  expect(valueTicks(13)).toEqual([0, 5, 10, 15]);
  expect(valueTicks(808)).toEqual([0, 500, 1000]);
  const hour = 3_600_000;
  const start = 1000 * 24 * hour;
  for (const span of [2 * hour, 30 * hour, 10 * 24 * hour, 400 * 24 * hour]) {
    const ticks = timeTicks(start, start + span);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThanOrEqual(6);
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(start);
      expect(tick).toBeLessThanOrEqual(start + span);
    }
  }
});
