import { expect, test } from "bun:test";
import type { ActivityFetch } from "./activity/types";
import {
  formatDuration,
  getVideoLibrary,
  getWatchVideo,
  isShort,
  liveStories,
  normalizeStoryPost,
  normalizeVideoPost,
  playlistDuration,
  readStories,
  richText,
  splitTitle,
  storyDays,
  timeAgo,
  upNext,
} from "./videos";

const did = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const author = { did, handle: "kualta.dev", displayName: "ku", avatar: "https://cdn.bsky.app/a.jpg" };
function post(rkey: string, text: string, options: { createdAt?: string; width?: number; height?: number } = {}) {
  const cid = `bafy${rkey}`;
  return {
    uri: `at://${did}/app.bsky.feed.post/${rkey}`,
    author,
    record: { $type: "app.bsky.feed.post", text, createdAt: options.createdAt ?? "2026-11-01T12:00:00Z" },
    embed: {
      $type: "app.bsky.embed.video#view",
      cid,
      playlist: `https://video.bsky.app/watch/${encodeURIComponent(did)}/${cid}/playlist.m3u8`,
      thumbnail: `https://video.bsky.app/watch/${encodeURIComponent(did)}/${cid}/thumbnail.jpg`,
      aspectRatio: { width: options.width ?? 1920, height: options.height ?? 1080 },
    },
    likeCount: 2,
    repostCount: 0,
    replyCount: 1,
  };
}
const m3u8 =
  "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\nvideo0.ts\n#EXTINF:6.000,\nvideo1.ts\n#EXTINF:1.367,\nvideo2.ts\n";
function memoryCache() {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (key: string) => entries.get(key) ?? null,
    put: async (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}
function appview(feed: unknown[], calls: string[]): ActivityFetch {
  return async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("getAuthorFeed")) return Response.json({ feed });
    if (url.endsWith("/360p/video.m3u8")) return new Response(m3u8);
    return new Response("missing", { status: 404 });
  };
}

test("titles a video with its first line and keeps the rest as the description", () => {
  expect(splitTitle("Lorax wisdom, part 5\n\nShe worked on housing", [])).toEqual({
    title: "Lorax wisdom, part 5",
    description: [{ text: "She worked on housing" }],
  });
  expect(splitTitle("one line", [])).toEqual({ title: "one line", description: [] });
  expect(splitTitle("   ", [])).toEqual({ title: "untitled", description: [] });
  const long = "word ".repeat(40).trim();
  const split = splitTitle(long, []);
  expect([...split.title].length).toBeLessThanOrEqual(100);
  expect(split.title.endsWith("…")).toBe(true);
  expect(split.description).toEqual([{ text: long }]);
});

test("links facets by UTF-8 byte offsets, past multibyte text", () => {
  const text = "なんで check kualta.dev #godot";
  const encoder = new TextEncoder();
  const at = (part: string) => encoder.encode(text.slice(0, text.indexOf(part))).length;
  const facets = [
    {
      index: { byteStart: at("kualta.dev"), byteEnd: at("kualta.dev") + 10 },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://kualta.dev" }],
    },
    {
      index: { byteStart: at("#godot"), byteEnd: at("#godot") + 6 },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag: "godot" }],
    },
    { index: { byteStart: 0, byteEnd: 3 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "javascript:x" }] },
  ];
  expect(richText(text, facets)).toEqual([
    { text: "なんで check " },
    { text: "kualta.dev", href: "https://kualta.dev" },
    { text: " " },
    { text: "#godot", href: "https://bsky.app/hashtag/godot" },
  ]);
  const titled = splitTitle(
    `title\n${text}`,
    facets.map((facet) => ({
      ...facet,
      index: { byteStart: facet.index.byteStart + 6, byteEnd: facet.index.byteEnd + 6 },
    })),
  );
  expect(titled.description[1]).toEqual({ text: "kualta.dev", href: "https://kualta.dev" });
});

