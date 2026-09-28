import type { BlueskyMedia } from "./activity/bluesky-media";
import { asRecord } from "./activity/validation";
import type { ActivityCacheStore, ActivityFetch } from "./activity/types";
import identity from "../../atproto.config.json";

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

function mediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch {}
}

/** Grain's AppView hydrates social.grain.gallery + gallery.item + photo records. */
export function normalizeGallery(value: unknown): GalleryPage {
  const data = asRecord(value);
  if (!Array.isArray(data?.items)) throw new Error("Invalid Grain gallery feed");
  const posts: GalleryPost[] = [];
  const seen = new Set<string>();
  for (const item of data.items) {
    const gallery = asRecord(item);
    const record = asRecord(gallery?.record);
    const creator = asRecord(gallery?.creator);
    const uri = gallery?.uri;
    if (typeof uri !== "string" || !uri.startsWith(`at://${identity.did}/social.grain.gallery/`) || seen.has(uri))
      continue;
    if (creator?.did !== identity.did || !record || !Array.isArray(gallery?.items)) continue;
    const labels = gallery.labels;
    if (Array.isArray(labels) && labels.some((label) => asRecord(label)?.neg !== true)) continue;
    const selfLabels = asRecord(record.labels)?.values;
    if (Array.isArray(selfLabels) && selfLabels.length) continue;
    const media: BlueskyMedia[] = [];
    const sorted = [...gallery.items].sort(
      (a, b) =>
        Number(asRecord(asRecord(a)?.gallery)?.itemPosition ?? 0) -
        Number(asRecord(asRecord(b)?.gallery)?.itemPosition ?? 0),
    );
    for (const item of sorted) {
      const photo = asRecord(item);
      const src = mediaUrl(photo?.fullsize);
      const thumbnail = mediaUrl(photo?.thumb);
      const ratio = asRecord(photo?.aspectRatio);
      if (!src || !thumbnail) continue;
      media.push({
        kind: "image",
        src,
        thumbnail,
        alt: typeof photo?.alt === "string" ? photo.alt : "",
        width: typeof ratio?.width === "number" && ratio.width > 0 ? ratio.width : 1,
        height: typeof ratio?.height === "number" && ratio.height > 0 ? ratio.height : 1,
      });
    }
    const date = record.createdAt;
    if (!media.length || typeof date !== "string" || !Number.isFinite(Date.parse(date))) continue;
    seen.add(uri);
    const title = typeof record.title === "string" ? record.title : "";
    const description = typeof record.description === "string" ? record.description : "";
    posts.push({
      uri,
      url: `https://grain.social/profile/${identity.did}/gallery/${encodeURIComponent(uri.split("/").pop()!)}`,
      text: [title, description].filter(Boolean).join("\n\n"),
      date,
      author: typeof creator.displayName === "string" ? creator.displayName : "kualta",
      handle: typeof creator.handle === "string" ? creator.handle : "kualta.dev",
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
  const key = `gallery:grain:v1:${cursor || "latest"}`;
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
      const url = new URL("https://grain.social/xrpc/dev.hatk.getFeed");
      url.searchParams.set("actor", identity.did);
      url.searchParams.set("feed", "actor");
      url.searchParams.set("limit", "30");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("Grain is unavailable");
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
