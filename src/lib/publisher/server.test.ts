import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  addDestinations,
  linkPublication,
  unlinkPublication,
  markPublished,
  postMedia,
  postUploads,
  stopTarget,
  rescheduleTarget,
  STOPPED_BEFORE,
  targetActive,
  claimTarget,
  claimConnection,
  hashToken,
  validatePost,
} from "./server";
import { defaultMetadata } from "./presets";
import type { NewsletterDB } from "../newsletter/types";
const post = () => ({
  id: crypto.randomUUID(),
  kind: "photo",
  title: "A photo",
  caption: "Hello",
  alt: "A mountain",
  media: [crypto.randomUUID()],
  platforms: ["grain"],
  metadata: defaultMetadata(),
  visibility: "PRIVATE",
});
function database() {
  const sqlite = new Database(":memory:");
  for (const file of [
    "0002_publisher.sql",
    "0003_publisher_accounts.sql",
    "0005_publisher_deletions.sql",
    "0006_publisher_analytics.sql",
    "0008_publisher_target_finished.sql",
    "0009_publisher_reposts.sql",
    "0010_publisher_thumbnails.sql",
    "0011_publisher_schedule.sql",
  ])
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...v: unknown[]) {
          values = v;
          return statement;
        },
        async first() {
          return sqlite.query(sql).get(...(values as never[]));
        },
        async all() {
          return { results: sqlite.query(sql).all(...(values as never[])) };
        },
        async run() {
          return { meta: sqlite.query(sql).run(...(values as never[])) };
        },
      };
      return statement;
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      for (const statement of statements) await statement.run();
      return [];
    },
  } as unknown as NewsletterDB;
  return { db, sqlite };
}
test("rejects unsupported media, destinations and unsafe post parameters", () => {
  expect(validatePost(post()).title).toBe("A photo");
  expect(() => validatePost({ ...post(), kind: "video" })).toThrow("Grain needs photos");
  expect(() => validatePost({ ...post(), platforms: ["bogus"] })).toThrow("Unsupported");
  expect(() =>
    validatePost({
      ...post(),
      platforms: ["twitter"],
      caption: "x".repeat(281),
    }),
  ).toThrow("280");
  expect(() => validatePost({ ...post(), media: ["../../secret"] })).toThrow();
  expect(() => validatePost({ ...post(), metadata: {} })).toThrow();
});
test("text posts carry no media and reach only text destinations", () => {
  const text = { ...post(), kind: "text", title: "", media: [], platforms: ["bluesky", "twitter"], caption: "Hi" };
  expect(validatePost(text).title).toBe("");
  expect(() => validatePost({ ...text, caption: "  " })).toThrow("Write something");
  expect(() => validatePost({ ...text, media: [crypto.randomUUID()] })).toThrow("no media");
  expect(() => validatePost({ ...text, platforms: ["grain"] })).toThrow("Grain needs photos");
  expect(() => validatePost({ ...text, platforms: ["instagram"] })).toThrow("Instagram needs media");
  expect(() => validatePost({ ...text, caption: "x".repeat(281) })).toThrow("280");
});
test("destinations can be scheduled each for a time within the next week", () => {
  const text = { ...post(), kind: "text", title: "", media: [], platforms: ["bluesky", "twitter"], caption: "Hi" };
  const hour = 3_600_000;
  const at = Date.now() + hour;
  // Kept in the destinations' order, so a retry is the same post; one left out publishes at once.
  expect(validatePost({ ...text, schedule: { twitter: at + hour, bluesky: at } }).schedule).toEqual({
    bluesky: at,
    twitter: at + hour,
  });
  expect(JSON.stringify(validatePost({ ...text, schedule: { twitter: at } }).schedule)).toBe(`{"twitter":${at}}`);
  expect(validatePost(text)).not.toHaveProperty("schedule");
  for (const schedule of [
    { grain: at },
    { bluesky: at + 8 * 24 * hour },
    { bluesky: Date.now() - hour },
    { bluesky: at + 0.5 },
    { bluesky: String(at) },
    {},
    null,
  ])
    expect(() => validatePost({ ...text, schedule })).toThrow("within the next week");
});
test("titles are required only by destinations that publish them", () => {
  const photo = { ...post(), title: "", platforms: ["bluesky", "instagram"] };
  expect(validatePost(photo).title).toBe("");
  expect(() => validatePost({ ...photo, platforms: ["bluesky", "grain"] })).toThrow("title");
  const video = { ...post(), kind: "video", title: "", platforms: ["tiktok", "twitter"] };
  expect(validatePost(video).kind).toBe("video");
  expect(() => validatePost({ ...video, platforms: ["youtube"] })).toThrow("title");
  expect(() => validatePost({ ...video, media: [crypto.randomUUID(), crypto.randomUUID()] })).toThrow("one video");
});
test("photo posts take up to twenty photos, ten on Bluesky, four on X, with a description each", () => {
  const media = Array.from({ length: 20 }, () => crypto.randomUUID());
  const alts = media.map((_, i) => `Photo ${i}`);
  expect(validatePost({ ...post(), media, alts, platforms: ["instagram", "grain"] }).alts).toEqual(alts);
  expect(() => validatePost({ ...post(), media: [...media, crypto.randomUUID()] })).toThrow("1–20");
  expect(() => validatePost({ ...post(), media, platforms: ["bluesky"] })).toThrow("Bluesky takes up to 10 photos");
  const ten = media.slice(0, 10);
  expect(validatePost({ ...post(), media: ten, alts: alts.slice(0, 10), platforms: ["bluesky"] }).media).toEqual(ten);
  expect(() => validatePost({ ...post(), media: media.slice(0, 5), platforms: ["twitter"] })).toThrow(
    "X / Twitter takes up to 4 photos",
  );
  expect(() => validatePost({ ...post(), alts: ["one", "two"] })).toThrow("Describe each photo");
  expect(() => validatePost({ ...post(), kind: "video", platforms: ["youtube"], alts: [""] })).toThrow(
    "Describe each photo",
  );
});
test("pairing secrets are hashed deterministically", async () => {
  const token = "a".repeat(64);
  expect(await hashToken(token)).toHaveLength(64);
  expect(await hashToken(token)).not.toBe(token);
  expect(await hashToken(token)).toBe(await hashToken(token));
});
test("Grain text limits count UTF-8 bytes, including multibyte captions", () => {
  expect(
    validatePost({
      ...post(),
      title: "界".repeat(33),
      caption: "界".repeat(333),
    }).caption,
  ).toHaveLength(333);
  expect(() => validatePost({ ...post(), title: "界".repeat(34) })).toThrow("Grain: title (bytes) is 102/100");
  expect(() => validatePost({ ...post(), caption: "界".repeat(334) })).toThrow(
    "Grain: description (bytes) is 1002/1000",
  );
  expect(() => validatePost({ ...post(), caption: "a".repeat(1001) })).toThrow("Grain: description (bytes)");
});
test("each destination's version is rendered, checked and stored with the job", () => {
  const job = validatePost({
    ...post(),
    caption: "A long walk through Bogotá.",
    tags: ["bogota", "travel", "colombia", "streetphotography", "walk", "sunday"],
    short: "Bogotá walk",
    platforms: ["grain", "instagram", "twitter", "bluesky", "xiaohongshu"],
    zh: { title: "波哥大散步", text: "周末在波哥大散步。", topics: ["波哥大", "旅行"] },
  });
  expect(job.variants?.instagram?.text).toBe(
    "A long walk through Bogotá.\n\n#bogota #travel #colombia #streetphotography #walk",
  );
  expect(job.variants?.twitter?.text).toBe("Bogotá walk");
  expect(job.variants?.bluesky?.tags).toEqual(["bogota", "travel", "colombia", "streetphotography", "walk", "sunday"]);
  expect(job.variants?.xiaohongshu).toEqual({
    title: "波哥大散步",
    text: "周末在波哥大散步。",
    tags: ["波哥大", "旅行"],
  });
});
test("Xiaohongshu needs its Chinese version, and every version must fit its platform", () => {
  const rednote = { ...post(), platforms: ["xiaohongshu"] };
  expect(() => validatePost(rednote)).toThrow("Add the Chinese version");
  expect(() => validatePost({ ...rednote, zh: { title: "", text: "你好", topics: [] } })).toThrow(
    "Xiaohongshu: needs a Chinese title",
  );
  expect(() => validatePost({ ...rednote, zh: { title: "界".repeat(21), text: "", topics: [] } })).toThrow(
    "Xiaohongshu: title is 21/20",
  );
  expect(validatePost({ ...rednote, zh: { title: "a".repeat(40), text: "", topics: [] } }).zh?.title).toHaveLength(40);
  expect(() => validatePost({ ...post(), platforms: ["instagram"], caption: "#a #b #c #d #e #f" })).toThrow(
    "Instagram: takes up to 5 hashtags",
  );
  expect(() => validatePost({ ...post(), tags: ["not a tag"] })).toThrow("Tags");
});
test("a video post's Chinese version goes to Xiaohongshu alone", () => {
  const original = crypto.randomUUID();
  const chinese = crypto.randomUUID();
  const zh = { title: "短片", text: "正文", topics: ["短片"], video: chinese };
  const video = {
    ...post(),
    kind: "video",
    media: [original],
    platforms: ["xiaohongshu", "youtube"],
    zh,
  };
  const checked = validatePost(video);
  expect(checked.zh?.video).toBe(chinese);
  expect(checked.variants?.xiaohongshu?.video).toBe(chinese);
  expect(checked.variants?.youtube).not.toHaveProperty("video");
  expect(postMedia(checked)).toEqual([original, chinese]);
  expect(postMedia(validatePost({ ...video, zh: { ...zh, video: undefined } }))).toEqual([original]);
  const refused = "The Chinese version is a second video for a video post";
  expect(() => validatePost({ ...video, zh: { ...zh, video: "../secret" } })).toThrow(refused);
  expect(() => validatePost({ ...video, zh: { ...zh, video: original } })).toThrow(refused);
  expect(() => validatePost({ ...post(), platforms: ["instagram"], zh })).toThrow(refused);
});
test("a video post can choose its cover, with the Chinese video's own frame for Xiaohongshu", () => {
  const [original, chinese, cover, zhCover] = [1, 2, 3, 4].map(() => crypto.randomUUID());
  const zh = { title: "短片", text: "正文", topics: ["短片"], video: chinese, cover: zhCover };
  const video = { ...post(), kind: "video", media: [original], platforms: ["xiaohongshu", "youtube"], zh, cover };
  const checked = validatePost(video);
  expect(checked.cover).toBe(cover);
  expect(checked.variants?.xiaohongshu?.cover).toBe(zhCover);
  expect(checked.variants?.youtube).not.toHaveProperty("cover");
  expect(postUploads(checked)).toEqual([
    { id: original, kind: "video" },
    { id: chinese, kind: "video" },
    { id: cover, kind: "photo" },
    { id: zhCover, kind: "photo" },
  ]);
  const refused = "A cover is one image for a video post";
  expect(() => validatePost({ ...post(), cover })).toThrow(refused);
  expect(() => validatePost({ ...video, cover: original })).toThrow(refused);
  expect(() => validatePost({ ...video, cover: "../secret" })).toThrow(refused);
  const chineseRefused = "The Chinese cover is a frame of the Chinese video";
  expect(() => validatePost({ ...video, cover: undefined })).toThrow(chineseRefused);
  expect(() => validatePost({ ...video, zh: { ...zh, cover } })).toThrow(chineseRefused);
  expect(() => validatePost({ ...video, zh: { ...zh, video: undefined } })).toThrow(chineseRefused);
});
test("a post can name a place, trimmed and kept short", () => {
  expect(validatePost({ ...post(), location: "  Bogotá, Colombia " }).location).toBe("Bogotá, Colombia");
  expect(validatePost({ ...post(), location: "  " })).not.toHaveProperty("location");
  expect(() => validatePost({ ...post(), location: "a".repeat(101) })).toThrow("location");
  expect(() => validatePost({ ...post(), location: 5 })).toThrow("location");
  const zh = { title: "短片", text: "正文", topics: [], location: " 波哥大 " };
  const rednote = validatePost({ ...post(), platforms: ["xiaohongshu", "instagram"], location: "Bogotá", zh });
  expect(rednote.zh?.location).toBe("波哥大");
  expect(rednote.variants?.xiaohongshu?.location).toBe("波哥大");
  expect(rednote.variants?.instagram).not.toHaveProperty("location");
  expect(() =>
    validatePost({ ...post(), platforms: ["xiaohongshu"], zh: { ...zh, location: "a".repeat(101) } }),
  ).toThrow("location");
});
describe("queue", () => {
  test("a destination waiting to publish can move, and one stopped before publishing can be scheduled again", async () => {
    const { db, sqlite } = database();
    const hour = 3_600_000;
    const day = 24 * hour;
    // The post's video went up two days ago, so its uploads last five more days.
    sqlite
      .query("INSERT INTO publisher_media (id, kind, name, job_id, created_at) VALUES ('m', 'video', 'v', 'job', ?)")
      .run(Date.now() - 2 * day);
    const target = (id: string, state: string, message: string | null = null) =>
      sqlite
        .query(
          "INSERT INTO publisher_targets (id, job_id, platform, state, message, scheduled_at) VALUES (?, 'job', 'tiktok', ?, ?, ?)",
        )
        .run(id, state, message, Date.now() + day);
    target("waiting", "queued");
    target("stopped", "failed", STOPPED_BEFORE);
    target("failed", "failed", "Upload rejected");
    target("working", "working");
    target("done", "succeeded");
    const later = Date.now() + 3 * day;
    expect(await rescheduleTarget(db, "job", "waiting", later)).toBe(true);
    expect(await rescheduleTarget(db, "job", "stopped", later)).toBe(true);
    const rows = sqlite
      .query(
        "SELECT id, state, scheduled_at, message FROM publisher_targets WHERE id IN ('waiting','stopped') ORDER BY rowid",
      )
      .all();
    expect(rows).toEqual([
      { id: "waiting", state: "queued", scheduled_at: later, message: null },
      { id: "stopped", state: "queued", scheduled_at: later, message: null },
    ]);
    // A real failure may have reached the platform, and the others are publishing or done.
    for (const id of ["failed", "working", "done"]) expect(await rescheduleTarget(db, "job", id, later)).toBe(false);
    expect(await rescheduleTarget(db, "other", "waiting", later)).toBe(false);
    // Not after the uploads expire, nor outside the next week, nor anything but a time.
    await expect(rescheduleTarget(db, "job", "waiting", Date.now() + 5 * day + hour)).rejects.toThrow("expire");
    await expect(rescheduleTarget(db, "job", "waiting", Date.now() - day)).rejects.toThrow("within the next week");
    await expect(rescheduleTarget(db, "job", "waiting", String(later))).rejects.toThrow("within the next week");
    // Stopped, it says so; moved, it waits for the new time.
    await stopTarget(db, "job", "waiting");
    expect(sqlite.query("SELECT message FROM publisher_targets WHERE id='waiting'").get()).toEqual({
      message: STOPPED_BEFORE,
    });
    sqlite.close();
  });
  test("a scheduled destination waits for its time", async () => {
    const { db, sqlite } = database();
    const later = Date.now() + 3_600_000;
    sqlite
      .query("INSERT INTO publisher_targets (id, job_id, platform, scheduled_at) VALUES (?, 'job', 'grain', ?)")
      .run("later", later);
    sqlite.exec("INSERT INTO publisher_targets (id, job_id, platform) VALUES ('now', 'job', 'grain')");
    expect((await claimTarget(db, ["grain"]))?.id).toBe("now");
    expect(await claimTarget(db, ["grain"])).toBeNull();
    sqlite.query("UPDATE publisher_targets SET scheduled_at = ? WHERE id = 'later'").run(Date.now() - 1);
    expect((await claimTarget(db, ["grain"]))?.id).toBe("later");
    sqlite.close();
  });
  test("claims each target once, only for configured platforms", async () => {
    const { db, sqlite } = database();
    sqlite.exec(
      "INSERT INTO publisher_targets (id, job_id, platform) VALUES ('a', 'job', 'grain'), ('b', 'job', 'twitter')",
    );
    expect((await claimTarget(db, ["grain"]))?.id).toBe("a");
    expect(await claimTarget(db, ["grain"])).toBeNull();
    expect((await claimTarget(db, ["twitter"]))?.id).toBe("b");
    sqlite.close();
  });
  test("photos for TikTok and YouTube and mixed posts for Farcaster and Lens wait for a helper that knows them", async () => {
    const { db, sqlite } = database();
    const job = (kind: string) => {
      const id = crypto.randomUUID();
      sqlite
        .query("INSERT INTO publisher_jobs (id, payload, created_at) VALUES (?, ?, 1)")
        .run(id, JSON.stringify({ kind }));
      return id;
    };
    const photos = job("photo");
    const mixed = job("mixed");
    const video = job("video");
    const target = sqlite.query("INSERT INTO publisher_targets (id, job_id, platform) VALUES (?, ?, ?)");
    target.run("tiktok-photos", photos, "tiktok");
    target.run("youtube-photos", photos, "youtube");
    target.run("lens-mixed", mixed, "lens");
    target.run("farcaster-mixed", mixed, "farcaster");
    target.run("tiktok-video", video, "tiktok");
    target.run("instagram-mixed", mixed, "instagram");
    const all = ["tiktok", "youtube", "lens", "farcaster", "instagram"] as const;
    // An older helper would post the photos as videos and the mixed posts as text.
    expect((await claimTarget(db, [...all]))?.id).toBe("tiktok-video");
    expect((await claimTarget(db, [...all]))?.id).toBe("instagram-mixed");
    expect(await claimTarget(db, [...all])).toBeNull();
    const claimed = [];
    for (let i = 0; i < 4; i++) claimed.push((await claimTarget(db, [...all], { carousels: true }))?.id);
    expect(claimed).toEqual(["tiktok-photos", "youtube-photos", "lens-mixed", "farcaster-mixed"]);
    sqlite.close();
  });
  test("expired work becomes uncertain and is never automatically reposted", async () => {
    const { db, sqlite } = database();
    sqlite.exec(
      "INSERT INTO publisher_targets (id, job_id, platform, state, started_at) VALUES ('a', 'job', 'grain', 'working', 1)",
    );
    expect(await claimTarget(db, ["grain"])).toBeNull();
    expect(sqlite.query("SELECT state FROM publisher_targets").get()).toEqual({
      state: "uncertain",
    });
    sqlite.close();
  });
  test("a media upload cannot be assigned to two posts", () => {
    const { sqlite } = database();
    sqlite.exec("INSERT INTO publisher_media VALUES ('media', 'photo', 'photo', 1, 'job')");
    expect(() => sqlite.exec("UPDATE publisher_media SET job_id = 'other'")).toThrow();
    sqlite.close();
  });
});

