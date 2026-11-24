import { isClipName, isHash } from "./archive";

/*
 * The footage the grade app offloaded to the archive, for the Footage tab's player to find a clip in and watch it.
 *
 * Each day's originals are a project of their own, `_originals-<day>`, its clips as `assets/<file>` and their transcripts
 * as `transcripts/<clip>.vtt` (and `.json`). The manifest is saved again after every clip, so a day has hundreds of
 * versions, and the grade app's `_settings` (grades, export records and the looks they use, as small LUTs) a new one each
 * time those change. Listings read only the latest, found without listing every version, and are kept in the Worker's
 * cache for a few minutes, so a listing costs the Worker little and the archive almost nothing.
 *
 * Files are read by their SHA-256 and streamed through as R2 hands them over, never read into the Worker: an original
 * runs to several gigabytes, and the Worker has 10 ms of CPU a request. A Range is passed on to R2, so a player seeks.
 */

/** What the player's routes read of the archive bucket: the real binding has all of it. */
export interface ArchiveReader {
  list(options: { prefix: string; cursor?: string; startAfter?: string }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{ body: ReadableStream; size?: number } | null>;
  head(key: string): Promise<{ size: number } | null>;
}
/** The Worker's cache (`caches.default`), or a stand-in. */
export interface ResponseCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

/** A clip of a shoot day as its listing has it: its file, its hash and size, and its transcript's hash if it has one. */
export interface ArchivedClip {
  file: string;
  sha256: string;
  size: number;
  vtt?: string;
}
export interface ArchivedDay {
  day: string;
  /** When the manifest listed was saved. */
  at: string | null;
  clips: ArchivedClip[];
}
/** The grade app's settings as last backed up: each file by its path, with its hash and size. */
export interface ArchivedSettings {
  at: string | null;
  files: Record<string, { sha256: string; size: number }>;
}

const DAY = 86_400_000;
/** How long a listing is kept in the Worker's cache. A clip offloaded meanwhile shows up after at most this long. */
export const LISTING_TTL = 300;
export const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

async function listing(archive: ArchiveReader, options: { prefix: string; startAfter?: string }) {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await archive.list({ ...options, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/**
 * The newest version of a project, by key. Versions are named by when they were saved, and R2 lists in name order with
 * no way to start from the end, so it asks for the last day's first, then further back, and lists every version only
 * when none is a year old. A day's manifest is saved hundreds of times; the settings' can be thousands.
 */
export async function latestVersion(archive: ArchiveReader, project: string, now = Date.now()) {
  const prefix = `projects/${project}/`;
  for (const back of [DAY, 7 * DAY, 30 * DAY, 365 * DAY, null]) {
    const startAfter = back === null ? undefined : `${prefix}${new Date(now - back).toISOString()}`;
    const keys = await listing(archive, { prefix, startAfter });
    const latest = keys
      .filter((key) => key.endsWith(".json"))
      .sort()
      .pop();
    if (latest) return { key: latest, at: latest.slice(prefix.length, -".json".length) };
  }
  return null;
}

type ManifestFile = { path: string; sha256: string; size: number; mtime: number };
async function readVersion(archive: ArchiveReader, key: string) {
  const object = await archive.get(key);
  if (!object) return [];
  const { files } = (await new Response(object.body).json()) as { files?: ManifestFile[] };
  return Array.isArray(files) ? files : [];
}

/** A day's clips as its latest manifest lists them, in the order they were shot, each with its transcript if filed. */
export async function archivedDay(archive: ArchiveReader, day: string, now = Date.now()): Promise<ArchivedDay> {
  const latest = await latestVersion(archive, `_originals-${day}`, now);
  if (!latest) return { day, at: null, clips: [] };
  const files = await readVersion(archive, latest.key);
  const transcripts = new Map<string, string>();
  for (const { path, sha256 } of files) {
    const clip = /^transcripts\/([^/]+)\.vtt$/.exec(path)?.[1];
    if (clip) transcripts.set(clip, sha256);
  }
  const clips = files
    // The videos the grade app offloads (scripts/grade/media.mjs's VIDEO): anything else in assets/ isn't a clip.
    .filter(({ path, sha256 }) => /^assets\/[^/]+\.(mp4|mov)$/i.test(path) && isHash(sha256))
    .map(({ path, sha256, size }) => {
      const file = path.slice("assets/".length);
      const vtt = transcripts.get(file.replace(/\.[^.]+$/, ""));
      return { file, sha256, size, ...(vtt ? { vtt } : {}) };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
  return { day, at: latest.at, clips };
}

/** The grade app's settings as last backed up (`_settings`): its grades, export records and looks. */
export async function archivedSettings(archive: ArchiveReader, now = Date.now()): Promise<ArchivedSettings> {
  const latest = await latestVersion(archive, "_settings", now);
  if (!latest) return { at: null, files: {} };
  const files: ArchivedSettings["files"] = {};
  for (const { path, sha256, size } of await readVersion(archive, latest.key))
    if (isHash(sha256)) files[path] = { sha256, size };
  return { at: latest.at, files };
}

/**
 * A listing, from the Worker's cache while it's there and built otherwise. The cache keeps it under an address of its own
 * on the site (only the Worker reaches its cache), for `LISTING_TTL`; the browser keeps it a minute.
 */
async function cachedListing(
  cache: ResponseCache | null,
  origin: string,
  name: string,
  build: () => Promise<unknown>,
): Promise<Response> {
  const headers = { "Content-Type": "application/json", "Cache-Control": "private, max-age=60" };
  const key = `${origin}/api/publisher/archive/cached/${name}`;
  const hit = await cache?.match(key);
  if (hit) return new Response(hit.body, { headers });
  const text = JSON.stringify(await build());
  await cache?.put(
    key,
    new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${LISTING_TTL}` } }),
  );
  return new Response(text, { headers });
}

/* ── files, by hash, with Range ─────────────────────────────────────────── */

const TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  vtt: "text/vtt; charset=utf-8",
  json: "application/json",
  cube: "text/plain; charset=utf-8",
  jpg: "image/jpeg",
  png: "image/png",
};
const typeOf = (name: string) => TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/**
 * The bytes a Range header asks for, of a file of `size`: null for the whole file (no Range, or a unit other than
 * bytes, which is ignored), or "unsatisfiable" for one that can't be served (past the end, backwards, malformed, or
 * several at once: a player asks for one).
 */
export function byteRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | null | "unsatisfiable" {
  if (!header) return null;
  const spec = /^\s*bytes\s*=\s*(.*)$/i.exec(header)?.[1];
  if (spec === undefined) return null;
  const match = /^(\d*)-(\d*)$/.exec(spec.trim());
  if (!match || (!match[1] && !match[2])) return "unsatisfiable";
  if (!match[1]) {
    const suffix = Math.min(Number(match[2]), size);
    return suffix > 0 ? { offset: size - suffix, length: suffix } : "unsatisfiable";
  }
  const first = Number(match[1]);
  const last = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (first >= size || (match[2] && Number(match[2]) < first)) return "unsatisfiable";
  return { offset: first, length: last - first + 1 };
}

/**
 * A file of the archive, by its hash, named for its type: the whole of it, or the part a Range asks for (206), streamed
 * straight from R2. A blob never changes, so the browser may keep it.
 */
async function fileResponse(archive: ArchiveReader, request: Request, hash: string, name: string): Promise<Response> {
  const key = `blobs/${hash}`;
  const stored = await archive.head(key);
  if (!stored)
    return Response.json({ error: "Not in the archive" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const { size } = stored;
  const range = byteRange(request.headers.get("Range"), size);
  if (range === "unsatisfiable")
    return Response.json(
      { error: "That range isn't in the file" },
      { status: 416, headers: { "Content-Range": `bytes */${size}`, "Cache-Control": "no-store" } },
    );
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": typeOf(name),
    "Content-Length": String(range ? range.length : size),
    "Cache-Control": "private, max-age=31536000, immutable",
    ETag: `"${hash}"`,
  });
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
  const status = range ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });
  // An empty file, or an empty part of one, has nothing to stream.
  if (!size) return new Response(null, { status, headers });
  const object = await archive.get(key, range ? { range } : undefined);
  if (!object)
    return Response.json({ error: "Not in the archive" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(object.body, { status, headers });
}

/**
 * The player's routes, the caller already checked as the owner; anything else is null.
 *
 *   GET archive/days/<day>         the day's clips (ArchivedDay)
 *   GET archive/settings           the grade app's backed-up settings (ArchivedSettings)
 *   GET archive/files/<sha256>/<name>  a file, typed by its name's extension, with Range (HEAD too)
 */
export async function archiveTabResponse(
  path: string,
  request: Request,
  { archive, cache = null }: { archive: ArchiveReader; cache?: ResponseCache | null },
  now = Date.now(),
): Promise<Response | null> {
  const method = request.method;
  const origin = new URL(request.url).origin;
  const file = /^archive\/files\/([^/]+)\/([^/]+)$/.exec(path);
  if (file && (method === "GET" || method === "HEAD")) {
    if (!isHash(file[1]) || !isClipName(file[2]))
      return Response.json({ error: "Invalid file" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    return fileResponse(archive, request, file[1], file[2]);
  }
  if (method !== "GET") return null;
  const day = /^archive\/days\/([^/]+)$/.exec(path)?.[1];
  if (day !== undefined) {
    if (!isDay(day))
      return Response.json({ error: "Invalid day" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    return cachedListing(cache, origin, `days/${day}`, () => archivedDay(archive, day, now));
  }
  if (path === "archive/settings")
    return cachedListing(cache, origin, "settings", () => archivedSettings(archive, now));
  return null;
}
