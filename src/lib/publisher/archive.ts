import type { NewsletterDB } from "../newsletter/types";
import { type MediaBucket, type Post, postMedia, postUploads, validId } from "./server";
import { UPLOAD_LIFETIME } from "./schedule";

/**
 * The archive: an R2 bucket on the Infrequent Access class with no expiry, beside the media bucket whose uploads
 * expire 31 days after they go up. It keeps two things:
 *
 *   media/<upload id>        a copy of each upload a queued post uses, made when it's queued, so a post's video is
 *                            still there to retry or crosspost once the media bucket has expired it
 *   blobs/<sha256>           the files of finished projects, each stored once however many projects hold it
 *   projects/<name>/<at>.json  a project's files as archived at that time: path, sha256, size and modified time each
 *   ledger/footage.json      the footage ledger: every clip the grade app has seen, whether it's graded, and where its
 *                            original and graded copies are. Rewritten as it changes, so it's on the Standard class.
 */
export interface ArchiveBucket {
  put(
    key: string,
    body: ReadableStream | ArrayBuffer | string,
    options?: {
      httpMetadata?: { contentType?: string };
      sha256?: string;
      storageClass?: "Standard" | "InfrequentAccess";
    },
  ): Promise<unknown>;
  get(key: string): Promise<{
    body: ReadableStream;
    httpMetadata?: { contentType?: string };
    size?: number;
    uploaded?: Date;
  } | null>;
  head(key: string): Promise<{ size: number; etag?: string; checksums?: { md5?: ArrayBuffer } } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: { key: string; size: number; uploaded: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
  createMultipartUpload(key: string): Promise<{ uploadId: string }>;
  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): {
    uploadPart(partNumber: number, body: ReadableStream | ArrayBuffer): Promise<{ partNumber: number; etag: string }>;
    complete(parts: { partNumber: number; etag: string }[]): Promise<unknown>;
    abort(): Promise<void>;
  };
}

export class ArchiveError extends Error {}

/**
 * A body R2 takes without the Worker reading it: the stream itself, held to exactly `length` bytes, which the runtime
 * pipes to R2. Read into memory instead, a 64 MiB part cost the Worker about 200 ms of CPU, and Workers Free allows
 * 10 ms a request: an archive run's parts made Cloudflare refuse requests with 503s (error 1102), the laptop helper's
 * among them. A stream that turns out shorter or longer than `length` fails the put.
 */
export function sized(body: ReadableStream | null, length: number): ReadableStream | ArrayBuffer {
  if (!body || length === 0) return new ArrayBuffer(0);
  const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream }).FixedLengthStream;
  // Outside a Worker (tests) there's no FixedLengthStream, and the stream goes as it is.
  if (!Fixed) return body;
  const { readable, writable } = new Fixed(length);
  body.pipeTo(writable).catch(() => {});
  return readable;
}

export const LEDGER = "ledger/footage.json";
/** A ledger clip's small picture, by its name without extension (DJI_20261111161230_0258_D, IMG_4857). */
export const ledgerThumbKey = (clip: string) => `ledger/thumbs/${clip}.jpg`;
export const isClipName = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-][\w.-]{0,119}$/.test(value);
const mediaKey = (id: string) => `media/${id}`;
const blobKey = (hash: string) => `blobs/${hash}`;
export const isHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const isProjectName = (value: unknown): value is string =>
  typeof value === "string" && /^[\w][\w.-]{0,119}$/.test(value);

/** Runs `work` on each item, a few at a time. */
async function each<T>(items: T[], work: (item: T) => Promise<void>, at = 16): Promise<void> {
  for (let i = 0; i < items.length; i += at) await Promise.all(items.slice(i, i + at).map(work));
}

/**
 * The media bucket as the publisher sees it once there's an archive: an upload the media bucket has expired is read
 * from its archived copy, so a post queued since archiving started never runs out of media. Deleting an upload deletes
 * its copy too. Drafts and other keys that aren't upload ids are the media bucket's alone.
 */
export function withArchive(media: MediaBucket, archive: ArchiveBucket | undefined): MediaBucket {
  if (!archive) return media;
  return {
    put: (key, body, options) => media.put(key, body, options),
    get: async (key) => (await media.get(key)) ?? (validId(key) ? await archive.get(mediaKey(key)) : null),
    head: async (key) => (await media.head(key)) ?? (validId(key) ? await archive.head(mediaKey(key)) : null),
    delete: async (keys) => {
      await media.delete(keys);
      const ids = [keys].flat().filter(validId);
      if (ids.length) await archive.delete(ids.map(mediaKey));
    },
    list: (options) => media.list(options),
  };
}

