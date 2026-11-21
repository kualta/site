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
    sql.query("INSERT INTO publisher_jobs VALUES (?,?,?)").run(
      id,
      JSON.stringify({
        kind: "photo",
        title: "Title",
        caption: "Caption",
        visibility: "PUBLIC",
        ...payload,
      }),
      at,
    );
    return id;
  };
  /** `how`: sent by the helper, marked published by hand, or linked from History. */
  const target = (
    jobId: string,
    platform: string,
    url: string | null,
    how: "sent" | "marked" | "linked" = "sent",
    state = "succeeded",
  ) => {
    const id = crypto.randomUUID();
    sql
      .query(
        "INSERT INTO publisher_targets(id,job_id,platform,state,url,finished_at,linked,message) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(id, jobId, platform, state, url, 5000, how === "linked" ? 1 : 0, how === "sent" ? "" : null);
    return id;
  };
  const remove = (id: string) =>
    sql.query("INSERT INTO publisher_deletions(target_id,state,requested_at) VALUES (?,'deleted',1)").run(id);
  return { sql, db, job, target, remove };
}
const bsky = "https://bsky.app/profile/did:plc:x/post/3k";

test("a post's record source carries its public words and confirmed copies only", async () => {
  const { sql, db, job, target, remove } = fixture();
  const id = job(1000, {
    tags: ["travel"],
    alt: "PRIVATE",
    media: ["PRIVATE"],
    location: "PRIVATE",
    datesTaken: ["PRIVATE"],
    schedule: { bluesky: 1 },
    short: "PRIVATE",
    zh: { title: "PRIVATE", text: "PRIVATE", topics: [] },
  });
  target(id, "grain", "https://grain.social/profile/did:plc:x/gallery/3k");
  remove(target(id, "instagram", "https://www.instagram.com/p/abcde/"));
  target(id, "tiktok", "https://www.tiktok.com/@k/video/123", "linked");
  target(id, "twitter", null, "sent", "failed");
  target(id, "xiaohongshu", "https://www.xiaohongshu.com/explore/1", "sent", "uncertain");
  target(id, "lens", null, "sent", "queued");
  sql.query("INSERT INTO publisher_thumbnails VALUES (?,?,?,?)").run(id, "image/jpeg", new Uint8Array([1, 2, 3, 4]), 1);
  const source = await postRecordSource(db, id);
  expect(JSON.stringify(source)).not.toContain("PRIVATE");
  expect(source).toEqual({
    id,
    created_at: 1000,
    post: { kind: "photo", title: "Title", text: "Caption", tags: [] },
    targets: [
      {
        platform: "grain",
        url: "https://grain.social/profile/did:plc:x/gallery/3k",
        published_at: 5000,
        deleted: false,
      },
      { platform: "instagram", url: "https://www.instagram.com/p/abcde/", published_at: 5000, deleted: true },
      { platform: "tiktok", url: "https://www.tiktok.com/@k/video/123", published_at: null, deleted: false },
    ],
    thumbnail: {
      type: "image/jpeg",
      size: 4,
      sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
    },
  });
  expect(await postRecordSource(db, crypto.randomUUID())).toBeNull();
});

test("a post with no public copy up leaves as its id alone", async () => {
  const { db, job, target, remove } = fixture();
  const queued = job(1);
  target(queued, "bluesky", null, "sent", "queued");
  const deleted = job(2);
  remove(target(deleted, "bluesky", bsky));
  expect(await postRecordSource(db, queued)).toEqual({ id: queued, targets: [] });
  expect(await postRecordSource(db, deleted)).toEqual({ id: deleted, targets: [] });
  expect((await postRecordPage(db, null)).jobs).toEqual([
    { id: deleted, targets: [] },
    { id: queued, targets: [] },
  ]);
});

for (const visibility of ["PUBLIC", "UNLISTED", "PRIVATE"]) {
  test(`a ${visibility} YouTube video ${visibility === "PUBLIC" ? "is" : "is never"} a public copy`, async () => {
    const { db, job, target } = fixture();
    const alone = job(1, { kind: "video", visibility });
    target(alone, "youtube", "https://youtu.be/abcdefghijk");
    target(alone, "youtube", "https://www.youtube.com/shorts/lmnopqrstuv", "linked");
    const beside = job(2, { kind: "video", visibility });
    target(beside, "youtube", "https://youtu.be/abcdefghijk");
    target(beside, "bluesky", bsky);
    const [only, both] = [await postRecordSource(db, alone), await postRecordSource(db, beside)];
    if (visibility === "PUBLIC") {
      expect(only?.targets.map((copy) => copy.url)).toEqual([
        "https://www.youtube.com/watch?v=abcdefghijk",
        "https://www.youtube.com/shorts/lmnopqrstuv",
      ]);
      expect(only?.post?.title).toBe("Title");
      expect(both?.targets.map((copy) => copy.platform)).toEqual(["youtube", "bluesky"]);
    } else {
      expect(only).toEqual({ id: alone, targets: [] });
      expect(JSON.stringify(both)).not.toContain("youtu");
      expect(both?.targets.map((copy) => copy.platform)).toEqual(["bluesky"]);
      // Bluesky shows no title, and YouTube's isn't public.
      expect(both?.post?.title).toBe("");
    }
  });
}

