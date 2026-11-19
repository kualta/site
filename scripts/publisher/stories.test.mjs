import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordKey } from "../lib/atproto-content.mjs";
import {
  archiveStories,
  clockTime,
  crosspostStories,
  dateTags,
  pinkleapTags,
  postedAt,
  storyMedia,
} from "./stories.mjs";

test("a story is dated on the clock of the phone that posted it", () => {
  // 2026-11-15 03:30:00 UTC is still the evening of the 14th in Bogotá, and the morning of the 15th in Mumbai.
  expect(postedAt({ taken_at: 1794713400, timezone_offset: -18000 })).toEqual({
    date: "2026-11-14",
    time: "22:30:00",
    zone: "-05:00",
  });
  expect(postedAt({ taken_at: 1794713400, timezone_offset: 19800 })).toEqual({
    date: "2026-11-15",
    time: "09:00:00",
    zone: "+05:30",
  });
  expect(dateTags(postedAt({ taken_at: 1794713400, timezone_offset: -18000 }), "mp4")).toContain(
    "-Keys:CreationDate=2026:11:14 22:30:00-05:00",
  );
  expect(dateTags(postedAt({ taken_at: 1794713400, timezone_offset: -18000 }), "jpg")).toEqual(
    expect.arrayContaining(["-DateTimeOriginal=2026:11:14 22:30:00", "-OffsetTimeOriginal=-05:00"]),
  );
});

test("a story keeps its largest rendition, and photo stories stay photos", () => {
  const video = {
    media_type: 2,
    video_versions: [
      { width: 480, height: 854, url: "https://cdn/small.mp4" },
      { width: 720, height: 1280, url: "https://cdn/large.mp4" },
    ],
  };
  expect(storyMedia(video)).toEqual({ url: "https://cdn/large.mp4", ext: "mp4" });
  const photo = {
    media_type: 1,
    image_versions2: { candidates: [{ width: 1179, height: 2096, url: "https://cdn/p.jpg" }] },
  };
  expect(storyMedia(photo)).toEqual({ url: "https://cdn/p.jpg", ext: "jpg" });
  expect(storyMedia({ media_type: 2, video_versions: [] })).toBeNull();
});

const story = (id, taken_at, extra = {}) => ({
  id: `${id}_17841420014081915`,
  pk: Number(id),
  taken_at,
  timezone_offset: -18000,
  media_type: 2,
  video_versions: [{ width: 720, height: 1280, url: `https://cdn.example/${id}.mp4` }],
  ...extra,
});
const reply = (path, data, guard = false) => ({
  url: () => `https://www.instagram.com${path}`,
  ok: () => true,
  text: async () => `${guard ? "for (;;);" : ""}${JSON.stringify(guard ? { payload: data } : data)}`,
});
/** An archive page that answers its first load with the given replies, then one batch per scroll. */
function archive(batches, { url = "https://www.instagram.com/archive/stories/" } = {}) {
  const seen = { scrolls: 0, closed: false };
  let listener;
  const deliver = (batch = []) => Promise.all(batch.map((r) => listener(r)));
  const page = {
    on: (event, fn) => event === "response" && (listener = fn),
    goto: async () => deliver(batches.shift()),
    url: () => url,
    waitForTimeout: async () => {},
    mouse: { wheel: async () => (seen.scrolls++, deliver(batches.shift())) },
  };
  return { seen, open: async () => ({ pages: () => [page], close: async () => (seen.closed = true) }) };
}