/** Which of `ids` have an archived copy. */
export async function archivedMedia(archive: ArchiveBucket | undefined, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (!archive) return found;
  await each([...new Set(ids)].filter(validId), async (id) => {
    if (await archive.head(mediaKey(id))) found.add(id);
  });
  return found;
}

/** Answers which of a list of upload ids are archived; absent when there's no archive. */
export type ArchivedCheck = (ids: string[]) => Promise<Set<string>>;
export const archivedCheck = (archive: ArchiveBucket | undefined): ArchivedCheck | undefined =>
  archive && ((ids) => archivedMedia(archive, ids));

/**
 * Copies `ids` from the media bucket to the archive, each that isn't there yet and hasn't expired. Uploads are at most
 * 90 MB, so each is read whole. Says how many it copied, and how many were already gone.
 */
export async function archiveUploads(
  media: Pick<MediaBucket, "get">,
  archive: ArchiveBucket,
  ids: string[],
): Promise<{ copied: number; gone: number }> {
  let copied = 0;
  let gone = 0;
  for (const id of new Set(ids)) {
    if (!validId(id) || (await archive.head(mediaKey(id)))) continue;
    const object = await media.get(id);
    if (!object) {
      gone++;
      continue;
    }
    // Streamed bucket to bucket: read whole, a 90 MB video would cost far more CPU than a request has.
    const body =
      object.size === undefined ? await new Response(object.body).arrayBuffer() : sized(object.body, object.size);
    await archive.put(mediaKey(id), body, { httpMetadata: { contentType: object.httpMetadata?.contentType } });
    copied++;
  }
  return { copied, gone };
}

/** Archives the uploads of the post `job`. */
export async function archivePost(
  db: NewsletterDB,
  media: Pick<MediaBucket, "get">,
  archive: ArchiveBucket,
  job: string,
): Promise<{ copied: number; gone: number }> {
  const row = await db
    .prepare("SELECT payload FROM publisher_jobs WHERE id = ?")
    .bind(job)
    .first<{ payload: string }>();
  if (!row) return { copied: 0, gone: 0 };
  return archiveUploads(media, archive, postMedia(JSON.parse(row.payload) as Post));
}

/**
 * Archives the uploads of every post queued while its uploads could still be in the media bucket: a sweep that catches
 * a post whose copy didn't finish when it was queued, and the posts queued before the archive existed.
 */
export async function archiveRecentPosts(
  db: NewsletterDB,
  media: Pick<MediaBucket, "get">,
  archive: ArchiveBucket,
  now = Date.now(),
): Promise<{ posts: number; copied: number; gone: number }> {
  const { results } = await db
    .prepare("SELECT payload FROM publisher_jobs WHERE created_at >= ?")
    .bind(now - UPLOAD_LIFETIME)
    .all<{ payload: string }>();
  let copied = 0;
  let gone = 0;
  for (const { payload } of results) {
    const done = await archiveUploads(media, archive, postMedia(JSON.parse(payload) as Post));
    copied += done.copied;
    gone += done.gone;
  }
  return { posts: results.length, copied, gone };
}

/* ── posts the laptop's files went out as ─────────────────────────────── */

const isMd5 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((n) => n.toString(16).padStart(2, "0")).join("");

/** An object's MD5 as R2 keeps it: the checksum R2 computes for an object put whole, as every upload is, or else an
 * etag that is one. */
function md5Of(object: unknown): string | null {
  const { checksums, etag } = (object ?? {}) as { checksums?: { md5?: ArrayBuffer }; etag?: string };
  if (checksums?.md5) return hex(checksums.md5);
  return isMd5(etag) ? etag : null;
}

/** A post that holds a file the laptop asked about. */
export interface PostedUpload {
  md5: string;
  job: string;
  queuedAt: number;
  platforms: { platform: string; state: string }[];
}

/**
 * Which of `md5s`, the MD5s of files on the laptop, are videos of a post that went out or is set to: one with a
 * destination that succeeded or is queued or working, as a scheduled post waits. A post whose every destination failed
 * doesn't count. Each video's MD5 is read from the media bucket, or from the archive's copy once that has expired.
 */
