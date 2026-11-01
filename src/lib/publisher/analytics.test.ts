import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { claimAnalytics, saveAnalytics, analyticsPage, analyticsSeries, requestRefresh } from "./analytics";
import { validMetrics, combined, metricSeries, metricValue, timeTicks, valueTicks } from "./metrics";
import type { NewsletterDB } from "../newsletter/types";
function fixture() {
  const sql = new Database(":memory:");
  for (const file of ["0002_publisher.sql", "0005_publisher_deletions.sql", "0006_publisher_analytics.sql"])
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
  expect((await analyticsSeries(f.db, f.job, now)).map((s) => s.metrics.views)).toEqual([2, 4, 5]);
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
test("metrics preserve unavailable versus zero and never double count views plus impressions", () => {
  expect(metricValue({ views: 10, impressions: 20 }, "exposure")).toBe(20);
  expect(metricValue({ likes: 3 }, "exposure")).toBeNull();
  expect(combined([null, null])).toBeNull();
  expect(combined([null, 0])).toBe(0);
  for (const input of [{ views: -1 }, { views: 1.5 }, { views: "10" }, { views: Infinity }, { bad: 2 }, {}])
    expect(() => validMetrics(input)).toThrow();
  expect(
    metricSeries(
      [
        { target_id: "a", observed_at: 86400000, metrics: { views: 10 } },
        { target_id: "b", observed_at: 86400001, metrics: { views: 20 } },
        { target_id: "a", observed_at: 172800000, metrics: { views: 15 } },
      ],
      "exposure",
    ).map((p) => [p.value, p.coverage]),
  ).toEqual([
    [30, 2],
    [35, 2],
  ]);
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
