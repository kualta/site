import { asRecord } from "./activity/validation";
import type { ActivityCacheStore, ActivityFetch } from "./activity/types";
import identity from "../../atproto.config.json";

/** A run of post text, linked when a facet covers it. */
export interface VideoSegment {
  text: string;
  href?: string;
}
export interface Video {
  rkey: string;
  uri: string;
  cid: string;
  /** the post on Bluesky */
  url: string;
  title: string;
  /** the post text after the line used as the title */
  description: VideoSegment[];
  date: string;
  playlist: string;
  thumbnail?: string;
  alt: string;
  width: number;
  height: number;
  /** seconds, read from the HLS playlist */
  duration?: number;
  likes: number;
  reposts: number;
  replies: number;
}
export interface VideoChannel {
  handle: string;
  name: string;
  avatar?: string;
}
export interface VideoLibrary {
  channel: VideoChannel;
  videos: Video[];
}
interface Options {
  cache?: ActivityCacheStore;
  fetch?: ActivityFetch;
  waitUntil?: (work: Promise<unknown>) => void;
  now?: number;
}

const APPVIEW = "https://public.api.bsky.app/xrpc";
const KEY = "videos:bluesky:v1";
const FRESH_MS = 5 * 60 * 1000;
const MAX_PAGES = 3;
/** playlist reads per refresh, so one request stays well inside the subrequest limit */
const DURATION_BUDGET = 30;
/** a Worker opens six connections at once; more would sit queued while their timeouts run */
const CONNECTIONS = 6;
const TITLE_LENGTH = 100;
const POST_PREFIX = `at://${identity.did}/app.bsky.feed.post/`;
const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;
const fallbackChannel: VideoChannel = { handle: "kualta.dev", name: "kualta" };
let pending: Promise<VideoLibrary> | undefined;

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch {}
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function dimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Facets index UTF-8 bytes, so the text is cut as bytes and decoded back. */
export function richText(text: string, facets: unknown): VideoSegment[] {
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();
  const ranges: { start: number; end: number; href: string }[] = [];
  for (const value of Array.isArray(facets) ? facets : []) {
    const facet = asRecord(value);
    const index = asRecord(facet?.index);
    const start = index?.byteStart;
    const end = index?.byteEnd;
    if (typeof start !== "number" || typeof end !== "number" || start < 0 || end <= start || end > bytes.length)
      continue;
    const feature = asRecord(Array.isArray(facet?.features) ? facet.features[0] : undefined);
    let href: string | undefined;
    if (feature?.$type === "app.bsky.richtext.facet#link") {
      const uri = typeof feature.uri === "string" ? feature.uri : "";
      if (/^https?:\/\//i.test(uri)) href = uri;
    } else if (feature?.$type === "app.bsky.richtext.facet#mention" && typeof feature.did === "string")
      href = `https://bsky.app/profile/${encodeURIComponent(feature.did)}`;
    else if (feature?.$type === "app.bsky.richtext.facet#tag" && typeof feature.tag === "string")
      href = `https://bsky.app/hashtag/${encodeURIComponent(feature.tag)}`;
    if (href) ranges.push({ start, end, href });
  }
  ranges.sort((a, b) => a.start - b.start);
  const segments: VideoSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) segments.push({ text: decoder.decode(bytes.slice(cursor, range.start)) });
    segments.push({ text: decoder.decode(bytes.slice(range.start, range.end)), href: range.href });
    cursor = range.end;
  }
  if (cursor < bytes.length) segments.push({ text: decoder.decode(bytes.slice(cursor)) });
  return segments;
}

/** Drop the first `length` characters, keeping each remaining run's link. */
function dropPrefix(segments: VideoSegment[], length: number): VideoSegment[] {
  const rest: VideoSegment[] = [];
  let skip = length;
  for (const segment of segments) {
    if (skip >= segment.text.length) {
      skip -= segment.text.length;
      continue;
    }
    rest.push({ ...segment, text: segment.text.slice(skip) });
    skip = 0;
  }
  while (rest.length && !rest[0].text.trim()) rest.shift();
  if (rest.length && !rest[0].href) rest[0] = { ...rest[0], text: rest[0].text.trimStart() };
  return rest;
}