export async function postedUploads(
  db: NewsletterDB,
  media: Pick<MediaBucket, "head">,
  archive: ArchiveBucket,
  md5s: unknown,
): Promise<PostedUpload[]> {
  if (!Array.isArray(md5s) || md5s.length > 1000 || !md5s.every(isMd5))
    throw new ArchiveError("Send up to 1000 MD5s, each as 32 hexadecimal digits");
  const wanted = new Set(md5s);
  const { results } = await db
    .prepare(
      `SELECT j.id, j.payload, j.created_at, t.platform, t.state FROM publisher_jobs j
       JOIN publisher_targets t ON t.job_id = j.id
       WHERE j.id IN (SELECT job_id FROM publisher_targets WHERE state IN ('queued','working','succeeded'))`,
    )
    .all<{ id: string; payload: string; created_at: number; platform: string; state: string }>();
  const jobs = new Map<string, { payload: string; queuedAt: number; platforms: PostedUpload["platforms"] }>();
  for (const row of results) {
    const job = jobs.get(row.id) ?? { payload: row.payload, queuedAt: row.created_at, platforms: [] };
    job.platforms.push({ platform: row.platform, state: row.state });
    jobs.set(row.id, job);
  }
  const videos = [...jobs].flatMap(([job, { payload, queuedAt, platforms }]) =>
    postUploads(JSON.parse(payload) as Post)
      .filter((upload) => upload.kind === "video" && validId(upload.id))
      .map((upload) => ({ upload: upload.id, job, queuedAt, platforms })),
  );
  const posted: PostedUpload[] = [];
  await each(videos, async ({ upload, job, queuedAt, platforms }) => {
    const md5 = md5Of((await media.head(upload)) ?? (await archive.head(mediaKey(upload))));
    if (md5 && wanted.has(md5)) posted.push({ md5, job, queuedAt, platforms });
  });
  return posted;
}

/* ── projects ──────────────────────────────────────────────────────────── */

/** The largest part or whole file one request carries: under the Worker's 100 MB request limit. */
export const MAX_ARCHIVE_PART = 96 * 1024 * 1024;

/** Which of `hashes` the archive doesn't hold yet. */
export async function missingBlobs(archive: ArchiveBucket, hashes: unknown): Promise<string[]> {
  if (!Array.isArray(hashes) || hashes.length > 2000 || !hashes.every(isHash)) throw new ArchiveError("Invalid hashes");
  const missing: string[] = [];
  await each([...new Set(hashes)], async (hash) => {
    if (!(await archive.head(blobKey(hash)))) missing.push(hash);
  });
  return missing.sort();
}

/** Stores a file whole. R2 checks it against its hash and refuses it when they differ. */
export async function putBlob(archive: ArchiveBucket, hash: string, body: ReadableStream | ArrayBuffer): Promise<void> {
  if (!isHash(hash)) throw new ArchiveError("Invalid hash");
  try {
    await archive.put(blobKey(hash), body, { sha256: hash });
  } catch (error) {
    if (error instanceof Error && /checksum/i.test(error.message))
      throw new ArchiveError("The file doesn't match its hash");
    throw error;
  }
}

export async function startBlob(archive: ArchiveBucket, hash: unknown): Promise<string> {
  if (!isHash(hash)) throw new ArchiveError("Invalid hash");
  return (await archive.createMultipartUpload(blobKey(hash))).uploadId;
}

export async function putBlobPart(
  archive: ArchiveBucket,
  hash: string,
  upload: string | null,
  part: number,
  body: ReadableStream | ArrayBuffer,
): Promise<{ partNumber: number; etag: string }> {
  if (!isHash(hash) || !upload || !Number.isInteger(part) || part < 1 || part > 10_000)
    throw new ArchiveError("Invalid upload");
  return archive.resumeMultipartUpload(blobKey(hash), upload).uploadPart(part, body);
}

export async function finishBlob(archive: ArchiveBucket, hash: string, input: unknown): Promise<void> {
  const { upload, parts } = (input ?? {}) as { upload?: unknown; parts?: unknown };
  const valid =
    Array.isArray(parts) &&
    parts.length > 0 &&
    parts.every((p) => p && Number.isInteger(p.partNumber) && typeof p.etag === "string" && p.etag.length < 200);
  if (!isHash(hash) || typeof upload !== "string" || !valid) throw new ArchiveError("Invalid upload");
  await archive.resumeMultipartUpload(blobKey(hash), upload).complete(parts as { partNumber: number; etag: string }[]);
}

export async function abortBlob(archive: ArchiveBucket, hash: string, upload: string | null): Promise<void> {
  if (!isHash(hash) || !upload) throw new ArchiveError("Invalid upload");
  await archive.resumeMultipartUpload(blobKey(hash), upload).abort();
}

export async function getBlob(archive: ArchiveBucket, hash: string) {
  if (!isHash(hash)) throw new ArchiveError("Invalid hash");
  return archive.get(blobKey(hash));
}

