// Archives a finished OpenFilm project to the site's archive bucket, and brings one back.
//
// Each file is stored once by its SHA-256, however many projects hold it (a film's Chinese version, in its zh/ folder,
// is mostly clones of the original's media and costs nothing), with a manifest per project naming its files. Studio's
// .film/cache is left out: Studio makes it again. Everything goes through the site's helper API on the laptop's
// pairing token, so the archive needs no keys of its own.
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** A larger file goes up in parts of this size, the last smaller: under the Worker's 100 MB request limit. */
export const PART = 64 * 1024 * 1024;
/** Where restored projects go when no folder is named. */
export const PROJECTS = join(homedir(), "Movies/OpenFilm/Projects");

const isName = (name) => /^[\w][\w.-]{0,119}$/.test(name);

/** Whether a file or folder, by its path in the project, stays out of the archive. */
export function skipped(path) {
  return basename(path) === ".DS_Store" || /(^|\/)\.film\/cache(\/|$)/.test(path);
}

/**
 * A project's files, each by its path in it with `/` between folders, its size and when it last changed; and its
 * folders that hold nothing kept, which can matter empty (git needs Studio's history's `objects` and `refs`).
 */
export async function projectContents(root) {
  const files = [];
  const folders = [];
  /** Walks `dir` and says how many things in it are kept. */
  async function walk(dir) {
    let kept = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const path = abs
        .slice(root.length + 1)
        .split(sep)
        .join("/");
      if (skipped(path)) continue;
      // A link to media kept elsewhere is archived as what it leads to; one that leads nowhere is left out.
      const info = entry.isSymbolicLink() ? await stat(abs).catch(() => null) : entry;
      if (!info) continue;
      if (info.isDirectory()) {
        if (!(await walk(abs))) folders.push(path);
        kept++;
      } else if (info.isFile()) {
        const { size, mtimeMs } = await stat(abs);
        files.push({ path, abs, size, mtime: Math.round(mtimeMs) });
        kept++;
      }
    }
    return kept;
  }
  await walk(root);
  const byPath = (a, b) => a.localeCompare(b);
  return { files: files.sort((a, b) => byPath(a.path, b.path)), folders: folders.sort(byPath) };
}

export async function hashFile(abs) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(abs, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}

/** The type a request says it carries. */
function contentType(method, body) {
  if (body !== undefined) return "application/octet-stream";
  // One that isn't a GET says a type even without a body (a DELETE): Astro refuses one without as a cross-site form
  // submission.
  if (method !== "GET") return "application/json";
  return undefined;
}

/**
 * The helper API's archive routes, retrying a request that fails on the way a couple of times, and saying so: a 503
 * here can be Cloudflare refusing the Worker for using too much CPU, which the helper's requests then meet too.
 */
export function archiveClient({ origin, token, fetcher = fetch, log = () => {} }) {
  return async function request(path, { method = "GET", json, body, raw = false } = {}) {
    const type = contentType(method, body);
    const route = path.split("?")[0];
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetcher(`${origin}/api/publisher/helper/archive/${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(type ? { "Content-Type": type } : {}) },
          body: json !== undefined ? JSON.stringify(json) : body,
          signal: AbortSignal.timeout(10 * 60_000),
        });
      } catch (error) {
        if (attempt < 3) {
          log(`${method} ${route} failed (${error.message}); trying again`);
          continue;
        }
        throw error;
      }
      if (response.ok) return raw ? response : response.json();
      const data = await response.json().catch(() => ({}));
      if (response.status >= 500 && attempt < 3) {
        log(`${method} ${route} answered ${response.status}; trying again`);
        continue;
      }
      throw new Error(data.error || `Archive request failed (${response.status})`);
    }
  };
}

async function readRange(abs, offset, length) {
  const file = await open(abs);
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, offset);
    if (bytesRead !== length) throw new Error(`${abs} changed while it was being archived`);
    return bytes;
  } finally {
    await file.close();
  }
}

/** Sends one file: whole when it fits a request, else in parts, three at a time. */
async function upload(request, { abs, size }, hash, part) {
  if (size <= part) {
    await request(`blobs/${hash}`, { method: "PUT", body: await readRange(abs, 0, size) });
    return;
  }
  const { upload: id } = await request("uploads", { method: "POST", json: { blob: hash } });
  const count = Math.ceil(size / part);
  const parts = [];
  try {
    for (let first = 1; first <= count; first += 3) {
      const batch = [];
      for (let n = first; n < first + 3 && n <= count; n++) {
        const offset = (n - 1) * part;
        batch.push(
          readRange(abs, offset, Math.min(part, size - offset)).then((body) =>
            request(`uploads/${hash}/${n}?upload=${encodeURIComponent(id)}`, { method: "PUT", body }),
          ),
        );
      }
      parts.push(...(await Promise.all(batch)));
    }
    await request(`uploads/${hash}/complete`, { method: "POST", json: { upload: id, parts } });
  } catch (error) {
    await request(`uploads/${hash}?upload=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    throw error;
  }
}

const gb = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;

/**
 * Archives the project in `dir`: sends each file the archive doesn't hold yet, then its manifest, which the archive
 * keeps only once every file it names is there. Then, unless `keepCache`, removes Studio's caches, which it makes again.
 */
export async function archiveProject(
  dir,
  { origin, token, fetcher = fetch, log = () => {}, keepCache = false, part = PART },
) {
  const root = resolve(dir);
  const name = basename(root);
  if (!isName(name)) throw new Error(`${name} isn't a name the archive takes: letters, digits, . _ and - only`);
  const request = archiveClient({ origin, token, fetcher, log });
  const { files, folders } = await projectContents(root);
  if (!files.length) throw new Error(`${root} holds no files to archive`);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  log(`${name}: hashing ${files.length} files, ${gb(total)}`);
  const byHash = new Map();
  for (const file of files) {
    file.sha256 = await hashFile(file.abs);
    if (!byHash.has(file.sha256)) byHash.set(file.sha256, file);
  }
  const missing = [];
  const hashes = [...byHash.keys()];
  for (let i = 0; i < hashes.length; i += 1000)
    missing.push(...(await request("missing", { method: "POST", json: { blobs: hashes.slice(i, i + 1000) } })).missing);
  const sending = missing.map((hash) => byHash.get(hash));
  const sent = sending.reduce((sum, file) => sum + file.size, 0);
  log(
    `${name}: ${byHash.size - missing.length} of ${byHash.size} files already archived; sending ${missing.length}, ${gb(
      sent,
    )}`,
  );
  for (const file of sending) {
    if (file.size > part) log(`${name}: sending ${file.path}, ${gb(file.size)}`);
    await upload(request, file, file.sha256, part);
  }
  const saved = await request(`projects/${name}`, {
    method: "PUT",
    json: { files: files.map(({ path, sha256, size, mtime }) => ({ path, sha256, size, mtime })), folders },
  });
  let cleared = 0;
  if (!keepCache)
    for (const cache of [join(root, ".film/cache"), join(root, "zh/.film/cache")]) {
      const before = await folderSize(cache);
      if (before === null) continue;
      await rm(cache, { recursive: true, force: true });
      cleared += before;
    }
  return { name, key: saved.key, files: files.length, bytes: total, sent, cleared };
}

async function folderSize(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let size = 0;
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) size += (await folderSize(abs)) ?? 0;
    else if (entry.isFile()) size += (await stat(abs)).size;
  }
  return size;
}

