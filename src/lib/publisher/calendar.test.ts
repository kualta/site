import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { NewsletterDB } from "../newsletter/types";
import { calendarPosts } from "./calendar";

function database() {
  const sqlite = new Database(":memory:");
  for (const name of [
    "0002_publisher.sql",
    "0003_publisher_accounts.sql",
    "0005_publisher_deletions.sql",
    "0006_publisher_analytics.sql",
    "0008_publisher_target_finished.sql",
    "0009_publisher_reposts.sql",
    "0010_publisher_thumbnails.sql",
    "0011_publisher_schedule.sql",
  ])
    sqlite.exec(readFileSync(`migrations/${name}`, "utf8"));
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async all() {
          return { results: sqlite.query(query).all(...(values as never[])) };
        },
      };
      return statement;
    },
  } as unknown as NewsletterDB;
  return { sqlite, db };
}
const day = 86_400_000;
const job = (sqlite: Database, id: string, created: number, post: object) =>
  sqlite
    .query("INSERT INTO publisher_jobs (id, payload, created_at) VALUES (?, ?, ?)")
    .run(id, JSON.stringify(post), created);
const target = (sqlite: Database, row: Record<string, string | number | null>) =>
  sqlite
    .query(
      "INSERT INTO publisher_targets (id, job_id, platform, state, url, started_at, finished_at, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      crypto.randomUUID(),
      row.job,
      row.platform,
      row.state ?? "succeeded",
      row.url ?? null,
      row.started ?? null,
      row.finished ?? null,
      row.scheduled ?? null,
    );

test("the calendar shows each destination on the day it published or is scheduled to", async () => {
  const { sqlite, db } = database();
  const now = 10 * day;
  // A post that went out on day 8, with a picture kept for it.
  job(sqlite, "out", 8 * day, { title: "Part 5", caption: "", kind: "video", media: ["m1"], variants: { a: 1 } });
  target(sqlite, {
    job: "out",
    platform: "youtube",
    url: "https://youtu.be/x",
    started: 8 * day + 60,
    finished: 8 * day + 600,
  });
  target(sqlite, { job: "out", platform: "tiktok", state: "failed", started: 8 * day + 60, finished: 8 * day + 900 });
  sqlite.query("INSERT INTO publisher_thumbnails VALUES ('out', 'image/jpeg', x'00', 77)").run();
  // A post scheduled across two days, one of them already out early by hand.
  job(sqlite, "later", 9 * day, { title: "", caption: "Part 6 is here", kind: "video", media: ["m2"], cover: "c2" });
  target(sqlite, { job: "later", platform: "instagram", state: "queued", scheduled: 11 * day });
  target(sqlite, { job: "later", platform: "xiaohongshu", state: "queued", scheduled: 12 * day });
  // One from last month, outside the range.
  job(sqlite, "old", -20 * day, { title: "Old", caption: "", kind: "text", media: [] });
  target(sqlite, { job: "old", platform: "bluesky", started: -20 * day, finished: -20 * day });

  const posts = await calendarPosts(db, 0, 30 * day, now);
  expect(posts.map((post) => post.id)).toEqual(["out", "later"]);
  expect(posts[0]).toEqual({
    id: "out",
    title: "Part 5",
    caption: "",
    kind: "video",
    media: ["m1"],
    thumbnail: 77,
    targets: [
      {
        platform: "youtube",
        state: "succeeded",
        url: "https://youtu.be/x",
        at: 8 * day + 600,
        scheduled: false,
        deleted: false,
      },
      { platform: "tiktok", state: "failed", url: null, at: 8 * day + 900, scheduled: false, deleted: false },
    ],
  });
  expect(posts[1].cover).toBe("c2");
  expect(posts[1].targets.map((t) => [t.platform, t.at, t.scheduled])).toEqual([
    ["instagram", 11 * day, true],
    ["xiaohongshu", 12 * day, true],
  ]);
  // A range holds only the destinations that fall in it.
  const twelfth = await calendarPosts(db, 12 * day, 13 * day, now);
  expect(twelfth.map((post) => post.targets.map((t) => t.platform))).toEqual([["xiaohongshu"]]);
  sqlite.close();
});

test("a destination not yet claimed sits at its time or when it was queued, and a deleted one says so", async () => {
  const { sqlite, db } = database();
  job(sqlite, "post", 5 * day, { title: "T", caption: "", kind: "text", media: [] });
  // Due an hour ago but the laptop was asleep: still queued, at its scheduled time, no longer waiting.
  target(sqlite, { job: "post", platform: "bluesky", state: "queued", scheduled: 6 * day - 3_600_000 });
  // Queued at once and not yet claimed: at when it was queued.
  target(sqlite, { job: "post", platform: "twitter", state: "queued" });
  target(sqlite, { job: "post", platform: "grain", started: 5 * day, finished: 5 * day + 1 });
  sqlite.exec(
    "INSERT INTO publisher_deletions (target_id, state, requested_at) SELECT id, 'deleted', 1 FROM publisher_targets WHERE platform='grain'",
  );
  const [post] = await calendarPosts(db, 0, 10 * day, 6 * day);
  expect(post.targets.map((t) => [t.platform, t.at, t.scheduled, t.deleted])).toEqual([
    ["twitter", 5 * day, false, false],
    ["grain", 5 * day + 1, false, true],
    ["bluesky", 6 * day - 3_600_000, false, false],
  ]);
  expect(await calendarPosts(db, 20 * day, 30 * day)).toEqual([]);
  sqlite.close();
});