/**
 * A project's files as archived: each by its path in the project, with `/` between folders. `folders` are the ones that
 * hold nothing, kept because a folder can matter empty: Studio's history is a git repository, and git needs its
 * `objects` and `refs` folders there.
 */
export interface Manifest {
  name: string;
  archivedAt: string;
  files: { path: string; sha256: string; size: number; mtime: number }[];
  folders: string[];
}

/** A path inside a project: relative, and never climbing out of it. */
const isPath = (path: unknown): path is string =>
  typeof path === "string" &&
  path.length > 0 &&
  path.length < 1000 &&
  !path.startsWith("/") &&
  !path.split("/").includes("..");

/**
 * Keeps a project's manifest, once every file it names is in the archive, under the time it was archived. Refuses one
 * that names a file the archive doesn't hold, so a manifest never points at something missing.
 */
export async function saveManifest(archive: ArchiveBucket, name: string, input: unknown, now = new Date()) {
  if (!isProjectName(name)) throw new ArchiveError("Invalid project name");
  const { files, folders = [] } = (input ?? {}) as { files?: unknown; folders?: unknown };
  const valid =
    Array.isArray(files) &&
    files.length <= 50_000 &&
    files.every(
      (f) =>
        f &&
        isPath(f.path) &&
        isHash(f.sha256) &&
        Number.isSafeInteger(f.size) &&
        f.size >= 0 &&
        Number.isFinite(f.mtime),
    ) &&
    Array.isArray(folders) &&
    folders.length <= 50_000 &&
    folders.every(isPath);
  if (!valid) throw new ArchiveError("Invalid manifest");
  const listed = files as Manifest["files"];
  const missing = await missingBlobs(
    archive,
    listed.map((f) => f.sha256),
  );
  if (missing.length) throw new ArchiveError(`${missing.length} of its files aren't in the archive yet`);
  const manifest: Manifest = {
    name,
    archivedAt: now.toISOString(),
    files: listed.map(({ path, sha256, size, mtime }) => ({ path, sha256, size, mtime })),
    folders: folders as string[],
  };
  const key = `projects/${name}/${manifest.archivedAt}.json`;
  await archive.put(key, JSON.stringify(manifest), { httpMetadata: { contentType: "application/json" } });
  return { key, files: manifest.files.length, bytes: manifest.files.reduce((sum, f) => sum + f.size, 0) };
}