test("keeps only the account's own unlabeled video posts", () => {
  const video = normalizeVideoPost(post("abc", "hello"))!;
  expect(video).toMatchObject({ rkey: "abc", title: "hello", likes: 2, replies: 1, width: 1920, height: 1080 });
  expect(video.url).toBe(`https://bsky.app/profile/${did}/post/abc`);
  expect(normalizeVideoPost({ ...post("abc", "x"), author: { did: "did:plc:other" } })).toBeUndefined();
  expect(normalizeVideoPost({ ...post("abc", "x"), uri: "at://did:plc:other/app.bsky.feed.post/abc" })).toBeUndefined();
  expect(normalizeVideoPost({ ...post("abc", "x"), labels: [{ val: "porn" }] })).toBeUndefined();
  expect(normalizeVideoPost({ ...post("abc", "x"), embed: { $type: "app.bsky.embed.images#view" } })).toBeUndefined();
  const quoted = post("q", "quote");
  expect(
    normalizeVideoPost({
      ...quoted,
      embed: { $type: "app.bsky.embed.recordWithMedia#view", media: quoted.embed, record: {} },
    })?.cid,
  ).toBe("bafyq");
});

test("sorts by aspect, reads durations and formats them", () => {
  expect(isShort({ width: 1080, height: 1920 })).toBe(true);
  expect(isShort({ width: 1920, height: 1080 })).toBe(false);
  expect(playlistDuration(m3u8)).toBe(13.37);
  expect(playlistDuration("#EXTM3U\n")).toBeUndefined();
  expect(formatDuration(0.8)).toBe("0:01");
  expect(formatDuration(19.367)).toBe("0:19");
  expect(formatDuration(245)).toBe("4:05");
  expect(formatDuration(3723)).toBe("1:02:03");
  const now = Date.parse("2026-11-09T12:00:00Z");
  expect(timeAgo("2026-11-06T11:00:00Z", now)).toBe("3 days ago");
  expect(timeAgo("2026-11-09T11:59:30Z", now)).toBe("just now");
});

test("builds the library newest first, skips reposts, and reuses cached durations", async () => {
  const cache = memoryCache();
  const calls: string[] = [];
  const feed = [
    { post: post("old", "old", { createdAt: "2026-10-01T00:00:00Z" }) },
    { post: post("new", "new", { createdAt: "2026-11-01T00:00:00Z", width: 1080, height: 1920 }) },
    { post: post("rp", "repost"), reason: { $type: "app.bsky.feed.defs#reasonRepost" } },
  ];
  const now = Date.parse("2026-11-09T12:00:00Z");
  const first = await getVideoLibrary({ cache, fetch: appview(feed, calls), now });
  expect(first.videos.map((video) => video.rkey)).toEqual(["new", "old"]);
  expect(first.videos.map((video) => video.duration)).toEqual([13.37, 13.37]);
  expect(first.channel).toEqual({ handle: "kualta.dev", name: "ku", avatar: "https://cdn.bsky.app/a.jpg" });
  expect(calls.filter((url) => url.endsWith(".m3u8"))).toHaveLength(2);

  calls.length = 0;
  await getVideoLibrary({ cache, fetch: appview(feed, calls), now: now + 60_000 });
  expect(calls).toHaveLength(0);

  const stale = await getVideoLibrary({ cache, fetch: appview(feed, calls), now: now + 10 * 60_000 });
  expect(stale.videos[0].duration).toBe(13.37);
  expect(calls.filter((url) => url.endsWith(".m3u8"))).toHaveLength(0);
});

test("serves the last library when Bluesky fails, and fails without one", async () => {
  const cache = memoryCache();
  const down: ActivityFetch = async () => new Response("down", { status: 502 });
  await expect(getVideoLibrary({ cache, fetch: down })).rejects.toThrow();
  const now = Date.parse("2026-11-09T12:00:00Z");
  await getVideoLibrary({ cache, fetch: appview([{ post: post("a", "a") }], []), now });
  const library = await getVideoLibrary({ cache, fetch: down, now: now + 10 * 60_000 });
  expect(library.videos.map((video) => video.rkey)).toEqual(["a"]);
});