test("the archive is saved by posting date, once, with the song noted", async () => {
  const root = await mkdtemp(join(tmpdir(), "stories-"));
  const music = { music_asset_info: { title: "Riders on the Storm", display_artist: "The Doors" } };
  const newest = [
    story("4030127951811103297", 1794713400, { story_music_stickers: [music] }),
    story("4030127951811103298", 1794713400),
  ];
  const older = [
    story("3986126615415459488", 1789387200, {
      media_type: 1,
      image_versions2: { candidates: [{ width: 1179, height: 2096, url: "https://cdn.example/photo.jpg" }] },
    }),
  ];
  const shells = reply(
    "/api/v1/archive/reel/day_shells/?timezone_offset=-18000",
    {
      items: [
        { id: "archiveDay:2", media_count: 2, latest_reel_media: 1794713400 },
        { id: "archiveDay:1", media_count: 1, latest_reel_media: 1789387200 },
      ],
      more_available: false,
    },
    true,
  );
  const tagged = [];
  const downloads = [];
  const options = {
    stateDir: "/state",
    root,
    tag: async (args) => tagged.push(args),
    fetcher: async (url, init) => {
      downloads.push(url);
      expect(init.headers.Referer).toBe("https://www.instagram.com/");
      return new Response(`bytes of ${url}`);
    },
    log: () => {},
  };
  // The page shows the newest day first and loads the older one on scrolling.
  const first = archive([
    [shells, reply("/api/v1/feed/reels_media/", { reels: { "archiveDay:2": { id: "archiveDay:2", items: newest } } })],
    [reply("/api/v1/feed/reels_media/", { reels: { "archiveDay:1": { id: "archiveDay:1", items: older } } })],
  ]);
  expect(await archiveStories({ ...options, open: first.open })).toEqual({ saved: 3, removed: 0, total: 3 });
  expect(first.seen).toEqual({ scrolls: 1, closed: true });
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  expect(index.stories).toEqual([
    {
      id: "3986126615415459488",
      day: "archiveDay:1",
      posted: "2026-09-14T07:00:00-05:00",
      file: "2026/09/2026-09-14 07.00.00.jpg",
    },
    {
      id: "4030127951811103297",
      day: "archiveDay:2",
      posted: "2026-11-14T22:30:00-05:00",
      file: "2026/11/2026-11-14 22.30.00.mp4",
      song: "Riders on the Storm",
      artist: "The Doors",
    },
    {
      id: "4030127951811103298",
      day: "archiveDay:2",
      posted: "2026-11-14T22:30:00-05:00",
      file: "2026/11/2026-11-14 22.30.00 (2).mp4",
    },
  ]);
  // a day is known by its count and its latest story
  expect(index.days).toEqual({ "archiveDay:2": "2/1794713400", "archiveDay:1": "1/1789387200" });
  const saved = join(root, "2026/11/2026-11-14 22.30.00.mp4");
  expect(await readFile(saved, "utf8")).toBe("bytes of https://cdn.example/4030127951811103297.mp4");
  expect((await stat(saved)).mtimeMs).toBe(1794713400 * 1000);
  expect(tagged[0]).toContain("-Keys:CreationDate=2026:11:14 22:30:00-05:00");
  expect(tagged[2]).toContain("-OffsetTimeOriginal=-05:00");

  // Finished days aren't fetched again: the next run neither scrolls nor downloads.
  downloads.length = 0;
  const again = archive([[shells]]);
  expect(await archiveStories({ ...options, open: again.open })).toEqual({ saved: 0, removed: 0, total: 3 });
  expect(again.seen.scrolls).toBe(0);
  expect(downloads).toEqual([]);
});

test("a story that fails to download is tried again on the next run", async () => {
  const root = await mkdtemp(join(tmpdir(), "stories-"));
  const items = [story("1", 1794713400), story("2", 1794713460)];
  const replies = () => [
    reply("/api/v1/archive/reel/day_shells/", {
      items: [{ id: "archiveDay:9", media_count: 2 }],
      more_available: false,
    }),
    reply("/api/v1/feed/reels_media/", { reels: { "archiveDay:9": { id: "archiveDay:9", items } } }),
  ];
  const logged = [];
  const options = { stateDir: "/state", root, tag: async () => {}, log: (line) => logged.push(line) };
  const flaky = async (url) => (url.endsWith("/2.mp4") ? new Response("", { status: 403 }) : new Response("ok"));
  expect(await archiveStories({ ...options, open: archive([replies()]).open, fetcher: flaky })).toEqual({
    saved: 1,
    removed: 0,
    total: 1,
  });
  expect(logged).toEqual(["Story 2 not saved: download failed (403)"]);
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  expect(index.days).toEqual({});
  const fetched = [];
  const fixed = async (url) => (fetched.push(url), new Response("ok"));
  expect(await archiveStories({ ...options, open: archive([replies()]).open, fetcher: fixed })).toEqual({
    saved: 1,
    removed: 0,
    total: 2,
  });
  expect(fetched).toEqual(["https://cdn.example/2.mp4"]);
});