/** The first line titles the video; a line too long for a title stays whole in the description. */
export function splitTitle(text: string, facets: unknown): { title: string; description: VideoSegment[] } {
  const segments = richText(text, facets);
  const leading = text.length - text.trimStart().length;
  const line = text.trimStart().split("\n")[0].trim();
  if (!line) return { title: "untitled", description: [] };
  if ([...line].length <= TITLE_LENGTH) {
    const end = text.indexOf("\n", leading);
    return { title: line, description: end < 0 ? [] : dropPrefix(segments, end + 1) };
  }
  const cut = [...line]
    .slice(0, TITLE_LENGTH - 1)
    .join("")
    .trimEnd();
  return { title: `${cut}…`, description: dropPrefix(segments, leading) };
}

export function isShort(video: Pick<Video, "width" | "height">): boolean {
  return video.height > video.width;
}

/** One of the account's own posts that carries a video, ready to list. */
export function normalizeVideoPost(value: unknown): Video | undefined {
  const post = asRecord(value);
  const uri = post?.uri;
  if (!post || typeof uri !== "string" || !uri.startsWith(POST_PREFIX)) return;
  const rkey = uri.slice(POST_PREFIX.length);
  if (!RKEY.test(rkey) || asRecord(post.author)?.did !== identity.did) return;
  const labels = post.labels;
  if (Array.isArray(labels) && labels.some((label) => asRecord(label)?.neg !== true)) return;
  const record = asRecord(post.record);
  const selfLabels = asRecord(record?.labels)?.values;
  if (!record || (Array.isArray(selfLabels) && selfLabels.length)) return;
  const embed = asRecord(post.embed);
  const view = embed?.$type === "app.bsky.embed.recordWithMedia#view" ? asRecord(embed.media) : embed;
  if (view?.$type !== "app.bsky.embed.video#view") return;
  const playlist = httpsUrl(view.playlist);
  const cid = view.cid;
  const date = record.createdAt;
  if (!playlist || typeof cid !== "string" || typeof date !== "string" || !Number.isFinite(Date.parse(date))) return;
  const ratio = asRecord(view.aspectRatio);
  const text = typeof record.text === "string" ? record.text : "";
  return {
    rkey,
    uri,
    cid,
    url: `https://bsky.app/profile/${identity.did}/post/${encodeURIComponent(rkey)}`,
    ...splitTitle(text, record.facets),
    date,
    playlist,
    thumbnail: httpsUrl(view.thumbnail),
    alt: typeof view.alt === "string" ? view.alt : "",
    width: dimension(ratio?.width, 16),
    height: dimension(ratio?.height, 9),
    likes: count(post.likeCount),
    reposts: count(post.repostCount),
    replies: count(post.replyCount),
  };
}

function normalizeChannel(value: unknown): VideoChannel | undefined {
  const author = asRecord(value);
  if (author?.did !== identity.did || typeof author.handle !== "string") return;
  return {
    handle: author.handle,
    name: typeof author.displayName === "string" && author.displayName.trim() ? author.displayName : author.handle,
    avatar: httpsUrl(author.avatar),
  };
}

/** A VOD playlist's length is the sum of its segment durations. */
export function playlistDuration(m3u8: string): number | undefined {
  let total = 0;
  let segments = 0;
  for (const match of m3u8.matchAll(/^#EXTINF:([\d.]+)/gm)) {
    total += Number(match[1]);
    segments++;
  }
  return segments && Number.isFinite(total) && total > 0 ? Math.round(total * 100) / 100 : undefined;
}

/** 0:19, 4:05, 1:02:03 */
export function formatDuration(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400],
  ["month", 30 * 86_400],
  ["week", 7 * 86_400],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];
const relative = new Intl.RelativeTimeFormat("en", { numeric: "always" });

/** 3 days ago, the way video sites date uploads */
export function timeAgo(date: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(date)) / 1000);
  for (const [unit, size] of units) if (seconds >= size) return relative.format(-Math.floor(seconds / size), unit);
  return "just now";
}

async function readDuration(video: Video, fetcher: ActivityFetch): Promise<number | undefined> {
  const base = video.playlist.split("?")[0].replace(/\/playlist\.m3u8$/, "");
  const signal = AbortSignal.timeout(5_000);
  // every upload has a 360p rendition; its playlist answers without the master's session id
  const response = await fetcher(`${base}/360p/video.m3u8`, { signal });
  return response.ok ? playlistDuration(await response.text()) : undefined;
}

