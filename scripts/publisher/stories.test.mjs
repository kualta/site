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
        { id: "archiveDay:2", media_count: 2 },
        { id: "archiveDay:1", media_count: 1 },
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
  expect(await archiveStories({ ...options, open: first.open })).toEqual({ saved: 3, total: 3 });
  expect(first.seen).toEqual({ scrolls: 1, closed: true });
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  expect(index.stories).toEqual([
    { id: "3986126615415459488", posted: "2026-09-14T07:00:00-05:00", file: "2026/09/2026-09-14 07.00.00.jpg" },
    {
      id: "4030127951811103297",
      posted: "2026-11-14T22:30:00-05:00",
      file: "2026/11/2026-11-14 22.30.00.mp4",
      song: "Riders on the Storm",
      artist: "The Doors",
    },
    {
      id: "4030127951811103298",
      posted: "2026-11-14T22:30:00-05:00",
      file: "2026/11/2026-11-14 22.30.00 (2).mp4",
    },
  ]);
  expect(index.days).toEqual({ "archiveDay:2": 2, "archiveDay:1": 1 });
  const saved = join(root, "2026/11/2026-11-14 22.30.00.mp4");
  expect(await readFile(saved, "utf8")).toBe("bytes of https://cdn.example/4030127951811103297.mp4");
  expect((await stat(saved)).mtimeMs).toBe(1794713400 * 1000);
  expect(tagged[0]).toContain("-Keys:CreationDate=2026:11:14 22:30:00-05:00");
  expect(tagged[2]).toContain("-OffsetTimeOriginal=-05:00");

  // Finished days aren't fetched again: the next run neither scrolls nor downloads.
  downloads.length = 0;
  const again = archive([[shells]]);
  expect(await archiveStories({ ...options, open: again.open })).toEqual({ saved: 0, total: 3 });
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
    total: 1,
  });
  expect(logged).toEqual(["Story 2 not saved: download failed (403)"]);
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  expect(index.days).toEqual({});
  const fetched = [];
  const fixed = async (url) => (fetched.push(url), new Response("ok"));
  expect(await archiveStories({ ...options, open: archive([replies()]).open, fetcher: fixed })).toEqual({
    saved: 1,
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

test("stories still up go to Pinkleap once, oldest first, as tagged posts dated on their own clock", async () => {
  const now = Date.parse("2026-11-16T14:00:00Z");
  const root = await savedStories([
    { id: "3", posted: "2026-11-16T08:00:00-05:00", file: "2026/11/2026-11-16 08.00.00.mp4" },
    { id: "2", posted: "2026-11-15T20:00:00-05:00", file: "2026/11/2026-11-15 20.00.00.jpg" },
    // a day and more ago: gone from Instagram, so not sent on
    { id: "1", posted: "2026-11-14T20:00:00-05:00", file: "2026/11/2026-11-14 20.00.00.mp4" },
  ]);
  const prepared = [];
  const posts = [];
  const options = {
    root,
    now,
    // a clock that doesn't move, as when two photos go out within a millisecond
    clock: () => now,
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
  expect(await crosspostStories(options)).toEqual({ posted: 2 });
  expect(prepared).toEqual([
    ["2026/11/2026-11-15 20.00.00.jpg", { kind: "photo", policy: "remove-all", maxBytes: 1_900_000 }],
    ["2026/11/2026-11-16 08.00.00.mp4", { kind: "video", policy: "remove-all", maxBytes: 1_900_000 }],
  ]);
  expect(posts).toEqual([
    {
      id: "story-2",
      kind: "photo",
      caption: "",
      alt: "",
      tags: pinkleapTags,
      createdAt: "2026-11-16T09:00:00.000-05:00",
    },
    {
      id: "story-3",
      kind: "video",
      caption: "",
      alt: "",
      tags: pinkleapTags,
      // never the same time as the story before: Bluesky's author feed would show only one of them
      createdAt: "2026-11-16T09:00:00.001-05:00",
    },
  ]);
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  const link = (id) =>
    `https://bsky.app/profile/did:plc:jhvnnnd3adml7t6anu3ay7ip/post/${recordKey(`publisher:bluesky:story-${id}`)}`;
  expect(index.stories.map((story) => story.pinkleap)).toEqual([link("3"), link("2"), undefined]);

  // Sent stories aren't sent again, and with nothing due the account isn't even asked for.
  posts.length = 0;
  const noOauth = { agent: async () => Promise.reject(new Error("must not sign in")) };
  expect(await crosspostStories({ ...options, oauth: noOauth })).toEqual({ posted: 0 });
  expect(posts).toEqual([]);
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
  expect(result).toEqual({ posted: 1 });
  expect(posts).toEqual(["story-b"]);
  expect(logged).toEqual(["Story b not sent to Pinkleap: Bluesky video processing failed"]);
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  expect(index.stories.map((story) => Boolean(story.pinkleap))).toEqual([true, false]);
});