test("watches listed videos, reads unlisted ones on their own, and rejects bad keys", async () => {
  const cache = memoryCache();
  const calls: string[] = [];
  const feed = [{ post: post("a", "a") }, { post: post("b", "b", { createdAt: "2026-10-01T00:00:00Z" }) }];
  const base = appview(feed, calls);
  const fetcher: ActivityFetch = async (input, init) =>
    String(input).includes("getPosts") ? Response.json({ posts: [post("fresh", "fresh")] }) : base(input, init);
  const listed = await getWatchVideo("b", { cache, fetch: fetcher });
  expect(listed.status === 200 && listed.video.rkey).toBe("b");
  const fresh = await getWatchVideo("fresh", { cache, fetch: fetcher });
  expect(fresh.status === 200 && [fresh.video.rkey, fresh.video.duration]).toEqual(["fresh", 13.37]);
  expect((await getWatchVideo("../etc", { cache, fetch: fetcher })).status).toBe(404);
  const none: ActivityFetch = async (input, init) =>
    String(input).includes("getPosts") ? Response.json({ posts: [] }) : base(input, init);
  expect((await getWatchVideo("gone", { cache, fetch: none })).status).toBe(404);
});

test("up next continues after the current video, then wraps", () => {
  const videos = ["a", "b", "c", "d"].map((rkey) => normalizeVideoPost(post(rkey, rkey))!);
  expect(upNext(videos, videos[1]).map((video) => video.rkey)).toEqual(["c", "d", "a"]);
});

function story(rkey: string, createdAt: string, kind: "photo" | "video" = "video") {
  const base = post(rkey, "", { createdAt, width: 720, height: 1280 });
  const record = { ...base.record, tags: ["pinkleapStory"] };
  if (kind === "video") return { ...base, record };
  return {
    ...base,
    record,
    embed: {
      $type: "app.bsky.embed.images#view",
      images: [
        {
          thumb: `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${rkey}@jpeg`,
          fullsize: `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${rkey}@jpeg`,
          alt: "",
          aspectRatio: { width: 1179, height: 2096 },
        },
      ],
    },
  };
}

test("stories are photos or videos of the account's own tagged posts, never listed as videos", () => {
  const video = story("sv", "2026-11-16T09:31:20.880-05:00");
  expect(normalizeVideoPost(video)).toBeUndefined();
  expect(normalizeStoryPost(video)).toMatchObject({
    rkey: "sv",
    kind: "video",
    src: `https://video.bsky.app/watch/${encodeURIComponent(did)}/bafysv/playlist.m3u8`,
    thumbnail: `https://video.bsky.app/watch/${encodeURIComponent(did)}/bafysv/thumbnail.jpg`,
    date: "2026-11-16T09:31:20.880-05:00",
    width: 720,
    height: 1280,
  });
  expect(normalizeStoryPost(story("sp", "2026-11-16T09:00:00-05:00", "photo"))).toMatchObject({
    kind: "photo",
    src: `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/sp@jpeg`,
    thumbnail: `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/sp@jpeg`,
    width: 1179,
    height: 2096,
  });
  // the tag Pinkleap used as Pinksky still counts
  const older = story("old", "2025-06-01T12:00:00Z");
  expect(normalizeStoryPost({ ...older, record: { ...older.record, tags: ["pinkskyStory"] } })?.rkey).toBe("old");
  expect(normalizeStoryPost(post("plain", "a video"))).toBeUndefined();
  expect(normalizeStoryPost({ ...video, author: { did: "did:plc:other" } })).toBeUndefined();
  expect(normalizeStoryPost({ ...video, labels: [{ val: "porn" }] })).toBeUndefined();
});