test("account connection claims are exclusive and expiry discards encrypted credentials", async () => {
  const { db, sqlite } = database();
  sqlite
    .query("INSERT INTO publisher_connections(id,platform,action,payload,created_at) VALUES(?,?,?,?,?)")
    .run("one", "grain", "connect", "encrypted", Date.now());
  expect((await claimConnection(db))?.id).toBe("one");
  expect(await claimConnection(db)).toBeNull();
  expect(() =>
    sqlite.exec(
      "INSERT INTO publisher_connections(id,platform,action,created_at) VALUES('two','instagram','connect',0)",
    ),
  ).toThrow();
  sqlite.exec("UPDATE publisher_connections SET created_at=0 WHERE id='one'");
  expect(await claimConnection(db)).toBeNull();
  expect(sqlite.query("SELECT state,payload FROM publisher_connections WHERE id='one'").get()).toEqual({
    state: "failed",
    payload: null,
  });
  sqlite.close();
});

test("validates optional capture dates without accepting mismatched or invalid dates", () => {
  expect(validatePost({ ...post(), datesTaken: ["2020-07-18T06:30:10.000Z"] }).datesTaken).toEqual([
    "2020-07-18T06:30:10.000Z",
  ]);
  expect(validatePost({ ...post(), datesTaken: [null] }).datesTaken).toEqual([null]);
  for (const datesTaken of [[], ["2020-02-30T00:00:00.000Z"], ["yesterday"], ["2020-01-01"], [123]])
    expect(() => validatePost({ ...post(), datesTaken })).toThrow("date taken");
});
test("a video goes in a carousel only when the owner chose to post it as one", () => {
  const media = [crypto.randomUUID(), crypto.randomUUID()];
  const mixed = { ...post(), kind: "mixed", media, mediaKinds: ["video", "photo"], platforms: ["instagram"] };
  expect(() => validatePost(mixed)).toThrow("Choose Post as one carousel");
  expect(() => validatePost({ ...mixed, carousel: false })).toThrow("Choose Post as one carousel");
  expect(() => validatePost({ ...mixed, carousel: "yes" })).toThrow("Choose Post as one carousel");
  expect(validatePost({ ...mixed, carousel: true }).carousel).toBe(true);
  // A Reel, a photo carousel or a text post can't claim to be one.
  const video = { ...post(), kind: "video", title: "", platforms: ["instagram"] };
  expect(() => validatePost({ ...video, carousel: true })).toThrow("Only a video sent with other media");
  expect(() => validatePost({ ...post(), carousel: true })).toThrow("Only a video sent with other media");
  expect(validatePost(video)).not.toHaveProperty("carousel");
  // Farcaster and Lens now take one too.
  const both = validatePost({ ...mixed, carousel: true, platforms: ["farcaster", "lens", "twitter"] });
  expect(both.platforms).toEqual(["farcaster", "lens", "twitter"]);
});
test("photos go to YouTube as a public post without a title, and to TikTok as a photo post", () => {
  const photos = { ...post(), title: "", media: [crypto.randomUUID(), crypto.randomUUID()], alts: undefined };
  expect(() => validatePost({ ...photos, platforms: ["youtube"] })).toThrow("set YouTube visibility to Public");
  expect(() => validatePost({ ...photos, platforms: ["youtube"], visibility: "UNLISTED" })).toThrow("Public");
  const job = validatePost({ ...photos, platforms: ["youtube", "tiktok"], visibility: "PUBLIC" });
  expect(job.platforms).toEqual(["youtube", "tiktok"]);
  expect(job.variants?.youtube?.title).toBe("");
  // TikTok photos keep whatever visibility YouTube's videos use.
  expect(validatePost({ ...photos, platforms: ["tiktok"] }).visibility).toBe("PRIVATE");
  const eleven = Array.from({ length: 11 }, () => crypto.randomUUID());
  expect(() => validatePost({ ...photos, media: eleven, platforms: ["youtube"], visibility: "PUBLIC" })).toThrow(
    "YouTube takes up to 10 photos",
  );
});
test("mixed posts say what each item is and include a video", () => {
  const media = [crypto.randomUUID(), crypto.randomUUID()];
  const mixed = { ...post(), kind: "mixed", media, platforms: ["instagram", "twitter"], carousel: true };
  expect(validatePost({ ...mixed, mediaKinds: ["photo", "video"] }).mediaKinds).toEqual(["photo", "video"]);
  expect(() => validatePost(mixed)).toThrow("Mix photos with at least one video");
  expect(() => validatePost({ ...mixed, mediaKinds: ["photo", "photo"] })).toThrow("at least one video");
  expect(() => validatePost({ ...mixed, mediaKinds: ["video"] })).toThrow("at least one video");
  expect(() => validatePost({ ...post(), mediaKinds: ["photo"] })).toThrow("at least one video");
  expect(() => validatePost({ ...mixed, mediaKinds: ["photo", "video"], platforms: ["bluesky"] })).toThrow(
    "Bluesky takes photos or one video",
  );
});
test("only a video going to YouTube can ask to be a Short, and a post that doesn't ask is unchanged", () => {
  const video = { ...post(), kind: "video", platforms: ["youtube", "tiktok"] };
  expect(validatePost({ ...video, youtubeShort: true }).youtubeShort).toBe(true);
  expect(validatePost(video)).not.toHaveProperty("youtubeShort");
  expect(validatePost({ ...video, youtubeShort: false })).not.toHaveProperty("youtubeShort");
  for (const youtubeShort of [1, "true", null])
    expect(() => validatePost({ ...video, youtubeShort })).toThrow("as a Short");
  expect(() => validatePost({ ...video, platforms: ["tiktok"], youtubeShort: true })).toThrow("as a Short");
  expect(() => validatePost({ ...post(), youtubeShort: true })).toThrow("as a Short");
  expect(() => validatePost({ ...post(), youtubeShort: false })).toThrow("as a Short");
  const media = [crypto.randomUUID(), crypto.randomUUID()];
  expect(() =>
    validatePost({
      ...post(),
      kind: "mixed",
      media,
      mediaKinds: ["photo", "video"],
      platforms: ["instagram"],
      carousel: true,
      youtubeShort: true,
    }),
  ).toThrow("as a Short");
});
function published(job: ReturnType<typeof validatePost>) {
  const { db, sqlite } = database();
  sqlite
    .query("INSERT INTO publisher_jobs (id, payload, created_at) VALUES (?, ?, ?)")
    .run(job.id, JSON.stringify(job), 1);
  for (const platform of job.platforms)
    sqlite
      .query("INSERT INTO publisher_targets (id, job_id, platform, state) VALUES (?, ?, ?, 'succeeded')")
      .run(crypto.randomUUID(), job.id, platform);
  const payload = () =>
    JSON.parse((sqlite.query("SELECT payload FROM publisher_jobs").get() as { payload: string }).payload);
  return { db, sqlite, payload };
}
test("a published post can go to more destinations, rendered and checked like a new one", async () => {
  const job = validatePost({ ...post(), kind: "text", title: "", media: [], caption: "Hello", platforms: ["bluesky"] });
  const { db, sqlite, payload } = published(job);
  const bucket = { head: async () => ({}) };
  expect(await addDestinations(db, bucket, { job: job.id, platforms: ["twitter", "bluesky"] })).toEqual(["twitter"]);
  expect(payload().platforms).toEqual(["bluesky", "twitter"]);
  expect(payload().variants.twitter.text).toBe("Hello");
  expect(sqlite.query("SELECT state FROM publisher_targets WHERE platform = 'twitter'").get()).toEqual({
    state: "queued",
  });
  await expect(addDestinations(db, bucket, { job: job.id, platforms: ["twitter"] })).rejects.toThrow("Choose where");
});
test("a mixed post from before the carousel choice can still be crossposted, as the carousel it was", async () => {
  const media = [crypto.randomUUID(), crypto.randomUUID()];
  const { carousel, ...legacy } = validatePost({
    ...post(),
    kind: "mixed",
    media,
    mediaKinds: ["photo", "video"],
    platforms: ["instagram"],
    carousel: true,
  });
  expect(carousel).toBe(true);
  const { db, payload } = published(legacy as ReturnType<typeof validatePost>);
  await addDestinations(db, { head: async () => ({}) }, { job: legacy.id, platforms: ["lens"] });
  expect(payload().platforms).toEqual(["instagram", "lens"]);
  expect(payload().carousel).toBe(true);
});
test("crossposting keeps a Short a Short, and doesn't make a regular video one", async () => {
  const video = { ...post(), kind: "video" };
  const kept = { head: async () => ({}) };
  const short = validatePost({ ...video, platforms: ["youtube"], youtubeShort: true });
  const first = published(short);
  await addDestinations(first.db, kept, { job: short.id, platforms: ["tiktok"] });
  expect(first.payload().youtubeShort).toBe(true);
  const regular = validatePost({ ...video, platforms: ["tiktok"] });
  const second = published(regular);
  await addDestinations(second.db, kept, { job: regular.id, platforms: ["youtube"] });
  expect(second.payload().youtubeShort).toBeUndefined();
});
test("crossposting asks for what new destinations need, and for media that still exists", async () => {
  const job = validatePost({ ...post(), title: "", platforms: ["instagram"] });
  const { db, payload } = published(job);
  const kept = { head: async () => ({}) };
  await expect(addDestinations(db, kept, { job: job.id, platforms: ["xiaohongshu"] })).rejects.toThrow(
    "Add the Chinese version",
  );
  await expect(addDestinations(db, kept, { job: job.id, platforms: ["grain"] })).rejects.toThrow("Add a title");
  await expect(
    addDestinations(db, { head: async () => null }, { job: job.id, platforms: ["grain"], title: "Walk" }),
  ).rejects.toThrow("media has expired");
  expect(payload().platforms).toEqual(["instagram"]);
  const zh = { title: "散步", text: "周末散步。", topics: ["旅行"] };
  await addDestinations(db, kept, { job: job.id, platforms: ["grain", "xiaohongshu"], title: "Walk", zh });
  expect(payload().title).toBe("Walk");
  expect(payload().variants.xiaohongshu.title).toBe("散步");
});
test("a post from before Farcaster and Lens existed can still be crossposted to them", async () => {
  const job = validatePost({ ...post(), kind: "text", title: "", media: [], platforms: ["bluesky"], caption: "Hi" });
  const older = {
    ...job,
    metadata: Object.fromEntries(Object.entries(job.metadata).filter(([p]) => !["farcaster", "lens"].includes(p))),
  } as typeof job;
  const { db, payload } = published(older);
  expect(
    await addDestinations(db, { head: async () => ({}) }, { job: job.id, platforms: ["farcaster", "lens"] }),
  ).toEqual(["farcaster", "lens"]);
  expect(payload().variants.farcaster.text).toBe("Hi");
  expect(payload().metadata.lens).toBe("remove-all");
  expect(payload().metadata.bluesky).toBe(job.metadata.bluesky);
});
test("stopping releases a target at once, and only a retry takes its claim away", async () => {
  const { db, sqlite } = database();
  const job = crypto.randomUUID();
  sqlite.query("INSERT INTO publisher_jobs (id, payload, created_at) VALUES (?, '{}', 1)").run(job);
  const claim = crypto.randomUUID();
  const add = sqlite.query("INSERT INTO publisher_targets (id, job_id, platform, state, claim) VALUES (?, ?, ?, ?, ?)");
  add.run("working", job, "tiktok", "working", claim);
  add.run("waiting", job, "instagram", "queued", null);
  add.run("done", job, "youtube", "succeeded", null);
  const target = (id: string) =>
    sqlite.query("SELECT state, claim, message FROM publisher_targets WHERE id = ?").get(id) as {
      state: string;
      claim: string | null;
      message: string;
    };
  expect(await targetActive(db, "working", claim)).toBe(true);

  expect(await stopTarget(db, crypto.randomUUID(), "working")).toBe(false);
  expect(await stopTarget(db, job, "working")).toBe(true);
  expect(target("working").state).toBe("uncertain");
  expect(target("working").message).toContain("Check the destination");
  expect(target("working").claim).toBe(claim);
  expect(await targetActive(db, "working", claim)).toBe(false);

  expect(await stopTarget(db, job, "waiting")).toBe(true);
  expect(target("waiting").state).toBe("failed");
  expect(target("waiting").message).toBe("Stopped before publishing.");

  // Finished or already stopped targets stay as they are.
  expect(await stopTarget(db, job, "done")).toBe(false);
  expect(target("done").state).toBe("succeeded");
  expect(await stopTarget(db, job, "working")).toBe(false);
});
test("only a destination waiting to be checked can be marked as published", async () => {
  const { db, sqlite } = database();
  const job = crypto.randomUUID();
  sqlite.query("INSERT INTO publisher_jobs (id, payload, created_at) VALUES (?, '{}', 1)").run(job);
  const add = sqlite.query(
    "INSERT INTO publisher_targets (id, job_id, platform, state, message) VALUES (?, ?, ?, ?, 'Check it')",
  );
  add.run("checking", job, "instagram", "uncertain");
  add.run("publishing", job, "tiktok", "working");
  const url = "https://www.instagram.com/reel/abc/";
  expect(await markPublished(db, job, "checking", url)).toBe(true);
  expect(sqlite.query("SELECT state, url, message FROM publisher_targets WHERE id = 'checking'").get()).toEqual({
    state: "succeeded",
    url,
    message: null,
  });
  expect(await markPublished(db, job, "publishing", url)).toBe(false);
  expect(await markPublished(db, job, "checking", url)).toBe(false);
});
/** A video that went out to TikTok and YouTube through the helper, before TikTok's sign-in changed at `signedIn`. */
function reposted(signedIn: number | null) {
  const job = validatePost({ ...post(), kind: "video", platforms: ["tiktok", "youtube"] });
  const { db, sqlite, payload } = published(job);
  sqlite
    .query(
      "UPDATE publisher_targets SET url = 'https://www.tiktok.com/@_/video/7702543685921066262', finished_at = 10 WHERE platform = 'tiktok'",
    )
    .run();
  sqlite
    .query(
      "UPDATE publisher_targets SET url = 'https://www.youtube.com/shorts/-rUzAfPDlRQ', finished_at = 10 WHERE platform = 'youtube'",
    )
    .run();
  if (signedIn !== null)
    sqlite
      .query(
        "INSERT INTO publisher_connections (id, platform, action, state, created_at) VALUES (?, 'tiktok', 'disconnect', 'succeeded', ?)",
      )
      .run(crypto.randomUUID(), signedIn);
  const targets = () =>
    sqlite.query("SELECT platform, state, url, linked FROM publisher_targets ORDER BY rowid").all() as {
      platform: string;
      state: string;
      url: string | null;
      linked: number;
    }[];
  return { job, db, sqlite, payload, targets };
}
test("a platform reached only under an earlier sign-in can take the post again, once", async () => {
  const kept = { head: async () => ({}) };
  const before = reposted(5);
  await expect(addDestinations(before.db, kept, { job: before.job.id, platforms: ["tiktok"] })).rejects.toThrow(
    "Choose where",
  );
  const { job, db, payload, targets } = reposted(20);
  expect(await addDestinations(db, kept, { job: job.id, platforms: ["tiktok", "youtube"] })).toEqual(["tiktok"]);
  expect(payload().platforms).toEqual(["tiktok", "youtube"]);
  expect(
    targets()
      .filter((t) => t.platform === "tiktok")
      .map((t) => t.state),
  ).toEqual(["succeeded", "queued"]);
  // The repost waiting to go out is on the account connected now.
  await expect(addDestinations(db, kept, { job: job.id, platforms: ["tiktok"] })).rejects.toThrow("Choose where");
});
test("a post published by hand links to a post in History once, and its stats start being read", async () => {
  const { job, db, sqlite, targets } = reposted(20);
  await expect(
    linkPublication(db, { job: job.id, url: "https://www.tiktok.com/@kualtq/video/7702543685921066262?lang=en" }),
  ).rejects.toThrow("already in “A photo”");
  await expect(linkPublication(db, { job: job.id, url: "https://vm.tiktok.com/ZMabc/" })).rejects.toThrow(
    "copy the link from its page",
  );
  await expect(linkPublication(db, { job: crypto.randomUUID(), url: "https://youtu.be/dQw4w9WgXcQ" })).rejects.toThrow(
    "Invalid post",
  );
  const linked = await linkPublication(db, {
    job: job.id,
    url: "https://www.tiktok.com/@kualtq/video/7710000000000000001?is_from_webapp=1",
  });
  expect(linked.platform).toBe("tiktok");
  expect(targets().at(-1)).toEqual({
    platform: "tiktok",
    state: "succeeded",
    url: "https://www.tiktok.com/@kualtq/video/7710000000000000001",
    linked: 1,
  });
  expect(sqlite.query("SELECT next_at FROM publisher_metric_checks WHERE target_id = ?").get(linked.id)).toEqual({
    next_at: 0,
  });
  // A linked repost is on the account in use, so the post doesn't offer to go out there again.
  await expect(addDestinations(db, { head: async () => ({}) }, { job: job.id, platforms: ["tiktok"] })).rejects.toThrow(
    "Choose where",
  );
});
test("unlinking takes a linked post and its stats out, and leaves published ones alone", async () => {
  const { job, db, sqlite, targets } = reposted(20);
  const { id } = await linkPublication(db, { job: job.id, url: "https://www.instagram.com/kualta/reel/DfDQW2Ry8cO/" });
  expect(targets().at(-1)?.url).toBe("https://www.instagram.com/reel/DfDQW2Ry8cO/");
  sqlite.query("INSERT INTO publisher_metric_snapshots VALUES (?, 1, '{\"views\":3}')").run(id);
  const original = (sqlite.query("SELECT id FROM publisher_targets WHERE linked = 0 LIMIT 1").get() as { id: string })
    .id;
  expect(await unlinkPublication(db, job.id, original)).toBe(false);
  expect(await unlinkPublication(db, crypto.randomUUID(), id)).toBe(false);
  expect(await unlinkPublication(db, job.id, id)).toBe(true);
  expect(targets().map((t) => t.platform)).toEqual(["tiktok", "youtube"]);
  expect(sqlite.query("SELECT COUNT(*) AS n FROM publisher_metric_snapshots").get()).toEqual({ n: 0 });
  expect(sqlite.query("SELECT COUNT(*) AS n FROM publisher_metric_checks WHERE target_id = ?").get(id)).toEqual({
    n: 0,
  });
});