test("a signed-out profile is an error, not an empty archive", async () => {
  const signedOut = archive([[]], { url: "https://www.instagram.com/accounts/login/?next=/archive/stories/" });
  const root = await mkdtemp(join(tmpdir(), "stories-"));
  await expect(archiveStories({ stateDir: "/state", root, open: signedOut.open })).rejects.toThrow(
    "Log in to Instagram",
  );
  expect(signedOut.seen.closed).toBe(true);
});

test("a time is written on another clock the way AT Protocol dates are", () => {
  const now = Date.parse("2026-11-16T14:31:20.880Z");
  expect(clockTime(now, "-05:00")).toBe("2026-11-16T09:31:20.880-05:00");
  expect(clockTime(now, "+05:30")).toBe("2026-11-16T20:01:20.880+05:30");
  expect(clockTime(now, "")).toBe("2026-11-16T14:31:20.880Z");
  expect(Date.parse(clockTime(now, "-05:00"))).toBe(now);
});

/** A stories folder whose index lists these stories, each with a file. */
async function savedStories(stories) {
  const root = await mkdtemp(join(tmpdir(), "stories-"));
  for (const story of stories) {
    await mkdir(join(root, story.file, ".."), { recursive: true });
    await writeFile(join(root, story.file), `bytes of ${story.id}`);
  }
  await writeFile(join(root, "index.json"), JSON.stringify({ days: {}, stories }));
  return root;
}
const pds = { agent: { did: "did:plc:jhvnnnd3adml7t6anu3ay7ip" }, pdsUrl: new URL("https://pds.example") };

test("every story goes to Pinkleap once, those still up first, each dated when it went up on Instagram", async () => {
  const now = Date.parse("2026-11-16T14:00:00Z");
  const root = await savedStories([
    { id: "3", posted: "2026-11-16T08:00:00-05:00", file: "2026/11/2026-11-16 08.00.00.mp4" },
    { id: "2", posted: "2026-11-15T20:00:00-05:00", file: "2026/11/2026-11-15 20.00.00.jpg" },
    // past their day: they go too, a few a run, oldest first
    { id: "1", posted: "2026-11-14T20:00:00-05:00", file: "2026/11/2026-11-14 20.00.00.mp4" },
    { id: "twin", posted: "2026-11-14T20:00:00-05:00", file: "2026/11/2026-11-14 20.00.00 (2).mp4" },
    { id: "0", posted: "2026-11-13T09:00:00-05:00", file: "2026/11/2026-11-13 09.00.00.mp4" },
  ]);
  const prepared = [];
  const posts = [];
  const options = {
    root,
    now,
    backlog: 2,
    oauth: { agent: async () => pds },
    process: async (input, output, settings) => {
      prepared.push([input.slice(root.length + 1), settings]);
      return { width: 720, height: 1280 };
    },
    atproto: async (platform, authorization, files, infos, post) => {
      expect([platform, authorization, infos]).toEqual(["bluesky", pds, [{ width: 720, height: 1280 }]]);
      posts.push(post);
      return { url: "https://bsky.app/x" };
    },
    fetcher: async (url) => {
      expect(url.startsWith("https://pds.example/xrpc/com.atproto.repo.getRecord?")).toBe(true);
      return new Response("", { status: 400 });
    },
    log: () => {},
  };
  expect(await crosspostStories(options)).toEqual({ posted: 4, left: 1, unposted: 0 });
  expect(prepared).toEqual([
    ["2026/11/2026-11-15 20.00.00.jpg", { kind: "photo", policy: "remove-all", maxBytes: 1_900_000 }],
    ["2026/11/2026-11-16 08.00.00.mp4", { kind: "video", policy: "remove-all", maxBytes: 1_900_000 }],
    ["2026/11/2026-11-13 09.00.00.mp4", { kind: "video", policy: "remove-all", maxBytes: 1_900_000 }],
    ["2026/11/2026-11-14 20.00.00.mp4", { kind: "video", policy: "remove-all", maxBytes: 1_900_000 }],
  ]);
  const story = (id, kind, createdAt) => ({
    id: `story-${id}`,
    kind,
    caption: "",
    alt: "",
    tags: pinkleapTags,
    createdAt,
  });
  expect(posts).toEqual([
    story("2", "photo", "2026-11-15T20:00:00.000-05:00"),
    story("3", "video", "2026-11-16T08:00:00.000-05:00"),
    story("0", "video", "2026-11-13T09:00:00.000-05:00"),
    story("1", "video", "2026-11-14T20:00:00.000-05:00"),
  ]);
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  const link = (id) =>
    `https://bsky.app/profile/did:plc:jhvnnnd3adml7t6anu3ay7ip/post/${recordKey(`publisher:bluesky:story-${id}`)}`;
  expect(index.stories.map((story) => story.pinkleap)).toEqual([link("3"), link("2"), link("1"), undefined, link("0")]);

  // The next run sends the rest. A story posted in the same second as another is a millisecond after it, since
  // Bluesky's author feed shows only one of several posts sharing a time.
  posts.length = 0;
  expect(await crosspostStories(options)).toEqual({ posted: 1, left: 0, unposted: 0 });
  expect(posts).toEqual([story("twin", "video", "2026-11-14T20:00:00.001-05:00")]);

  // Sent stories aren't sent again, and with nothing due the account isn't even asked for.
  posts.length = 0;
  const noOauth = { agent: async () => Promise.reject(new Error("must not sign in")) };
  expect(await crosspostStories({ ...options, oauth: noOauth })).toEqual({ posted: 0, left: 0, unposted: 0 });
  expect(posts).toEqual([]);
});