async function addDurations(videos: Video[], known: Map<string, number>, fetcher: ActivityFetch): Promise<void> {
  const missing: Video[] = [];
  for (const video of videos) {
    const cached = known.get(video.cid);
    if (cached) video.duration = cached;
    else if (missing.length < DURATION_BUDGET) missing.push(video);
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONNECTIONS, missing.length) }, async () => {
      while (next < missing.length) {
        const video = missing[next++];
        try {
          video.duration = await readDuration(video, fetcher);
        } catch {}
      }
    }),
  );
}

async function fetchLibrary(fetcher: ActivityFetch, known: Map<string, number>): Promise<VideoLibrary> {
  const videos: Video[] = [];
  const seen = new Set<string>();
  let channel: VideoChannel | undefined;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${APPVIEW}/app.bsky.feed.getAuthorFeed`);
    url.searchParams.set("actor", identity.did);
    url.searchParams.set("filter", "posts_with_video");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Bluesky is unavailable");
    const body = asRecord(await response.json());
    if (!Array.isArray(body?.feed)) throw new Error("Invalid Bluesky feed");
    for (const item of body.feed) {
      const entry = asRecord(item);
      // reposts carry someone else's video
      if (entry?.reason) continue;
      const video = normalizeVideoPost(entry?.post);
      if (!video || seen.has(video.uri)) continue;
      channel ??= normalizeChannel(asRecord(entry?.post)?.author);
      seen.add(video.uri);
      videos.push(video);
    }
    cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : undefined;
    if (!cursor) break;
  }
  videos.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  await addDurations(videos, known, fetcher);
  return { channel: channel ?? fallbackChannel, videos };
}

/** Every video post, newest first. Served from cache, refreshed in the background once stale. */
export async function getVideoLibrary(options: Options = {}): Promise<VideoLibrary> {
  const { cache, waitUntil } = options;
  const now = options.now ?? Date.now();
  let cached: { at: number; library: VideoLibrary } | undefined;
  try {
    const raw = await cache?.get(KEY);
    if (raw) cached = JSON.parse(raw);
  } catch {}
  if (cached && now - cached.at < FRESH_MS) return cached.library;
  const refresh = () => {
    if (pending) return pending;
    const known = new Map<string, number>();
    for (const video of cached?.library.videos ?? []) if (video.duration) known.set(video.cid, video.duration);
    pending = (async () => {
      const library = await fetchLibrary(options.fetch ?? fetch, known);
      try {
        await cache?.put(KEY, JSON.stringify({ at: now, library }));
      } catch {}
      return library;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  if (cached && waitUntil) {
    waitUntil(refresh().catch(() => undefined));
    return cached.library;
  }
  try {
    return await refresh();
  } catch (error) {
    if (cached) return cached.library;
    throw error;
  }
}

export type WatchResult = { status: 200; video: Video; library: VideoLibrary } | { status: 404 | 503 };

/** One video and the rest of the library. A post newer than the cache is read on its own. */
export async function getWatchVideo(rkey: string, options: Options = {}): Promise<WatchResult> {
  if (!RKEY.test(rkey)) return { status: 404 };
  let library: VideoLibrary;
  try {
    library = await getVideoLibrary(options);
  } catch {
    return { status: 503 };
  }
  const listed = library.videos.find((video) => video.rkey === rkey);
  if (listed) return { status: 200, video: listed, library };
  const fetcher = options.fetch ?? fetch;
  try {
    const url = new URL(`${APPVIEW}/app.bsky.feed.getPosts`);
    url.searchParams.append("uris", `${POST_PREFIX}${rkey}`);
    const response = await fetcher(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { status: 503 };
    const body = asRecord(await response.json());
    if (!Array.isArray(body?.posts)) return { status: 503 };
    const video = normalizeVideoPost(body.posts[0]);
    if (!video) return { status: 404 };
    await addDurations([video], new Map(), fetcher);
    return { status: 200, video, library };
  } catch {
    return { status: 503 };
  }
}

/** Up next: what follows this video in the library, then what came before it. */
export function upNext(videos: Video[], current: Video): Video[] {
  const index = videos.findIndex((video) => video.uri === current.uri);
  if (index < 0) return videos;
  return [...videos.slice(index + 1), ...videos.slice(0, index)];
}