test("stories group by the day they were posted, on the clock they were posted with", () => {
  const stories = [
    normalizeStoryPost(story("late", "2026-11-14T23:30:00-05:00"))!,
    normalizeStoryPost(story("next", "2026-11-15T08:00:00-05:00"))!,
    normalizeStoryPost(story("early", "2026-11-14T07:00:00-05:00"))!,
    normalizeStoryPost(story("lastyear", "2025-12-31T10:00:00Z"))!,
  ];
  // 23:30 in Bogotá is already the 15th in UTC; it stays on the 14th
  const days = storyDays(stories, Date.parse("2026-11-16T12:00:00Z"));
  expect(days.map((day) => [day.day, day.label, day.stories.map((s) => s.rkey)])).toEqual([
    ["2026-11-15", "Nov 15", ["next"]],
    ["2026-11-14", "Nov 14", ["early", "late"]],
    ["2025-12-31", "Dec 31, 2025", ["lastyear"]],
  ]);
});

test("the library carries stories from the media feed, and keeps the last ones when that read fails", async () => {
  const cache = memoryCache();
  const now = Date.parse("2026-11-16T12:00:00Z");
  const media = [{ post: story("s1", "2026-11-16T09:00:00-05:00", "photo") }, { post: post("v", "video") }];
  const fetcher =
    (failStories: boolean): ActivityFetch =>
    async (input) => {
      const url = String(input);
      if (url.includes("posts_with_media"))
        return failStories ? new Response("down", { status: 502 }) : Response.json({ feed: media });
      if (url.includes("getAuthorFeed")) return Response.json({ feed: [{ post: post("v", "video") }] });
      return new Response(m3u8);
    };
  const first = await getVideoLibrary({ cache, fetch: fetcher(false), now });
  expect(first.stories.map((s) => s.rkey)).toEqual(["s1"]);
  expect(first.videos.map((video) => video.rkey)).toEqual(["v"]);
  const later = await getVideoLibrary({ cache, fetch: fetcher(true), now: now + 10 * 60_000 });
  expect(later.stories.map((s) => s.rkey)).toEqual(["s1"]);
  expect(later.videos.map((video) => video.rkey)).toEqual(["v"]);
});

test("stories still up are the last day's, in the order they were posted", () => {
  const now = Date.parse("2026-11-16T20:00:00Z");
  const stories = [
    normalizeStoryPost(story("newer", "2026-11-16T13:40:00-05:00"))!,
    normalizeStoryPost(story("older", "2026-11-15T16:00:00-05:00"))!,
    // a day and a minute ago
    normalizeStoryPost(story("gone", "2026-11-15T14:59:00-05:00"))!,
  ];
  expect(liveStories(stories, now).map((s) => s.rkey)).toEqual(["older", "newer"]);
});

test("the whole history is read page by page, up to the pages allowed", async () => {
  const pages = [
    { feed: [{ post: story("c", "2026-11-16T09:00:00-05:00") }, { post: post("v", "not a story") }], cursor: "2" },
    { feed: [{ post: story("b", "2026-11-10T09:00:00-05:00", "photo") }], cursor: "3" },
    { feed: [{ post: story("a", "2026-09-14T09:00:00-05:00") }] },
  ];
  const asked: (string | null)[] = [];
  const fetcher: ActivityFetch = async (input) => {
    const cursor = new URL(String(input)).searchParams.get("cursor");
    asked.push(cursor);
    return Response.json(pages[cursor ? Number(cursor) - 1 : 0]);
  };
  expect((await readStories(fetcher, 50)).map((s) => s.rkey)).toEqual(["c", "b", "a"]);
  expect(asked).toEqual([null, "2", "3"]);
  asked.length = 0;
  expect((await readStories(fetcher, 2)).map((s) => s.rkey)).toEqual(["c", "b"]);
  expect(asked).toEqual([null, "2"]);
});