test("Bluesky's daily video limit ends a run, leaving the rest for the next", async () => {
  const now = Date.parse("2026-11-16T14:00:00Z");
  const root = await savedStories([
    { id: "a", posted: "2026-11-10T07:00:00-05:00", file: "a.mp4" },
    { id: "b", posted: "2026-11-11T08:00:00-05:00", file: "b.mp4" },
  ]);
  const posts = [];
  const result = await crosspostStories({
    root,
    now,
    oauth: { agent: async () => pds },
    process: async () => ({ width: 720, height: 1280 }),
    atproto: async (platform, authorization, files, infos, post) => {
      posts.push(post.id);
      throw new Error("Bluesky video upload failed (400: Daily upload limit exceeded)");
    },
    fetcher: async () => new Response("", { status: 400 }),
    log: () => {},
  });
  expect(result).toEqual({ posted: 0, left: 2, unposted: 0 });
  expect(posts).toEqual(["story-a"]);
});

test("a story already posted is noted rather than posted twice, and a failed one waits for the next run", async () => {
  const now = Date.parse("2026-11-16T14:00:00Z");
  const root = await savedStories([
    { id: "a", posted: "2026-11-16T07:00:00-05:00", file: "a.mp4" },
    { id: "b", posted: "2026-11-16T08:00:00-05:00", file: "b.mp4" },
  ]);
  const posts = [];
  const logged = [];
  const result = await crosspostStories({
    root,
    now,
    oauth: { agent: async () => pds },
    process: async () => ({ width: 720, height: 1280 }),
    atproto: async (platform, authorization, files, infos, post) => {
      posts.push(post.id);
      throw new Error("Bluesky video processing failed");
    },
    // a run stopped after posting a left its post up
    fetcher: async (url) =>
      new Response("{}", { status: url.includes(recordKey("publisher:bluesky:story-a")) ? 200 : 400 }),
    log: (line) => logged.push(line),
  });
  expect(result).toEqual({ posted: 1, left: 1, unposted: 0 });
  expect(posts).toEqual(["story-b"]);
  expect(logged).toEqual(["Story b not sent to Pinkleap: Bluesky video processing failed"]);
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  expect(index.stories.map((story) => Boolean(story.pinkleap))).toEqual([true, false]);
});

/** The archive's list of days: [id, story count, latest story's time] each. */
const shellsReply = (days, more = false) =>
  reply("/api/v1/archive/reel/day_shells/", {
    items: days.map(([id, count, latest]) => ({ id, media_count: count, latest_reel_media: latest })),
    more_available: more,
  });