test("the words are the ones a copy that is up shows", async () => {
  const { db, job, target, remove } = fixture();
  const words = async (id: string) => (await postRecordSource(db, id))?.post;
  const payload = {
    kind: "video",
    title: "Title",
    caption: "The full caption",
    short: "Short",
    tags: ["travel", "bogota"],
    zh: { title: "标题", text: "正文", topics: ["旅行"] },
  };

  const chinese = job(1, payload);
  target(chinese, "xiaohongshu", "https://www.xiaohongshu.com/explore/0123456789abcdef01234567");
  expect(await words(chinese)).toEqual({ kind: "video", title: "标题", text: "正文", tags: ["旅行"] });

  const brief = job(2, payload);
  target(brief, "twitter", "https://x.com/k/status/1");
  target(brief, "bluesky", bsky);
  // Bluesky keeps the tags out of sight on its record; X shows none.
  expect(await words(brief)).toEqual({ kind: "video", title: "", text: "Short", tags: ["travel", "bogota"] });

  const briefOnX = job(3, payload);
  target(briefOnX, "twitter", "https://x.com/k/status/2");
  expect(await words(briefOnX)).toEqual({ kind: "video", title: "", text: "Short", tags: [] });

  const full = job(4, payload);
  target(full, "twitter", "https://x.com/k/status/3");
  target(full, "xiaohongshu", "https://www.xiaohongshu.com/explore/0123456789abcdef01234568");
  const instagram = target(full, "instagram", "https://www.instagram.com/reel/abcde/");
  expect(await words(full)).toEqual({
    kind: "video",
    title: "",
    text: "The full caption\n\n#travel #bogota",
    tags: ["travel", "bogota"],
  });
  remove(instagram);
  expect((await words(full))?.text).toBe("Short");

  const titled = job(5, payload);
  target(titled, "grain", "https://grain.social/profile/did:plc:x/gallery/3k");
  target(titled, "instagram", "https://www.instagram.com/reel/abcdf/");
  expect(await words(titled)).toEqual({
    kind: "video",
    title: "Title",
    text: "The full caption",
    tags: ["travel", "bogota"],
  });

  // Edited after Bluesky went out: Bluesky keeps the version it was sent.
  const edited = job(6, {
    ...payload,
    caption: "Rewritten",
    short: "",
    variants: { bluesky: { title: "", text: "As sent", tags: [] } },
  });
  target(edited, "bluesky", bsky);
  target(edited, "instagram", null, "sent", "queued");
  expect(await words(edited)).toEqual({ kind: "video", title: "", text: "As sent", tags: [] });

  const linked = job(7, payload);
  target(linked, "instagram", "https://www.instagram.com/reel/abcdg/", "linked");
  expect(await words(linked)).toEqual({ kind: "video", title: "", text: "", tags: [] });
});

test("the thumbnail goes only with a copy that carries the post's own media", async () => {
  const { sql, db, job, target } = fixture();
  const zh = { title: "标题", text: "正文", topics: [], video: "zh-video" };
  const translated = job(1, { kind: "video", zh });
  target(translated, "xiaohongshu", "https://www.xiaohongshu.com/explore/0123456789abcdef01234567");
  const linked = job(2);
  target(linked, "instagram", "https://www.instagram.com/p/abcde/", "linked");
  const own = job(3, { kind: "video", zh: { ...zh, video: undefined } });
  target(own, "xiaohongshu", "https://www.xiaohongshu.com/explore/0123456789abcdef01234568");
  for (const id of [translated, linked, own])
    sql.query("INSERT INTO publisher_thumbnails VALUES (?,?,?,?)").run(id, "image/png", new Uint8Array([1]), 1);
  expect((await postRecordSource(db, translated))?.thumbnail).toBeNull();
  expect((await postRecordSource(db, linked))?.thumbnail).toBeNull();
  expect((await postRecordSource(db, own))?.thumbnail).toMatchObject({ type: "image/png", size: 1 });
});

test("a link pasted by hand loses its share tracking, and its time is not a publish time", async () => {
  const { db, job, target } = fixture();
  const id = job(1);
  target(id, "instagram", "https://www.instagram.com/kualta/reel/Cabc123/?igsh=TRACKING", "marked");
  target(id, "youtube", "https://youtu.be/abcdefghijk?si=TRACKING", "marked");
  target(
    id,
    "xiaohongshu",
    "https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=TRACKING",
    "marked",
  );
  target(id, "tiktok", "https://vm.tiktok.com/ZMabc/?_t=TRACKING#TRACKING", "marked");
  target(id, "bluesky", `${bsky}?ref_src=TRACKING`, "marked");
  target(id, "twitter", "https://x.com/k/status/1?s=20", "sent");
  const source = await postRecordSource(db, id);
  expect(JSON.stringify(source)).not.toContain("TRACKING");
  expect(source?.targets).toEqual([
    { platform: "instagram", url: "https://www.instagram.com/reel/Cabc123/", published_at: null, deleted: false },
    { platform: "youtube", url: "https://www.youtube.com/watch?v=abcdefghijk", published_at: null, deleted: false },
    {
      platform: "xiaohongshu",
      url: "https://www.xiaohongshu.com/explore/0123456789abcdef01234567",
      published_at: null,
      deleted: false,
    },
    { platform: "tiktok", url: "https://vm.tiktok.com/ZMabc/", published_at: null, deleted: false },
    { platform: "bluesky", url: bsky, published_at: null, deleted: false },
    { platform: "twitter", url: "https://x.com/k/status/1", published_at: 5000, deleted: false },
  ]);
  // A copy marked by hand was sent from here, so its words count.
  expect(source?.post?.text).toBe("Caption");
});

test("pages walk every post once, newest first", async () => {
  const { db, job, target } = fixture();
  const ids = Array.from({ length: 23 }, (_, i) => job(1000 + Math.floor(i / 2)));
  target(ids[0], "grain", "https://grain.social/profile/did:plc:x/gallery/3k");
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
