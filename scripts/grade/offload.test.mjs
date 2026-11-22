import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveResponse } from "../../src/lib/publisher/archive.ts";
import { memoryArchive, memoryMedia } from "../../src/lib/publisher/memory-archive.ts";
import { archiveClient } from "../publisher/archive.mjs";
import { originalsName, startOffload } from "./offload.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");

/** The site's archive routes, answered in memory, as the grade app's fetch reaches them; `hold` can stall a request. */
function site({ hold = () => null } = {}) {
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
    const held = hold(rest, init);
    if (held) return held;
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("Content-Length", String(Buffer.byteLength(init.body)));
    const request = new Request(url, { method: init.method, headers, body: init.body });
    return archiveResponse(rest, request, { db, media: media.bucket, archive: archive.bucket });
  };
  return archiveClient({ origin: "https://post.kualta.dev", token: "token", fetcher });
}

/** A card (DCIM/DJI_001, each clip with its .LRF) and a Movies/Original, with these clips on them. */
async function place(card, mac = []) {
  const root = await mkdtemp(join(tmpdir(), "offload-"));
  const dcim = join(root, "DCIM/DJI_001");
  const original = join(root, "Original");
  await mkdir(dcim, { recursive: true });
  await mkdir(original);
  const make = async (dir, [name, body, day], lrf) => {
    const path = join(dir, name);
    await writeFile(path, body);
    const when = new Date("2026-11-18T12:00:00Z");
    await utimes(path, when, when);
    if (lrf) await writeFile(path.replace(/\.MP4$/, ".LRF"), "low-res");
    return { name, path, size: Buffer.byteLength(body), mtime: when.getTime(), day };
  };
  const camera = [];
  for (const clip of card) camera.push(await make(dcim, clip, true));
  const onMac = [];
  for (const clip of mac) onMac.push(await make(original, clip, false));
  return { root, dcim, original, camera, mac: onMac, done: () => rm(root, { recursive: true, force: true }) };
}

const files = (dir) => readdirSync(dir).sort();
const plenty = async () => 1e12;

test("the card goes to the Mac and the Mac to the archive, each deleted once the next has it, by day", async () => {
  const at = await place(
    [
      ["DJI_20261118203054_0316_D.MP4", "a clip long enough to go in parts", "2026-11-18"],
      ["DJI_20261118203937_0317_D.MP4", "short", "2026-11-18"],
      ["DJI_20261119090000_0318_D.MP4", "the next day", "2026-11-19"],
    ],
    [["DJI_20261117090000_0300_D.MP4", "already on the Mac", "2026-11-17"]],
  );
  try {
    const request = site();
    const landed = [];
    const removed = [];
    const run = startOffload({
      camera: at.camera,
      mac: at.mac,
      dir: at.original,
      request,
      room: plenty,
      keepFree: 0,
      part: 8,
      landed: (clip, sha256) => landed.push([clip.name, sha256]),
      removed: (clip, where) => removed.push([where, clip.name]),
    });
    await run.done;
    expect(run.state).toMatchObject({ running: false, finished: "done", error: null });
    expect(run.state.copy).toMatchObject({ total: 3, done: 3, ended: true, error: null });
    expect(run.state.send).toMatchObject({ total: 4, done: 4, current: [] });
    expect(run.state.freed).toEqual({ camera: 50, mac: 68 });
    expect(Object.fromEntries(landed)).toEqual({
      "DJI_20261118203054_0316_D.MP4": sha("a clip long enough to go in parts"),
      "DJI_20261118203937_0317_D.MP4": sha("short"),
      "DJI_20261119090000_0318_D.MP4": sha("the next day"),
      "DJI_20261117090000_0300_D.MP4": sha("already on the Mac"),
    });
    expect(removed.filter(([where]) => where === "camera").map(([, name]) => name)).toEqual(
      at.camera.map((c) => c.name),
    );
    expect(removed.filter(([where]) => where === "mac")).toHaveLength(4);
    // Nothing left on the card, .LRF included, nor on the Mac, half-copied files included.
    expect(files(at.dcim)).toEqual([]);
    expect(files(at.original)).toEqual([]);

    const day = await request(`projects/${originalsName("2026-11-18")}`);
    expect(day.files.map((f) => [f.path, f.size, f.mtime])).toEqual([
      ["assets/DJI_20261118203054_0316_D.MP4", 33, Date.parse("2026-11-18T12:00:00Z")],
      ["assets/DJI_20261118203937_0317_D.MP4", 5, Date.parse("2026-11-18T12:00:00Z")],
    ]);
    expect((await request(`projects/${originalsName("2026-11-17")}`)).files.map((f) => f.path)).toEqual([
      "assets/DJI_20261117090000_0300_D.MP4",
    ]);
    const blob = await request(`blobs/${sha("a clip long enough to go in parts")}`, { raw: true });
    expect(await blob.text()).toBe("a clip long enough to go in parts");
  } finally {
    await at.done();
  }
});