const reelsReply = (id, items) => reply("/api/v1/feed/reels_media/", { reels: { [id]: { id, items } } });
/** A stories folder holding these saved stories, with the archive's days as last seen. */
async function savedArchive(stories, days) {
  const root = await savedStories(stories);
  await writeFile(join(root, "index.json"), JSON.stringify({ days, stories }));
  return root;
}
const readIndex = async (root) => JSON.parse(await readFile(join(root, "index.json"), "utf8"));
const archiveOptions = (root, extra) => ({
  stateDir: "/state",
  root,
  tag: async () => {},
  fetcher: async (url) => new Response(`bytes of ${url}`),
  log: () => {},
  now: Date.parse("2026-11-19T12:00:00Z"),
  ...extra,
});

test("a story deleted on Instagram is marked removed once, and keeps its file", async () => {
  const root = await savedArchive(
    [
      { id: "a", day: "D", posted: "2026-11-18T08:00:00-05:00", file: "a.mp4" },
      { id: "b", day: "D", posted: "2026-11-18T09:00:00-05:00", file: "b.mp4" },
    ],
    { D: "2/1795524400" },
  );
  // the day holds one story now: b was deleted
  const page = archive([[shellsReply([["D", 1, 1795520800]]), reelsReply("D", [story("a", 1795520800)])]]);
  expect(await archiveStories(archiveOptions(root, { open: page.open }))).toEqual({ saved: 0, removed: 1, total: 2 });
  const index = await readIndex(root);
  expect(index.stories.map((s) => [s.id, s.removed])).toEqual([
    ["a", undefined],
    ["b", "2026-11-19T12:00:00.000Z"],
  ]);
  expect(index.days).toEqual({ D: "1/1795520800" });
  expect(await readFile(join(root, "b.mp4"), "utf8")).toBe("bytes of b");
  const again = archive([[shellsReply([["D", 1, 1795520800]])]]);
  expect(await archiveStories(archiveOptions(root, { open: again.open }))).toEqual({ saved: 0, removed: 0, total: 2 });
  expect(again.seen.scrolls).toBe(0);
});

test("a story deleted and another posted the same day still change the day", async () => {
  const root = await savedArchive([{ id: "a", day: "D", posted: "2026-11-18T08:00:00-05:00", file: "a.mp4" }], {
    D: "1/1795520800",
  });
  // still one story, but a later one
  const page = archive([[shellsReply([["D", 1, 1795528000]]), reelsReply("D", [story("c", 1795528000)])]]);
  expect(await archiveStories(archiveOptions(root, { open: page.open }))).toEqual({ saved: 1, removed: 1, total: 2 });
  const index = await readIndex(root);
  expect(index.stories.map((s) => [s.id, s.day, Boolean(s.removed)])).toEqual([
    ["a", "D", true],
    ["c", "D", false],
  ]);
});

test("a day gone from the archive takes its stories with it, once the list of days was read to its end", async () => {
  const root = await savedArchive(
    [
      { id: "a", day: "D1", posted: "2026-11-17T08:00:00-05:00", file: "a.mp4" },
      { id: "b", day: "D2", posted: "2026-11-18T08:00:00-05:00", file: "b.mp4" },
    ],
    { D1: "1/1", D2: "1/2" },
  );
  // more days to come: D2 may just not have been listed yet
  const partial = archive([[shellsReply([["D1", 1, 1]], true)]]);
  expect(await archiveStories(archiveOptions(root, { open: partial.open }))).toEqual({
    saved: 0,
    removed: 0,
    total: 2,
  });
  const whole = archive([[shellsReply([["D1", 1, 1]])]]);
  expect(await archiveStories(archiveOptions(root, { open: whole.open }))).toEqual({ saved: 0, removed: 1, total: 2 });
  const index = await readIndex(root);
  expect(index.stories.map((s) => [s.id, Boolean(s.removed)])).toEqual([
    ["a", false],
    ["b", true],
  ]);
  expect(index.days).toEqual({ D1: "1/1" });
});

