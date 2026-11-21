import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveResponse } from "../../src/lib/publisher/archive.ts";
import { memoryArchive, memoryMedia } from "../../src/lib/publisher/memory-archive.ts";
import { archiveClient } from "../publisher/archive.mjs";
import { hashFile, offload, originalsName } from "./offload.mjs";

/** The site's archive routes, answered in memory, as the grade app's fetch reaches them. */
function site() {
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
  const fetcher = async (url, init = {}) => {
    const rest = new URL(url).pathname.replace(/^\/api\/publisher\/helper\/archive\//, "");
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("Content-Length", String(Buffer.byteLength(init.body)));
    const request = new Request(url, { method: init.method, headers, body: init.body });
    return archiveResponse(rest, request, { db, media: media.bucket, archive: archive.bucket });
  };
  return { request: archiveClient({ origin: "https://post.kualta.dev", token: "token", fetcher }), archive };
}

async function card(root, files) {
  const clips = [];
  for (const [name, body, day] of files) {
    const path = join(root, name);
    await writeFile(path, body);
    clips.push({ name, path, size: Buffer.byteLength(body), mtime: 1_763_000_000_000, day });
  }
  return clips;
}

test("each day's originals go to the archive under their hash, in a manifest saved after every clip", async () => {
  const root = await mkdtemp(join(tmpdir(), "offload-"));
  try {
    const { request } = site();
    const clips = await card(root, [
      ["DJI_20261118203937_0317_D.MP4", "a clip long enough to go in parts", "2026-11-18"],
      ["DJI_20261118203054_0316_D.MP4", "short", "2026-11-18"],
      ["DJI_20261119090000_0318_D.MP4", "the next day", "2026-11-19"],
    ]);
    const landed = [];
    const heard = [];
    const run = await offload(clips, {
      request,
      part: 8,
      landed: (clip, sha256) => landed.push([clip.name, sha256]),
      progress: (p) => heard.push(p),
    });
    expect(run).toEqual({ done: 3, sent: clips.reduce((n, c) => n + c.size, 0), stopped: false });
    expect(landed.map(([name]) => name)).toEqual(clips.map((c) => c.name));
    expect(landed[0][1]).toBe(await hashFile(clips[0].path));
    // The part-by-part bytes of the clip that went in parts.
    expect(heard.filter((p) => p.name === clips[0].name && !p.hashing).map((p) => p.sent)).toEqual([8, 16, 24, 32, 33]);

    const day = await request(`projects/${originalsName("2026-11-18")}`);
    expect(day.files.map((f) => [f.path, f.size])).toEqual([
      ["assets/DJI_20261118203937_0317_D.MP4", 33],
      ["assets/DJI_20261118203054_0316_D.MP4", 5],
    ]);
    const next = await request(`projects/${originalsName("2026-11-19")}`);
    expect(next.files.map((f) => f.path)).toEqual(["assets/DJI_20261119090000_0318_D.MP4"]);
    const blob = await request(`blobs/${landed[0][1]}`, { raw: true });
    expect(await blob.text()).toBe("a clip long enough to go in parts");

    // Again: nothing to send, and the day keeps its clips.
    const again = await offload(clips.slice(1, 2), { request, part: 8 });
    expect(again).toEqual({ done: 1, sent: 0, stopped: false });
    expect((await request(`projects/${originalsName("2026-11-18")}`)).files).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stopping keeps what's in and sends nothing more", async () => {
  const root = await mkdtemp(join(tmpdir(), "offload-"));
  try {
    const { request } = site();
    const clips = await card(root, [
      ["DJI_20261118203937_0317_D.MP4", "first clip", "2026-11-18"],
      ["DJI_20261118203054_0316_D.MP4", "second clip", "2026-11-18"],
    ]);
    const stop = new AbortController();
    const run = await offload(clips, { request, signal: stop.signal, landed: () => stop.abort() });
    expect(run).toEqual({ done: 1, sent: 10, stopped: true });
    expect((await request(`projects/${originalsName("2026-11-18")}`)).files.map((f) => f.path)).toEqual([
      "assets/DJI_20261118203937_0317_D.MP4",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
