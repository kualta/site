import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { NewsletterDB } from "../newsletter/types";
import {
  createContent,
  deleteContent,
  listContent,
  readContent,
  releaseJob,
  updateContent,
  type PiecePost,
} from "./content";

function fixture() {
  const sql = new Database(":memory:");
  // D1 enforces foreign keys.
  sql.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0002_publisher.sql",
    "0003_publisher_accounts.sql",
    "0005_publisher_deletions.sql",
    "0006_publisher_analytics.sql",
    "0008_publisher_target_finished.sql",
    "0009_publisher_reposts.sql",
    "0010_publisher_thumbnails.sql",
    "0011_publisher_schedule.sql",
    "0012_publisher_content.sql",
  ])
    sql.exec(readFileSync(`migrations/${name}`, "utf8"));
  const statement = (query: string) => {
    let values: any[] = [];
    const stmt = {
      bind(...v: any[]) {
        values = v;
        return stmt;
      },
      async first() {
        return sql.query(query).get(...values) ?? null;
      },
      async all() {
        return { results: sql.query(query).all(...values) };
      },
      async run() {
        return { meta: sql.query(query).run(...values) };
      },
    };
    return stmt;
  };
  const db = {
    prepare: statement,
    async batch(statements: { run(): Promise<unknown> }[]) {
      sql.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as NewsletterDB;
  const job = crypto.randomUUID();
  sql.query("INSERT INTO publisher_jobs VALUES (?, '{}', 1)").run(job);
  return { sql, db, job };
}

test("a new piece starts as an idea, and moving it records when it got there", async () => {
  const { db } = fixture();
  const idea = await createContent(db, { title: "  Lorax wisdom, part 8 " }, 100);
  expect(idea).toMatchObject({
    title: "Lorax wisdom, part 8",
    notes: "",
    stage: "idea",
    job_id: null,
    created_at: 100,
    stage_at: 100,
  });
  // Writing the script leaves it where it is.
  expect(await updateContent(db, idea.id, { notes: "Open on the truffula stump" }, 200)).toMatchObject({
    stage: "idea",
    stage_at: 100,
    notes: "Open on the truffula stump",
  });
  expect(await updateContent(db, idea.id, { stage: "script" }, 300)).toMatchObject({ stage: "script", stage_at: 300 });
  // Choosing the stage it's already at isn't a move.
  expect(await updateContent(db, idea.id, { stage: "script", title: "Part 8" }, 400)).toMatchObject({
    title: "Part 8",
    stage_at: 300,
  });
});

test("linking a post moves it to Posted, and moving it back lets the post go", async () => {
  const { db, job } = fixture();
  const piece = await createContent(db, { title: "Square windows", stage: "edit" }, 1);
  expect(await updateContent(db, piece.id, { job }, 2)).toMatchObject({ stage: "posted", job_id: job, stage_at: 2 });
  expect(await updateContent(db, piece.id, { stage: "edit" }, 3)).toMatchObject({ stage: "edit", job_id: null });
  // Marked posted by hand, for a post made outside the composer: there's nothing to link.
  expect(await updateContent(db, piece.id, { stage: "posted" }, 4)).toMatchObject({ stage: "posted", job_id: null });
  await expect(updateContent(db, piece.id, { job, stage: "idea" })).rejects.toThrow("A linked post means it's posted");
  await expect(updateContent(db, piece.id, { job: crypto.randomUUID() })).rejects.toThrow("No such post");
});

test("what a request sets is checked", async () => {
  const { db } = fixture();
  await expect(createContent(db, {})).rejects.toThrow("Give it a title");
  await expect(createContent(db, { title: "   " })).rejects.toThrow("Give it a title");
  await expect(createContent(db, { title: "x".repeat(201) })).rejects.toThrow("200 characters");
  await expect(createContent(db, { title: "A", stage: "filming" })).rejects.toThrow("Invalid stage");
  await expect(createContent(db, { title: "A", notes: "x".repeat(20_001) })).rejects.toThrow("20,000");
  await expect(createContent(db, { title: "A", job: crypto.randomUUID() })).rejects.toThrow("from the composer");
  const piece = await createContent(db, { title: "A" });
  await expect(updateContent(db, piece.id, { title: "" })).rejects.toThrow("Give it a title");
  await expect(updateContent(db, piece.id, { job: "nope" })).rejects.toThrow("Invalid post");
  expect(await updateContent(db, crypto.randomUUID(), { title: "B" })).toBeNull();
});

test("the list has every piece on its way and only the latest posted, newest arrival first", async () => {
  const { db, sql, job } = fixture();
  const early = await createContent(db, { title: "Early idea" }, 10);
  const late = await createContent(db, { title: "Late idea" }, 20);
  for (let i = 0; i < 4; i++) await createContent(db, { title: `Posted ${i}`, stage: "posted" }, 30 + i);
  const linked = await createContent(db, { title: "Linked", stage: "edit" }, 5);
  await updateContent(db, linked.id, { job }, 40);
  sql.query("INSERT INTO publisher_thumbnails VALUES (?, 'image/jpeg', x'00', 41)").run(job);
  const list = await listContent(db, 3);
  expect(list.map((piece) => piece.title)).toEqual(["Linked", "Posted 3", "Posted 2", "Late idea", "Early idea"]);
  expect(list[0].thumbnail).toBe(41);
  expect(list.find((piece) => piece.id === early.id)?.thumbnail).toBeNull();
  expect((await readContent(db, late.id))?.title).toBe("Late idea");
});

test("a posted piece carries its post's picture sources and each destination's latest counts", async () => {
  const { db, sql } = fixture();
  const job = crypto.randomUUID();
  const [video, cover] = [crypto.randomUUID(), crypto.randomUUID()];
  sql
    .query("INSERT INTO publisher_jobs VALUES (?, ?, 1)")
    .run(job, JSON.stringify({ kind: "video", media: [video], cover, caption: "unused" }));
  const target = sql.query("INSERT INTO publisher_targets (id, job_id, platform, state, url) VALUES (?, ?, ?, ?, ?)");
  target.run("youtube", job, "youtube", "succeeded", "https://www.youtube.com/shorts/CJs864wmjB0");
  target.run("tiktok", job, "tiktok", "succeeded", "https://www.tiktok.com/@_/video/1");
  target.run("instagram", job, "instagram", "failed", null);
  const snapshot = sql.query("INSERT INTO publisher_metric_snapshots VALUES (?, ?, ?)");
  snapshot.run("youtube", 10, JSON.stringify({ views: 100 }));
  snapshot.run("youtube", 20, JSON.stringify({ views: 1213, likes: 30 }));
  sql.query("INSERT INTO publisher_deletions (target_id, state, requested_at) VALUES ('tiktok', 'deleted', 5)").run();
  const piece = await createContent(db, { title: "Square windows", stage: "edit" });
  expect(piece.post).toBeNull();
  await updateContent(db, piece.id, { job });
  const expected: PiecePost = {
    kind: "video",
    media: [video],
    cover,
    targets: [
      {
        id: "youtube",
        platform: "youtube",
        url: "https://www.youtube.com/shorts/CJs864wmjB0",
        deleted: false,
        metrics: { views: 1213, likes: 30 },
      },
      { id: "tiktok", platform: "tiktok", url: "https://www.tiktok.com/@_/video/1", deleted: true, metrics: null },
    ],
  };
  expect((await readContent(db, piece.id))?.post).toEqual(expected);
  expect((await listContent(db)).find((item) => item.id === piece.id)?.post).toEqual(expected);
  // Moved back, it lets go of its post and shows none.
  expect((await updateContent(db, piece.id, { stage: "edit" }))?.post).toBeNull();
});

test("cancelling its post puts the piece back at Edit ready, so the post can be deleted", async () => {
  const { db, sql, job } = fixture();
  const piece = await createContent(db, { title: "Better schools", stage: "edit" }, 1);
  await updateContent(db, piece.id, { job }, 2);
  // The foreign key holds a post that a piece still points at.
  expect(() => sql.query("DELETE FROM publisher_jobs WHERE id = ?").run(job)).toThrow("FOREIGN KEY");
  await db.batch([releaseJob(db, job, 3), db.prepare("DELETE FROM publisher_jobs WHERE id = ?").bind(job)]);
  expect(await readContent(db, piece.id)).toMatchObject({ stage: "edit", job_id: null, stage_at: 3 });
  expect(await deleteContent(db, piece.id)).toBe(true);
  expect(await deleteContent(db, piece.id)).toBe(false);
});

test("posts that went out before the Pipeline join Posted, named as History names them", async () => {
  const { db, sql, job: linked } = fixture();
  const addJob = (payload: object, createdAt: number, targets: [string, number | null, number | null][]) => {
    const id = crypto.randomUUID();
    sql.query("INSERT INTO publisher_jobs VALUES (?, ?, ?)").run(id, JSON.stringify(payload), createdAt);
    for (const [state, started, finished] of targets)
      sql
        .query(
          "INSERT INTO publisher_targets (id, job_id, platform, state, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(crypto.randomUUID(), id, crypto.randomUUID(), state, started, finished);
    return id;
  };
  const titled = addJob({ title: "Square windows", caption: "Lorax wisdom" }, 10, [
    ["failed", 11, 12],
    ["succeeded", 13, 20],
    ["succeeded", 14, 15],
  ]);
  const text = addJob({ title: "", caption: "\n  meow, part one\nsecond line" }, 30, [["succeeded", 31, null]]);
  const long = addJob({ title: "", caption: "x".repeat(90) }, 40, [["succeeded", null, null]]);
  const blank = addJob({ title: "", caption: "" }, 50, [["succeeded", 51, 52]]);
  // Never went out anywhere, so it isn't posted.
  addJob({ title: "Failed everywhere", caption: "" }, 60, [["failed", 61, 62]]);
  // Already linked from the composer: it keeps its own piece.
  sql
    .query("INSERT INTO publisher_targets (id, job_id, platform, state) VALUES (?, ?, 'bluesky', 'succeeded')")
    .run(crypto.randomUUID(), linked);
  const piece = await createContent(db, { title: "Linked by hand", stage: "edit" }, 1);
  await updateContent(db, piece.id, { job: linked }, 2);
  sql.exec(readFileSync("migrations/0013_publisher_content_backfill.sql", "utf8"));
  const list = await listContent(db);
  expect(
    list.map(({ title, job_id, created_at, stage_at, notes }) => ({ title, job_id, created_at, stage_at, notes })),
  ).toEqual([
    { title: "Untitled", job_id: blank, created_at: 50, stage_at: 52, notes: "" },
    { title: "x".repeat(80), job_id: long, created_at: 40, stage_at: 40, notes: "" },
    { title: "meow, part one", job_id: text, created_at: 30, stage_at: 31, notes: "" },
    { title: "Square windows", job_id: titled, created_at: 10, stage_at: 15, notes: "" },
    { title: "Linked by hand", job_id: linked, created_at: 1, stage_at: 2, notes: "" },
  ]);
  expect(list.every((p) => p.stage === "posted")).toBe(true);
  // Each takes its post's id, which the API accepts as a piece's.
  expect(list.filter((p) => p.job_id !== linked).every((p) => p.id === p.job_id)).toBe(true);
});
