import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { NewsletterDB } from "../newsletter/types";
import { postRecordPage, postRecordSource } from "./post-records";

function fixture() {
  const sql = new Database(":memory:");
  for (const name of readdirSync("migrations").sort())
    if (/^00(0[2-9]|1[01])_publisher/.test(name)) sql.exec(readFileSync(`migrations/${name}`, "utf8"));
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
      };
      return stmt;
    },
  } as unknown as NewsletterDB;
  const job = (at: number, payload: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    sql
      .query("INSERT INTO publisher_jobs VALUES (?,?,?)")
      .run(id, JSON.stringify({ kind: "photo", title: "Title", caption: "Caption", ...payload }), at);
    return id;
  };
  const target = (
    jobId: string,
    platform: string,
    state: string,
    url: string | null,
    extra: { linked?: number } = {},
  ) => {
    const id = crypto.randomUUID();
    sql
      .query("INSERT INTO publisher_targets(id,job_id,platform,state,url,finished_at,linked) VALUES (?,?,?,?,?,?,?)")
      .run(id, jobId, platform, state, url, 5000, extra.linked ?? 0);
    return id;
  };
  return { sql, db, job, target };
}

test("a post's record source carries its public words and confirmed copies only", async () => {
  const { sql, db, job, target } = fixture();
  const id = job(1000, {
    tags: ["travel"],
    alt: "PRIVATE",
    media: ["PRIVATE"],
    location: "PRIVATE",
    datesTaken: ["PRIVATE"],
    schedule: { bluesky: 1 },
    zh: { title: "PRIVATE", text: "PRIVATE", topics: [] },
  });
  target(id, "bluesky", "succeeded", "https://bsky.app/profile/did:plc:x/post/3k");
  const removed = target(id, "instagram", "succeeded", "https://www.instagram.com/p/a/");
  target(id, "youtube", "succeeded", "https://youtu.be/abcde", { linked: 1 });
  target(id, "twitter", "failed", null);
  target(id, "tiktok", "uncertain", "https://www.tiktok.com/@k/video/1");
  target(id, "lens", "queued", null);
  sql.query("INSERT INTO publisher_deletions(target_id,state,requested_at) VALUES (?,'deleted',1)").run(removed);
  sql.query("INSERT INTO publisher_thumbnails VALUES (?,?,?,?)").run(id, "image/jpeg", new Uint8Array([1, 2, 3, 4]), 1);
  const source = await postRecordSource(db, id);
  expect(JSON.stringify(source)).not.toContain("PRIVATE");
  expect(source).toEqual({
    id,
    created_at: 1000,
    post: { kind: "photo", title: "Title", caption: "Caption", tags: ["travel"] },
    targets: [
      {
        platform: "bluesky",
        url: "https://bsky.app/profile/did:plc:x/post/3k",
        finished_at: 5000,
        linked: false,
        deleted: false,
      },
      { platform: "instagram", url: "https://www.instagram.com/p/a/", finished_at: 5000, linked: false, deleted: true },
      { platform: "youtube", url: "https://youtu.be/abcde", finished_at: 5000, linked: true, deleted: false },
    ],
    thumbnail: {
      type: "image/jpeg",
      size: 4,
      sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
    },
  });
  expect(await postRecordSource(db, crypto.randomUUID())).toBeNull();
});

test("pages walk every post once, newest first", async () => {
  const { db, job, target } = fixture();
  const ids = Array.from({ length: 23 }, (_, i) => job(1000 + Math.floor(i / 2)));
  target(ids[0], "grain", "succeeded", "https://grain.social/profile/did:plc:x/gallery/3k");
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await postRecordPage(db, cursor);
    seen.push(...page.jobs.map((item) => item.id));
    cursor = page.next;
    pages++;
  } while (cursor);
  expect(pages).toBe(2);
  expect(new Set(seen).size).toBe(23);
  expect([...seen].sort()).toEqual([...ids].sort());
  expect(seen.at(-1) === ids[0] || seen.at(-1) === ids[1]).toBe(true);
  await expect(postRecordPage(db, "nonsense")).rejects.toThrow("Invalid post cursor");
});