/** Each archived project, with when it was last archived. */
export async function listArchived({ origin, token, fetcher = fetch }) {
  return (await archiveClient({ origin, token, fetcher })("projects")).projects;
}

/**
 * Brings the project `name` back into `dest` (a folder that's missing or empty), as last archived or as archived `at`
 * a time. Each file is fetched once and checked against its hash; a file the project holds twice is a clone of the
 * first, as the copies were. File times are restored, which is how OpenFilm knows a transcript still matches its media.
 */
export async function restoreProject(name, { dest, at, origin, token, fetcher = fetch, log = () => {} }) {
  if (!isName(name)) throw new Error("Name an archived project");
  const request = archiveClient({ origin, token, fetcher, log });
  const manifest = await request(`projects/${name}${at ? `?at=${encodeURIComponent(at)}` : ""}`);
  const root = resolve(dest ?? join(PROJECTS, name));
  const present = await readdir(root).catch(() => []);
  if (present.some((entry) => entry !== ".DS_Store")) throw new Error(`${root} isn't empty; name another folder`);
  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  log(`${name}: restoring ${manifest.files.length} files, ${gb(total)}, archived ${manifest.archivedAt}`);
  const inside = (path) => {
    const target = resolve(root, path);
    if (!target.startsWith(root + sep)) throw new Error(`The manifest names a path outside the project: ${path}`);
    return target;
  };
  const fetched = new Map();
  for (const file of manifest.files) {
    const target = inside(file.path);
    await mkdir(dirname(target), { recursive: true });
    const copy = fetched.get(file.sha256);
    if (copy) await copyFile(copy, target, constants.COPYFILE_FICLONE);
    else {
      const partial = `${target}.partial`;
      const response = await request(`blobs/${file.sha256}`, { raw: true });
      const hash = createHash("sha256");
      const body = Readable.fromWeb(response.body);
      body.on("data", (chunk) => hash.update(chunk));
      await pipeline(body, createWriteStream(partial));
      if (hash.digest("hex") !== file.sha256) {
        await rm(partial, { force: true });
        throw new Error(`${file.path} came back different from what was archived`);
      }
      await rename(partial, target);
      fetched.set(file.sha256, target);
    }
    await utimes(target, new Date(), new Date(file.mtime));
  }
  // Manifests from before empty folders were kept have none.
  for (const folder of manifest.folders ?? []) await mkdir(inside(folder), { recursive: true });
  return { name, dest: root, files: manifest.files.length, bytes: total, archivedAt: manifest.archivedAt };
}

/** Copies to the archive the uploads of every post queued in the last 31 days that aren't there yet. */
export async function archiveRecentMedia({ origin, token, fetcher = fetch }) {
  return archiveClient({ origin, token, fetcher })("media", { method: "POST", json: {} });
}