test("a clip comes off the card only when the Mac has room for it, made by the clips going up", async () => {
  const at = await place([
    ["DJI_20261118100000_0001_D.MP4", "twenty bytes, first.", "2026-11-18"],
    ["DJI_20261118100100_0002_D.MP4", "twenty bytes, second", "2026-11-18"],
    ["DJI_20261118100200_0003_D.MP4", "twenty bytes, third.", "2026-11-18"],
  ]);
  try {
    // Room for one clip at a time: 30 bytes, less what's in Original.
    const used = async () => {
      let total = 0;
      for (const name of files(at.original)) total += (await stat(join(at.original, name))).size;
      return total;
    };
    const most = [];
    let waited = false;
    const run = startOffload({
      camera: at.camera,
      mac: [],
      dir: at.original,
      request: site(),
      room: async () => {
        waited ||= run?.state.waiting === "room";
        return 30 - (await used());
      },
      keepFree: 0,
      landed: async () => most.push(files(at.original).length),
    });
    await run.done;
    expect(run.state).toMatchObject({ finished: "done", error: null });
    expect(run.state.send.done).toBe(3);
    expect(most).toEqual([1, 1, 1]);
    expect(waited).toBe(true);
    expect(files(at.dcim)).toEqual([]);
    expect(files(at.original)).toEqual([]);
  } finally {
    await at.done();
  }
});

test("with no room on the Mac and nothing there to go up, the copy says so and the card keeps its clips", async () => {
  const at = await place([["DJI_20261118100000_0001_D.MP4", "a clip", "2026-11-18"]]);
  try {
    const run = startOffload({ camera: at.camera, mac: [], dir: at.original, request: site(), room: async () => 3e9 });
    await run.done;
    expect(run.state.finished).toBe("done");
    expect(run.state.copy.error).toBe("No room on this Mac for the next clip: 3.0 GB free, 5.0 GB kept free");
    expect(files(at.dcim)).toEqual(["DJI_20261118100000_0001_D.LRF", "DJI_20261118100000_0001_D.MP4"]);
  } finally {
    await at.done();
  }
});

test("what the archive holds already is only deleted; what it's lost goes again", async () => {
  const at = await place(
    [["DJI_20261118100000_0001_D.MP4", "in the archive", "2026-11-18"]],
    [["DJI_20261117100000_0001_D.MP4", "recorded, but the archive lost it", "2026-11-17"]],
  );
  try {
    const request = site();
    await request(`blobs/${sha("in the archive")}`, { method: "PUT", body: "in the archive" });
    const record = {
      "DJI_20261118100000_0001_D.MP4": { sha256: sha("in the archive"), size: 14 },
      "DJI_20261117100000_0001_D.MP4": { sha256: sha("recorded, but the archive lost it"), size: 33 },
    };
    const landed = [];
    const run = startOffload({
      camera: at.camera,
      mac: at.mac,
      record,
      dir: at.original,
      request,
      room: plenty,
      landed: (clip) => landed.push(clip.name),
    });
    await run.done;
    expect(run.state.copy.total).toBe(0);
    expect(landed).toEqual(["DJI_20261117100000_0001_D.MP4"]);
    expect(files(at.dcim)).toEqual([]);
    expect(files(at.original)).toEqual([]);
  } finally {
    await at.done();
  }
});

