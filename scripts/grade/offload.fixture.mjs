// What the offload's tests run against: the site's archive in memory, and a card and a Movies/Original in a throwaway
// folder.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveResponse } from "../../src/lib/publisher/archive.ts";
import { memoryArchive, memoryMedia } from "../../src/lib/publisher/memory-archive.ts";
import { archiveClient } from "../publisher/archive.mjs";
import { originalsName, startOffload } from "./offload.mjs";

export const sha = (text) => createHash("sha256").update(text).digest("hex");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const answer = await check();
    if (answer) return answer;
    if (Date.now() > end) throw new Error(`timed out: ${check}`);
    await sleep(2);
  }
}

/**
 * The site's archive routes, answered in memory, as the grade app's fetch reaches them; `hold` can answer a request itself,
 * or stall it and then `pass` it on. `asked` are the requests that reached it.
 */
export function site({ hold = () => null } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("migrations/0002_publisher.sql", "utf8"));
  const db = {
    prepare: (sql) => {
      let values = [];
      const statement = {
        bind: (...v) => {
          values = v;
          return statement;
        },
        first: async () => sqlite.query(sql).get(...values),
        all: async () => ({ results: sqlite.query(sql).all(...values) }),
      };
      return statement;
    },
  };
  const archive = memoryArchive();
  const media = memoryMedia();
  const asked = [];
  const fetcher = async (url, init = {}) => {
    const rest = new URL(url).pathname.replace(/^\/api\/publisher\/helper\/archive\//, "");
    const pass = () => {
      asked.push(`${init.method ?? "GET"} ${rest}`);
      const headers = new Headers(init.headers);
      if (init.body !== undefined) headers.set("Content-Length", String(Buffer.byteLength(init.body)));
      const request = new Request(url, { method: init.method, headers, body: init.body });
      return archiveResponse(rest, request, { db, media: media.bucket, archive: archive.bucket });
    };
    return hold(rest, init, pass) ?? pass();
  };
  const request = archiveClient({ origin: "https://post.kualta.dev", token: "token", fetcher });
  return Object.assign(request, { archive, asked });
}

/** A request that stalls until `go()`, or until it's aborted; `reached` settles once it's made. */
export function stall() {
  let go;
  let arrive;
  const gone = new Promise((resolve) => {
    go = resolve;
  });
  const reached = new Promise((resolve) => {
    arrive = resolve;
  });
  const hold = (init, pass) =>
    new Promise((resolve, reject) => {
      arrive();
      init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      void gone.then(() => resolve(pass()));
    });
  return { hold, reached, go };
}

export const files = (dir) => readdirSync(dir).sort();
export const plenty = async () => 1e12;
const WHEN = new Date("2026-11-18T12:00:00Z");

/**
 * A card (DCIM/DJI_001, each clip with its .LRF) and a Movies/Original, with these clips on them, each `[name, body, day]`.
 * A run lists them as they are: the card not at all between `unplug()` and `plug()`.
 */
export async function place(card, mac = []) {
  const root = await mkdtemp(join(tmpdir(), "offload-"));
  const [dcim, original] = [join(root, "DCIM/DJI_001"), join(root, "Original")];
  for (const dir of [dcim, original]) await mkdir(dir, { recursive: true });
  const days = new Map();
  const make = async (dir, [name, body, day], lrf = false) => {
    const path = join(dir, name);
    await writeFile(path, body);
    await utimes(path, WHEN, WHEN);
    if (lrf) await writeFile(path.replace(/\.MP4$/, ".LRF"), "low-res");
    days.set(name, day);
  };
  for (const clip of card) await make(dcim, clip, true);
  for (const clip of mac) await make(original, clip);
  const list = (dir) =>
    files(dir)
      .filter((name) => /^[^.].*\.(mp4|mov)$/i.test(name))
      .map((name) => {
        const path = join(dir, name);
        const { size, mtimeMs } = statSync(path);
        return { name, path, size, mtime: Math.round(mtimeMs), day: days.get(name) ?? "2026-11-18" };
      });
  const away = join(root, "unplugged");
  return {
    root,
    dcim,
    original,
    camera: async () => (existsSync(dcim) ? list(dcim) : null),
    mac: async () => list(original),
    /** A clip put on the card or in Movies/Original since. */
    put: make,
    unplug: () => renameSync(join(root, "DCIM"), away),
    plug: () => renameSync(away, join(root, "DCIM")),
    away: join(away, "DJI_001"),
    done: () => rm(root, { recursive: true, force: true }),
  };
}

/** A record of what went to the archive, kept in memory; `added` hears each clip. */
export function records(clips = {}, added = () => {}) {
  return {
    clips,
    read: async () => structuredClone(clips),
    add: async (clip, sha256, proof) => {
      clips[clip.name] = { sha256, size: clip.size, day: clip.day, ...proof };
      await added(clip, sha256);
    },
    drop: async (sha256) => {
      for (const [name, record] of Object.entries(clips)) if (record.sha256 === sha256) delete clips[name];
    },
  };
}

/** A run over a place, trying again soon after anything fails. */
export const begin = (at, options) =>
  startOffload({
    camera: at.camera,
    mac: at.mac,
    records: records(),
    dir: at.original,
    room: plenty,
    retry: { first: 5, most: 20, tries: 5 },
    look: 10,
    ...options,
  });

/** What a day's manifest lists, path → hash. */
export async function listed(request, day, project = originalsName(day)) {
  const { files: filed } = await request(`projects/${project}`);
  return Object.fromEntries(filed.map((file) => [file.path, file.sha256]));
}
/** Puts a file in the archive, as a manifest names it. */
export async function put(request, path, body, extra = {}) {
  await request(`blobs/${sha(body)}`, { method: "PUT", body });
  return { path, sha256: sha(body), size: Buffer.byteLength(body), mtime: 1_700_000_000_000, ...extra };
}
export const savesDay = (rest, init) => rest.startsWith("projects/_") && init.method === "PUT";
export const readsBlob = (rest, init) => rest.startsWith("blobs/") && (init.method ?? "GET") === "GET";
