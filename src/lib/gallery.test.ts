import { expect, test } from "bun:test";
import type { ActivityFetch } from "./activity/types";
import { getGalleryPage, normalizeGallery } from "./gallery";

const post = {
  uri: "at://did:plc:jhvnnnd3adml7t6anu3ay7ip/app.bsky.feed.post/post1",
  cid: "bafyreid3l3mpwbadpafmoajnc2ukaaf42cmnti6shcomrrqnqq4ctap5xy",
  indexedAt: "2026-08-30T12:00:00Z",
  author: { did: "did:plc:jhvnnnd3adml7t6anu3ay7ip", handle: "kualta.dev" },
  record: { $type: "app.bsky.feed.post", text: "hello", createdAt: "2026-08-30T12:00:00Z" },
  embed: {
    $type: "app.bsky.embed.images#view",
    images: [
      { alt: "first", thumb: "https://cdn.bsky.app/1.jpg", fullsize: "https://cdn.bsky.app/1.jpg" },
      { alt: "second", thumb: "https://cdn.bsky.app/2.jpg", fullsize: "https://cdn.bsky.app/2.jpg" },
    ],
  },
};
const feed = { feed: [{ post }], cursor: "older" };
function memoryCache() {
  const entries = new Map<string, string>();
  return {
    get: async (key: string) => entries.get(key) ?? null,
    put: async (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

test("keeps all attached images, deduplicates posts, and preserves pagination", () => {
  const page = normalizeGallery({ ...feed, feed: [{ post }, { post }] });
  expect(page.posts).toHaveLength(1);
  expect(page.posts[0].media.map((m) => m.alt)).toEqual(["first", "second"]);
  expect(page.cursor).toBe("older");
});

test("excludes reposts, quotes without own media, and moderated media", () => {
  expect(
    normalizeGallery({
      feed: [
        { post, reason: { $type: "app.bsky.feed.defs#reasonRepost" } },
        { post: { ...post, labels: [{ src: post.author.did, uri: post.uri, val: "porn", cts: post.indexedAt }] } },
        { post: { ...post, embed: undefined } },
      ],
    }).posts,
  ).toEqual([]);
});

test("fresh cache avoids upstream; stale cache returns immediately and refreshes", async () => {
  const cache = memoryCache();
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return Response.json(feed);
  }) as ActivityFetch;
  await getGalleryPage({ cache, fetch: fetcher, now: 1000 });
  await getGalleryPage({ cache, fetch: fetcher, now: 2000 });
  expect(calls).toBe(1);
  let refresh: Promise<unknown> | undefined;
  const page = await getGalleryPage({
    cache,
    fetch: fetcher,
    now: 400_000,
    waitUntil: (work) => {
      refresh = work;
    },
  });
  expect(page.posts).toHaveLength(1);
  await refresh;
  expect(calls).toBe(2);
});

test("uses separate cursor caches and retains cached data on upstream failure", async () => {
  const cache = memoryCache();
  let requested = "";
  const fetcher = (async (url: URL) => {
    requested = url.searchParams.get("cursor") ?? "";
    return Response.json(feed);
  }) as ActivityFetch;
  await getGalleryPage({ cache, cursor: "older", fetch: fetcher, now: 1 });
  expect(requested).toBe("older");
  const failing = (async () => {
    throw new Error("offline");
  }) as ActivityFetch;
  expect((await getGalleryPage({ cache, cursor: "older", fetch: failing, now: 400_000 })).posts).toHaveLength(1);
  await expect(getGalleryPage({ cache, fetch: failing })).rejects.toThrow("offline");
});