test("stopping cuts the part in flight, keeps what's in, and keeps the clip on the Mac", async () => {
  const at = await place([], [["DJI_20261117100000_0001_D.MP4", "a clip long enough to go in parts", "2026-11-17"]]);
  try {
    let stalled = null;
    const request = site({
      hold: (rest, init) => {
        if (!/^uploads\/\w+\/2$/.test(rest)) return null;
        return new Promise((_, reject) => {
          stalled?.();
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      },
    });
    const run = startOffload({ camera: at.camera, mac: at.mac, dir: at.original, request, room: plenty, part: 8 });
    await new Promise((resolve) => {
      stalled = resolve;
    });
    expect(run.state.send.current).toMatchObject([{ name: "DJI_20261117100000_0001_D.MP4", sent: 8 }]);
    run.stop();
    await run.done;
    expect(run.state).toMatchObject({ finished: "stopped", error: null, running: false });
    expect(run.state.send.done).toBe(0);
    expect(files(at.original)).toEqual(["DJI_20261117100000_0001_D.MP4"]);
  } finally {
    await at.done();
  }
});

test("a clip sent in parts that doesn't read back is sent once more, and stays on the Mac if it still doesn't", async () => {
  for (const [bad, finished] of [
    [1, "done"],
    [2, null],
  ]) {
    const at = await place([], [["DJI_20261117100000_0001_D.MP4", "a clip long enough to go in parts", "2026-11-17"]]);
    try {
      let reads = 0;
      let begun = 0;
      const request = site({
        hold: (rest, init) => {
          if (rest === "uploads") begun++;
          if (!rest.startsWith("blobs/") || (init.method ?? "GET") !== "GET") return null;
          return ++reads <= bad ? new Response("not the clip") : null;
        },
      });
      const run = startOffload({ camera: [], mac: at.mac, dir: at.original, request, room: plenty, part: 8 });
      await run.done;
      expect(begun).toBe(2);
      expect(run.state.finished).toBe(finished);
      expect(run.state.send.done).toBe(finished ? 1 : 0);
      if (finished) expect(files(at.original)).toEqual([]);
      else {
        expect(run.state.error).toMatch(/doesn't read back from Cloudflare/);
        expect(files(at.original)).toEqual(["DJI_20261117100000_0001_D.MP4"]);
      }
    } finally {
      await at.done();
    }
  }
});

test("a file the archive already has, but no record vouches for, is read back before the Mac's copy goes", async () => {
  const at = await place([], [["DJI_20261117100000_0001_D.MP4", "here already", "2026-11-17"]]);
  try {
    let reads = 0;
    const request = site({
      hold: (rest, init) => {
        if (rest.startsWith("blobs/") && (init.method ?? "GET") === "GET") reads++;
        return null;
      },
    });
    await request(`blobs/${sha("here already")}`, { method: "PUT", body: "here already" });
    const run = startOffload({ camera: [], mac: at.mac, dir: at.original, request, room: plenty });
    await run.done;
    expect(reads).toBe(1);
    expect(run.state.finished).toBe("done");
    expect(files(at.original)).toEqual([]);
  } finally {
    await at.done();
  }
});

test("a request that fails stops it all, saying why, and nothing is deleted that isn't in", async () => {
  const at = await place(
    [["DJI_20261118100000_0001_D.MP4", "off the card", "2026-11-18"]],
    [["DJI_20261117100000_0001_D.MP4", "on the Mac", "2026-11-17"]],
  );
  try {
    const request = site({
      hold: (rest) => (rest === "missing" ? Response.json({ error: "Archive unavailable" }, { status: 400 }) : null),
    });
    const run = startOffload({ camera: at.camera, mac: at.mac, dir: at.original, request, room: plenty, together: 1 });
    await run.done;
    expect(run.state).toMatchObject({ finished: null, error: "Archive unavailable", running: false });
    expect(run.state.send.done).toBe(0);
    expect(files(at.original).filter((f) => f.endsWith(".MP4")).length).toBeGreaterThanOrEqual(1);
  } finally {
    await at.done();
  }
});