test("stories saved before days were noted are placed by reading the archive whole once", async () => {
  const root = await savedArchive(
    [
      { id: "p", posted: "2026-11-17T08:00:00-05:00", file: "p.mp4" },
      { id: "q", posted: "2026-11-18T08:00:00-05:00", file: "q.mp4" },
      { id: "r", posted: "2026-11-18T09:00:00-05:00", file: "r.mp4" },
    ],
    // days remembered by their count alone, as before
    { D1: 1, D2: 1 },
  );
  const downloads = [];
  const page = archive([
    [
      shellsReply([
        ["D2", 1, 2],
        ["D1", 1, 1],
      ]),
      reelsReply("D2", [story("q", 2)]),
    ],
    [reelsReply("D1", [story("p", 1)])],
  ]);
  const options = archiveOptions(root, {
    open: page.open,
    fetcher: async (url) => (downloads.push(url), new Response("")),
  });
  expect(await archiveStories(options)).toEqual({ saved: 0, removed: 1, total: 3 });
  expect(downloads).toEqual([]);
  const index = await readIndex(root);
  // r is in no day the archive has
  expect(index.stories.map((s) => [s.id, s.day, Boolean(s.removed)])).toEqual([
    ["p", "D1", false],
    ["q", "D2", false],
    ["r", undefined, true],
  ]);
  expect(index.days).toEqual({ D1: "1/1", D2: "1/2" });
});

test("a story the archive shows under a new day has moved, not gone", async () => {
  const root = await savedArchive([{ id: "a", day: "old", posted: "2026-11-18T23:30:00-05:00", file: "a.mp4" }], {
    old: "1/1",
  });
  // the laptop's time zone changed, and Instagram cut its days anew
  const page = archive([[shellsReply([["new", 1, 1]]), reelsReply("new", [story("a", 1)])]]);
  expect(await archiveStories(archiveOptions(root, { open: page.open }))).toEqual({ saved: 0, removed: 0, total: 1 });
  const index = await readIndex(root);
  expect(index.stories.map((s) => [s.id, s.day, s.removed])).toEqual([["a", "new", undefined]]);
  expect(index.days).toEqual({ new: "1/1" });
});

test("a run that would take down most saved stories takes down none", async () => {
  const saved = Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}`,
    day: "D",
    posted: `2026-11-18T0${i}:00:00-05:00`,
    file: `s${i}.mp4`,
  }));
  const root = await savedArchive(saved, { D: "8/8" });
  const logged = [];
  const page = archive([[shellsReply([["D", 1, 1]]), reelsReply("D", [story("s0", 1)])]]);
  const result = await archiveStories(archiveOptions(root, { open: page.open, log: (line) => logged.push(line) }));
  expect(result).toEqual({ saved: 0, removed: 0, total: 8 });
  expect(logged).toEqual([
    "Instagram's archive is missing 7 of 8 saved stories; none were marked removed, in case its page came back incomplete",
  ]);
  // the day isn't remembered as seen, so the next run looks again
  expect((await readIndex(root)).days).toEqual({ D: "8/8" });
});

test("a story deleted on Instagram comes off Pinkleap and is never sent", async () => {
  const removed = "2026-11-19T12:00:00.000Z";
  const root = await savedStories([
    { id: "x", posted: "2026-11-18T08:00:00-05:00", file: "x.mp4", pinkleap: "https://bsky.app/x", removed },
    { id: "y", posted: "2026-11-18T09:00:00-05:00", file: "y.mp4", removed },
  ]);
  const deleted = [];
  const session = {
    agent: {
      did: "did:plc:jhvnnnd3adml7t6anu3ay7ip",
      com: { atproto: { repo: { deleteRecord: async (args) => deleted.push(args) } } },
    },
    pdsUrl: new URL("https://pds.example"),
  };
  const result = await crosspostStories({
    root,
    now: Date.parse("2026-11-19T12:00:00Z"),
    oauth: { agent: async () => session },
    atproto: async () => {
      throw new Error("must not post");
    },
    log: () => {},
  });
  expect(result).toEqual({ posted: 0, left: 0, unposted: 1 });
  expect(deleted).toEqual([
    {
      repo: "did:plc:jhvnnnd3adml7t6anu3ay7ip",
      collection: "app.bsky.feed.post",
      rkey: recordKey("publisher:bluesky:story-x"),
    },
  ]);
  expect((await readIndex(root)).stories.map((s) => s.pinkleap)).toEqual([undefined, undefined]);
});
