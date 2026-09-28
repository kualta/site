import { getBlueskyMedia, type BlueskyMedia } from "./activity/bluesky-media";
import { sanitizeBlueskyPostView, canRenderBlueskyPost } from "./activity/bluesky-post";
import { asRecord } from "./activity/validation";
import type { ActivityCacheStore, ActivityFetch } from "./activity/types";

export interface GalleryPost {
  uri: string;
  url: string;
  text: string;
  date: string;
  author: string;
  handle: string;
  media: BlueskyMedia[];
}
export interface GalleryPage {
  posts: GalleryPost[];
  cursor?: string;
}
const FRESH_MS = 5 * 60 * 1000;
const pending = new Map<string, Promise<GalleryPage>>();

export function normalizeGallery(value: unknown): GalleryPage {
  const data = asRecord(value);
  if (!Array.isArray(data?.feed)) throw new Error("Invalid gallery feed");
  const posts: GalleryPost[] = [];
  const seen = new Set<string>();
  for (const item of data.feed) {
    const entry = asRecord(item);
    if (entry?.reason) continue; // Only the author's uploads, never reposts.
    const post = sanitizeBlueskyPostView(entry?.post);
    if (!post || !canRenderBlueskyPost(post) || seen.has(post.uri)) continue;
    const embed = asRecord(post.embed);
    // A quote's images belong to its author; only take media attached to this post.
    if (embed?.$type === "app.bsky.embed.record#view") continue;
    const ownEmbed = embed?.$type === "app.bsky.embed.recordWithMedia#view" ? embed.media : embed;
    const media = getBlueskyMedia(ownEmbed);
    if (!media.length) continue;
    const record = asRecord(post.record)!;
    seen.add(post.uri);
    posts.push({
      uri: post.uri,
      url: `https://bsky.app/profile/${post.author.did}/post/${post.uri.split("/").pop()}`,
      text: String(record.text),
      date: String(record.createdAt),
      author: post.author.displayName || post.author.handle,
      handle: post.author.handle,
      media,
    });
  }
  return { posts, ...(typeof data.cursor === "string" ? { cursor: data.cursor } : {}) };
}

export async function getGalleryPage(options: {
  cursor?: string;
  cache?: ActivityCacheStore;
  fetch?: ActivityFetch;
  waitUntil?: (work: Promise<unknown>) => void;
  now?: number;
}): Promise<GalleryPage> {
  const { cursor, cache, waitUntil } = options;
  const key = `gallery:v1:${cursor || "latest"}`;
  const now = options.now ?? Date.now();
  let cached: { at: number; page: GalleryPage } | undefined;
  try {
    const raw = await cache?.get(key);
    if (raw) cached = JSON.parse(raw);
  } catch {}
  if (cached && now - cached.at < FRESH_MS) return cached.page;
  const refresh = () => {
    const existing = pending.get(key);
    if (existing) return existing;
    const work = (async () => {
      const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
      url.searchParams.set("actor", "kualta.dev");
      url.searchParams.set("filter", "posts_with_media");
      url.searchParams.set("limit", "50");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("Bluesky is unavailable");
      const page = normalizeGallery(await response.json());
      try {
        await cache?.put(key, JSON.stringify({ at: now, page }));
      } catch {}
      return page;
    })().finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  };
  if (cached && waitUntil) {
    waitUntil(refresh().catch(() => undefined));
    return cached.page;
  }
  try {
    return await refresh();
  } catch (error) {
    if (cached) return cached.page;
    throw error;
  }
}
