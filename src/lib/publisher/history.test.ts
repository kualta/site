import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { claimDeletion, queueDeletion, historyPage } from "./history";
import type { NewsletterDB } from "../newsletter/types";
function fixture() {
  const sql = new Database(":memory:");
  for (const name of [
    "0002_publisher.sql",
    "0003_publisher_accounts.sql",
    "0005_publisher_deletions.sql",
    "0006_publisher_analytics.sql",
    "0008_publisher_target_finished.sql",
    "0009_publisher_reposts.sql",
  ])
    sql.exec(readFileSync(`migrations/${name}`, "utf8"));
  const db = {
    prepare(query: string) {
      let values: any[] = [];
      const stmt = {
        bind(...v: any[]) {
          values = v;
          return stmt;
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
      };
      return stmt;
    },
  } as unknown as NewsletterDB;
  const job = crypto.randomUUID();
  sql
    .query("INSERT INTO publisher_jobs VALUES (?,?,?)")
    .run(job, JSON.stringify({ title: "Saved caption", media: [] }), 1000);
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  ["grain", "bluesky", "twitter"].forEach((platform, index) =>
    sql
      .query("INSERT INTO publisher_targets(id,job_id,platform,state,url) VALUES (?,?,?,?,?)")
      .run(
        ids[index],
        job,
        platform,
        index === 2 ? "failed" : "succeeded",
        index === 2 ? null : "https://example.test/post",
      ),
  );
  return { sql, db, job, ids };
}
test("delete everywhere queues only confirmed posts and claims each once", async () => {
  const { db, sql, job, ids } = fixture();
  await queueDeletion(db, job, undefined);
  await queueDeletion(db, job, undefined);
  expect(sql.query("SELECT * FROM publisher_deletions").all()).toHaveLength(2);
  const first = await claimDeletion(db, ["grain"]);
  expect(first?.target_id).toBe(ids[0]);
  expect(await claimDeletion(db, ["grain"])).toBeNull();
  await queueDeletion(db, job, ids[0]);
  expect(await claimDeletion(db, ["grain"])).toBeNull();
  expect((await historyPage(db, null)).posts[0].targets).toHaveLength(3);
});
test("interrupted deletes become uncertain; only explicit retry queues them again", async () => {
  const { db, sql, job, ids } = fixture();
  await queueDeletion(db, job, ids[0]);
  await claimDeletion(db, ["grain"]);
  sql.query("UPDATE publisher_deletions SET started_at=0").run();
  expect(await claimDeletion(db, ["grain"])).toBeNull();
  expect((sql.query("SELECT state FROM publisher_deletions").get() as any).state).toBe("uncertain");
  await queueDeletion(db, job, ids[0]);
  expect((await claimDeletion(db, ["grain"]))?.target_id).toBe(ids[0]);
  sql.query("UPDATE publisher_deletions SET state='deleted'").run();
  await queueDeletion(db, job, ids[0]);
  expect(await claimDeletion(db, ["grain"])).toBeNull();
  expect((await historyPage(db, null)).posts).toHaveLength(1);
});
test("history pagination includes older jobs with stable tie-breaking", async () => {
  const { db, sql } = fixture();
  for (let i = 0; i < 30; i++)
    sql.query("INSERT INTO publisher_jobs VALUES (?,?,?)").run(crypto.randomUUID(), "{}", 1000);
  const first = await historyPage(db, null);
  const second = await historyPage(db, first.next);
  expect(first.posts).toHaveLength(20);
  expect(second.posts).toHaveLength(11);
  expect(new Set([...first.posts, ...second.posts].map((post) => post.id)).size).toBe(31);
  expect(second.next).toBeNull();
  await expect(historyPage(db, "bad")).rejects.toThrow();
});
test("bulk deletion waits for publishing to finish", async () => {
  const { db, sql, job, ids } = fixture();
  sql.query("UPDATE publisher_targets SET state='working' WHERE platform='twitter'").run();
  await queueDeletion(db, job, undefined);
  expect(sql.query("SELECT * FROM publisher_deletions").all()).toHaveLength(0);
  await queueDeletion(db, job, ids[0]);
  expect(sql.query("SELECT * FROM publisher_deletions").all()).toHaveLength(1);
});
test("one of two publications on a platform can be deleted, and those from before a sign-in change are marked", async () => {
  const { db, sql, job } = fixture();
  const add = sql.query(
    "INSERT INTO publisher_targets(id,job_id,platform,state,url,finished_at,linked) VALUES (?,?,'tiktok','succeeded',?,?,?)",
  );
  const [old, repost] = [crypto.randomUUID(), crypto.randomUUID()];
  add.run(old, job, "https://www.tiktok.com/@_/video/1", 100, 0);
  add.run(repost, job, "https://www.tiktok.com/@kualtq/video/2", 300, 1);
  sql
    .query("INSERT INTO publisher_connections(id,platform,action,state,created_at) VALUES (?,?,?,?,?)")
    .run(crypto.randomUUID(), "tiktok", "disconnect", "succeeded", 200);
  const targets = (await historyPage(db, null)).posts[0].targets as any[];
  const flag = (id: string) => targets.find((t) => t.id === id).earlier_sign_in;
  expect([flag(old), flag(repost)]).toEqual([1, 0]);
  expect(targets.filter((t) => t.platform !== "tiktok").every((t) => t.earlier_sign_in === 0)).toBe(true);
  await queueDeletion(db, job, old);
  expect(sql.query("SELECT target_id FROM publisher_deletions").all()).toEqual([{ target_id: old }]);
});
