import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

const migrate = (sql: Database, file: string) => sql.exec(readFileSync(`migrations/${file}`, "utf8"));
test("rebuilding the targets keeps every publication, its stats and its place, with foreign keys on", () => {
  const sql = new Database(":memory:");
  sql.exec("PRAGMA foreign_keys = ON");
  for (const file of [
    "0002_publisher.sql",
    "0003_publisher_accounts.sql",
    "0005_publisher_deletions.sql",
    "0006_publisher_analytics.sql",
    "0008_publisher_target_finished.sql",
  ])
    migrate(sql, file);
  sql.query("INSERT INTO publisher_jobs VALUES ('job', '{}', 1)").run();
  const add = sql.query(
    "INSERT INTO publisher_targets (id, job_id, platform, state, url, finished_at) VALUES (?, 'job', ?, ?, ?, 5)",
  );
  add.run("b", "tiktok", "succeeded", "https://www.tiktok.com/@_/video/1");
  add.run("a", "youtube", "queued", null);
  sql.query("UPDATE publisher_metric_checks SET next_at = 9, checked_at = 8 WHERE target_id = 'b'").run();
  sql.query("INSERT INTO publisher_metric_snapshots VALUES ('b', 7, '{\"views\":3}')").run();
  sql.query("INSERT INTO publisher_deletions (target_id, state, requested_at) VALUES ('b', 'failed', 6)").run();
  // Uncached, so each read sees the columns the table has now.
  const read = () => ({
    targets: sql.prepare("SELECT rowid, * FROM publisher_targets ORDER BY rowid").all(),
    checks: sql.prepare("SELECT * FROM publisher_metric_checks").all(),
    snapshots: sql.prepare("SELECT * FROM publisher_metric_snapshots").all(),
    deletions: sql.prepare("SELECT * FROM publisher_deletions").all(),
  });
  const before = read();
  migrate(sql, "0009_publisher_reposts.sql");
  const after = read();
  expect(after.targets).toEqual(before.targets.map((t) => ({ ...(t as object), linked: 0 })));
  expect({ ...after, targets: [] }).toEqual({ ...before, targets: [] });
  expect(sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
  // A second publication on the same platform now fits, and still gets its stats read.
  sql
    .query(
      "INSERT INTO publisher_targets (id, job_id, platform, state, url, linked) VALUES ('c', 'job', 'tiktok', 'succeeded', 'https://www.tiktok.com/@kualtq/video/2', 1)",
    )
    .run();
  expect(sql.query("SELECT target_id FROM publisher_metric_checks WHERE target_id = 'c'").get()).toEqual({
    target_id: "c",
  });
  expect(() => sql.query("INSERT INTO publisher_metric_snapshots VALUES ('missing', 1, '{}')").run()).toThrow(
    "FOREIGN KEY",
  );
});
