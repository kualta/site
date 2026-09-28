import { expect, test } from "bun:test";
import type { ActivityFetch } from "./activity/types";
import { getGalleryPage, normalizeGallery } from "./gallery";

const did = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const post = {
  uri: `at://${did}/social.grain.gallery/post1`,
  creator: { did, handle: "kualta.dev", displayName: "ku" },
  record: {
    $type: "social.grain.gallery",
    title: "hello",
    description: "A gallery",
    createdAt: "2026-08-30T12:00:00Z",
  },
  items: [
    {
      alt: "second",
      thumb: "https://cdn.grain.social/2.jpg",
      fullsize: "https://cdn.grain.social/2.jpg",
      gallery: { itemPosition: 1 },
    },
    {
      alt: "first",
      thumb: "https://cdn.grain.social/1.jpg",
      fullsize: "https://cdn.grain.social/1.jpg",
      gallery: { itemPosition: 0 },
    },
  ],
};
const feed = { items: [post], cursor: "older" };
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
  const page = normalizeGallery({ ...feed, items: [post, post] });
  expect(page.posts).toHaveLength(1);
  expect(page.posts[0].media.map((m) => m.alt)).toEqual(["first", "second"]);
  expect(page.cursor).toBe("older");
});

test("excludes other authors, moderated records, and unsafe media", () => {
  expect(
    normalizeGallery({
      items: [
        { ...post, creator: { did: "did:plc:other" } },
        { ...post, labels: [{ val: "porn" }] },
        { ...post, items: [{ fullsize: "javascript:alert(1)", thumb: "https://cdn.grain.social/x.jpg" }] },
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