async function listAll(archive: ArchiveBucket, prefix: string) {
  const objects: { key: string; size: number; uploaded: Date }[] = [];
  let cursor: string | undefined;
  do {
    const page = await archive.list({ prefix, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

/** Each archived project, by name, with when it was last archived and how many times. */
export async function listProjects(archive: ArchiveBucket) {
  const projects = new Map<string, { name: string; archivedAt: string; versions: number }>();
  for (const { key } of await listAll(archive, "projects/")) {
    const [, name, file] = key.split("/");
    const at = file?.replace(/\.json$/, "");
    if (!name || !at) continue;
    const known = projects.get(name);
    projects.set(name, {
      name,
      archivedAt: known && known.archivedAt > at ? known.archivedAt : at,
      versions: (known?.versions ?? 0) + 1,
    });
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A project's manifest as last archived, or as archived at `at`. Null when there's none. */
export async function readManifest(archive: ArchiveBucket, name: string, at?: string | null): Promise<Manifest | null> {
  if (!isProjectName(name)) throw new ArchiveError("Invalid project name");
  const latest = async () =>
    (await listAll(archive, `projects/${name}/`))
      .map((o) => o.key)
      .sort()
      .pop();
  const key = at ? `projects/${name}/${at}.json` : await latest();
  if (!key) return null;
  const object = await archive.get(key);
  return object ? ((await new Response(object.body).json()) as Manifest) : null;
}

/* ── the laptop's archive requests (helper/archive/…, behind the pairing token) ── */

/**
 * Answers a request under `helper/archive/`, `rest` being what follows:
 *
 *   POST   missing                    { blobs: [sha256] } → { missing: [sha256] }
 *   PUT    blobs/<sha256>             a file of up to 96 MiB, whole
 *   GET    blobs/<sha256>             a file
 *   POST   uploads                    { blob } → { upload }, for a larger file sent in parts
 *   PUT    uploads/<sha256>/<n>?upload=…  part n (all but the last the same size) → { partNumber, etag }
 *   POST   uploads/<sha256>/complete  { upload, parts }
 *   DELETE uploads/<sha256>?upload=…  gives a part-sent file up
 *   PUT    projects/<name>            a manifest, once its files are in → { key, files, bytes }
 *   GET    projects                   { projects: [{ name, archivedAt, versions }] }
 *   GET    projects/<name>?at=…       the manifest as last archived, or as archived at that time
 *   POST   media                      archives the uploads of every post queued in the last 31 days
 *   POST   posted                     { md5s: [md5] } → { posted: [{ md5, job, queuedAt, platforms }] }: the posts,
 *                                      published or scheduled, whose videos are those files
 *   GET    ledger                     the footage ledger, as the grade app last sent it (404 before the first)
 *   PUT    ledger                     the footage ledger, whole: the grade app is its only writer
 *   PUT    ledger/thumbs/<clip>       a clip's small picture (JPEG), for the composer's Footage tab
 */
export async function archiveResponse(
  rest: string,
  request: Request,
  { db, media, archive }: { db: NewsletterDB; media: Pick<MediaBucket, "get" | "head">; archive: ArchiveBucket },
): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
  const method = request.method;
  const params = new URL(request.url).searchParams;
  const [kind, key, part] = rest.split("/");
  // The file, streamed on to R2 at its declared length (see `sized`). An empty file is a file too (OpenFilm keeps an
  // empty .film/opened): a length of 0 is a length.
  const body = () => {
    const declared = request.headers.get("Content-Length");
    const length = Number(declared);
    if (declared === null || !Number.isSafeInteger(length) || length < 0) throw new ArchiveError("Send its length");
    if (length > MAX_ARCHIVE_PART) throw new ArchiveError("Send at most 96 MiB a request");
    return sized(request.body, length);
  };
  try {
    if (rest === "missing" && method === "POST")
      return json({ missing: await missingBlobs(archive, ((await request.json()) as { blobs?: unknown }).blobs) });
    if (kind === "blobs" && key && part === undefined) {
      if (method === "PUT") {
        await putBlob(archive, key, body());
        return json({ ok: true }, 201);
      }
      if (method === "GET") {
        const object = await getBlob(archive, key);
        if (!object) return json({ error: "Not in the archive" }, 404);
        return new Response(object.body, {
          headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": String(object.size) },
        });
      }
    }
    if (rest === "uploads" && method === "POST")
      return json({ upload: await startBlob(archive, ((await request.json()) as { blob?: unknown }).blob) }, 201);
    if (kind === "uploads" && key) {
      if (part === "complete" && method === "POST") {
        await finishBlob(archive, key, await request.json());
        return json({ ok: true });
      }
      if (part && method === "PUT")
        return json(await putBlobPart(archive, key, params.get("upload"), Number(part), body()));
      if (part === undefined && method === "DELETE") {
        await abortBlob(archive, key, params.get("upload"));
        return json({ ok: true });
      }
    }
    if (rest === "projects" && method === "GET") return json({ projects: await listProjects(archive) });
    if (kind === "projects" && key && part === undefined) {
      if (method === "PUT") return json(await saveManifest(archive, key, await request.json()), 201);
      if (method === "GET") {
        const manifest = await readManifest(archive, key, params.get("at"));
        return manifest ? json(manifest) : json({ error: "No such archived project" }, 404);
      }
    }
    if (rest === "ledger" && method === "GET") {
      const object = await archive.get(LEDGER);
      if (!object) return json({ error: "No ledger yet" }, 404);
      return new Response(object.body, { headers: { ...headers, "Content-Type": "application/json" } });
    }
    // Streamed on like the archive's files, so a ledger of thousands of clips costs the Worker no CPU to read.
    if (rest === "ledger" && method === "PUT") {
      await archive.put(LEDGER, body(), {
        httpMetadata: { contentType: "application/json" },
        storageClass: "Standard",
      });
      return json({ ok: true });
    }
    if (kind === "ledger" && key === "thumbs" && part !== undefined && method === "PUT") {
      if (!isClipName(part)) throw new ArchiveError("Invalid clip");
      await archive.put(ledgerThumbKey(part), body(), {
        httpMetadata: { contentType: "image/jpeg" },
        storageClass: "Standard",
      });
      return json({ ok: true });
    }
    if (rest === "media" && method === "POST") return json(await archiveRecentPosts(db, media, archive));
    if (rest === "posted" && method === "POST") {
      const { md5s } = (await request.json()) as { md5s?: unknown };
      return json({ posted: await postedUploads(db, media, archive, md5s) });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof ArchiveError) return json({ error: error.message }, 400);
    if (error instanceof SyntaxError) return json({ error: "Invalid request" }, 400);
    throw error;
  }
}
