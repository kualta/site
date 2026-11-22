import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { archiveResponse, putBlob, saveManifest } from "../../src/lib/publisher/archive.ts";
import { memoryArchive } from "../../src/lib/publisher/memory-archive.ts";
import { archiveClient } from "../publisher/archive.mjs";
import { archiveDays, bringClip, bringer, clearParts, dayClips, pickClips, summarise, withHere } from "./bring.mjs";
import { gradeKey, writeCube } from "./color.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MTIME = Date.parse("2026-11-18T12:00:00.123Z");
const files = (dir) => readdirSync(dir).sort();
const text = (...path) => readFileSync(join(...path), "utf8");

/** The site's archive routes over an archive in memory. `hold` can answer a request itself; `asked` is what was asked. */
function site({ hold = () => null } = {}) {
  const { bucket } = memoryArchive();
  const asked = [];
  const fetcher = async (url, init = {}) => {
    const rest = new URL(url).pathname.replace(/^\/api\/publisher\/helper\/archive\//, "");
    asked.push(`${init.method ?? "GET"} ${rest}`);
    const pass = () => archiveResponse(rest, new Request(url, { method: init.method }), { archive: bucket });
    return (await hold(rest, init, pass)) ?? pass();
  };
  let saves = 0;
  return {
    request: archiveClient({ origin: "https://post.kualta.dev", token: "token", fetcher }),
    asked,
    /** Files a project's manifest: `[path, body]` each, or with another size, hash or time than the body's. */
    async file(project, listed) {
      const manifest = [];
      for (const [path, body, lie = {}] of listed) {
        await putBlob(bucket, sha(body), body);
        manifest.push({ path, sha256: sha(body), size: Buffer.byteLength(body), mtime: MTIME, ...lie });
      }
      const at = new Date(Date.UTC(2026, 10, 19) + saves++ * 1000);
      await saveManifest(bucket, project, { files: manifest, folders: [] }, at);
    },
  };
}

/** A Movies folder of its own, for `use` to bring clips into. */
async function movies(use) {
  const root = await mkdtemp(join(tmpdir(), "bring-"));
  const folders = { original: join(root, "Original"), graded: join(root, "Exported") };
  for (const dir of Object.values(folders)) mkdirSync(dir);
  try {
    await use(folders);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const A = "DJI_20261118100000_0001_D.MP4";
const B = "DJI_20261118100100_0002_D.MP4";
const C = "DJI_20261118100200_0003_D.MP4";
const day = "2026-11-18";
const plenty = async () => 1e12;

/** The archive's clips as the server hands them on: read, and each looked for on this Mac. */
const listed = async (at, folders) => withHere((await archiveDays().read(at.request)).clips, folders);
/** Brings what `asked` names, to the end. Says the run's state. */
async function bringAll(at, folders, asked, options = {}) {
  const run = bringer({ folders, room: plenty, ...options });
  await run.add(at.request, pickClips(await listed(at, folders), asked));
  await run.settled();
  return run.state();
}

test("lists what the archive has and this Mac doesn't, by day", () =>
  movies(async (folders) => {
    const at = site();
    await at.file(`_originals-${day}`, [
      [`assets/${A}`, "original one"],
      [`assets/${B}`, "original two"],
      [`transcripts/${A.replace(".MP4", ".vtt")}`, "WEBVTT"],
      [`transcripts/${A.replace(".MP4", ".json")}`, "{}"],
    ]);
    await at.file(`_graded-${day}`, [[`assets/${A.replace(".MP4", ".mp4")}`, "graded one"]]);
    await at.file("_originals-2026-11-17", [["assets/IMG_0001.MOV", "a phone's"]]);
    // A film's copies are the film's, not a day's.
    await at.file("014-walk", [[`assets/${B}`, "a film's copy"]]);
    writeFileSync(join(folders.original, B), "original two");
    writeFileSync(join(folders.original, "img_0001.mov"), "another phone's");

    const clips = await listed(at, folders);
    expect(
      clips.map(({ what, day, name, size, transcript, here }) => [what, day, name, size, transcript, here]),
    ).toEqual([
      ["graded", day, A.replace(".MP4", ".mp4"), 10, true, "no"],
      ["original", "2026-11-17", "IMG_0001.MOV", 9, false, "different"],
      ["original", day, A, 12, true, "no"],
      ["original", day, B, 12, false, "yes"],
    ]);
    expect(clips.find((clip) => clip.name === A)).toMatchObject({ sha256: sha("original one"), mtime: MTIME });

    const one = { clips: 1, bytes: 12 };
    expect(summarise(clips)).toEqual([
      {
        id: `cloud:${day}`,
        day,
        away: 1,
        original: { clips: 2, bytes: 24, missing: one },
        graded: { clips: 1, bytes: 10, missing: { clips: 1, bytes: 10 } },
      },
      {
        id: "cloud:2026-11-17",
        day: "2026-11-17",
        away: 0,
        original: { clips: 1, bytes: 9, missing: { clips: 0, bytes: 0 } },
        graded: { clips: 0, bytes: 0, missing: { clips: 0, bytes: 0 } },
      },
    ]);
    const [first, second] = dayClips(clips, day);
    expect(first).toMatchObject({ stem: A.replace(".MP4", ""), transcript: true });
    expect(first.original).toEqual({ name: A, size: 12, sha256: sha("original one"), here: "no" });
    expect(first.graded).toMatchObject({ name: A.replace(".MP4", ".mp4"), here: "no" });
    expect(second).toMatchObject({ transcript: false, graded: null, original: { here: "yes" } });
  }));

test("a day's manifest is read once each time it's archived, 227 clips or one", () =>
  movies(async (folders) => {
    const at = site();
    const many = Array.from({ length: 227 }, (_, n) => {
      const name = `DJI_20261118${String(100000 + n)}_${String(n + 1).padStart(4, "0")}_D`;
      return [
        [`assets/${name}.MP4`, `clip ${n}`],
        [`transcripts/${name}.vtt`, `said ${n}`],
        [`transcripts/${name}.json`, `words ${n}`],
      ];
    }).flat();
    await at.file(`_originals-${day}`, many);
    await at.file("_originals-2026-11-17", [["assets/IMG_0001.MOV", "a phone's"]]);
    const days = archiveDays();
    const { clips, readAt, error } = await days.read(at.request);
    expect({ clips: clips.length, error }).toEqual({ clips: 228, error: null });
    expect(readAt).toBeTruthy();
    expect(at.asked).toEqual(["GET projects", "GET projects/_originals-2026-11-17", `GET projects/_originals-${day}`]);
    const here = await withHere(clips, folders);
    expect(summarise(here)[0]).toMatchObject({ away: 227, original: { clips: 227, missing: { clips: 227 } } });
    const rows = dayClips(here, day);
    expect(rows).toHaveLength(227);
    expect(rows.every((row) => row.transcript && row.original.here === "no")).toBe(true);

    // Asked again, it's answered from here; refreshed, only a day archived since is read again.
    at.asked.length = 0;
    await Promise.all([days.read(at.request), days.read(at.request)]);
    expect(at.asked).toEqual([]);
    await at.file("_originals-2026-11-17", [["assets/IMG_0002.MOV", "its next"]]);
    const after = await days.read(at.request, { refresh: true });
    expect(at.asked).toEqual(["GET projects", "GET projects/_originals-2026-11-17"]);
    expect(after.clips.filter((clip) => clip.day === "2026-11-17").map((clip) => clip.name)).toEqual(["IMG_0002.MOV"]);
  }));

test("takes nothing from a manifest that couldn't be a clip's plain name", () =>
  movies(async (folders) => {
    const at = site();
    const bad = [
      "assets/.hidden.MP4",
      "assets/sub/inside.MP4",
      "assets/back\\slash.MP4",
      "assets/notes.txt",
      "outside.MP4",
      "zh/assets/film.MP4",
    ];
    const good = [[`assets/${A}`, "fine"]];
    await at.file(`_originals-${day}`, [...bad.map((path) => [path, path]), ...good]);
    expect((await listed(at, folders)).map((clip) => clip.name)).toEqual([A]);
    // The archive refuses a path that climbs out; a manifest that had one anyway would still not be followed.
    const answers = {
      projects: { projects: [{ name: `_originals-${day}`, archivedAt: "2026-11-19T00:00:00.000Z" }] },
    };
    const listing = { path: "assets/../../x.MP4", sha256: sha("x"), size: 1, mtime: 0 };
    const request = async (path) => answers[path] ?? { files: [listing, { ...listing, path: "assets/..", size: 2 }] };
    expect((await archiveDays().read(request)).clips).toEqual([]);
  }));

test("brings a day's originals to Movies/Original and its graded copies to Movies/Exported, whole and dated", () =>
  movies(async (folders) => {
    const at = site();
    const graded = A.replace(".MP4", ".mp4");
    await at.file(`_originals-${day}`, [
      [`assets/${A}`, "original one"],
      [`assets/${B}`, "original two"],
    ]);
    // The same clip's graded copy, named alike but for the case: to the Mac's disk the same name.
    await at.file(`_graded-${day}`, [[`assets/${graded}`, "graded one"]]);
    const heard = [];
    const run = bringer({ folders, room: plenty, landed: (clip) => heard.push(`${clip.what} ${clip.name}`) });
    expect(await run.add(at.request, pickClips(await listed(at, folders), { what: "original", day }))).toBe(2);
    // Asked for while those come, it waits its turn; what's on its way isn't asked for twice.
    const clips = await listed(at, folders);
    await run.add(at.request, pickClips(clips, { what: "graded", names: [graded] }));
    expect(await run.add(at.request, pickClips(clips, { what: "graded", names: [graded] }))).toBe(0);
    await run.settled();
    expect(run.state()).toMatchObject({
      running: false,
      finished: "done",
      error: null,
      total: 3,
      landed: 3,
      skipped: 0,
      failed: [],
      bytes: 34,
      gotBytes: 34,
      current: null,
      queued: [],
    });
    expect(heard).toEqual([`original ${A}`, `original ${B}`, `graded ${graded}`]);
    expect(files(folders.original)).toEqual([A, B]);
    expect(files(folders.graded)).toEqual([graded]);
    expect(text(folders.original, A)).toBe("original one");
    expect(text(folders.graded, graded)).toBe("graded one");
    // Its own time, to the millisecond: the footage uploads tell a clip they've put up by it.
    expect(Math.round(statSync(join(folders.graded, graded)).mtimeMs)).toBe(MTIME);
    expect((await listed(at, folders)).map((clip) => clip.here)).toEqual(["yes", "yes", "yes"]);
    // Only read: nothing was asked of the archive but to say what it has.
    expect(at.asked.every((ask) => ask.startsWith("GET "))).toBe(true);
  }));

test("keeps nothing of a clip that doesn't come back as its manifest lists it, says why, and goes on to the next", () =>
  movies(async (folders) => {
    const wrong = { wrong: sha("wrong"), short: sha("short"), long: sha("long"), lost: sha("lost") };
    const body = { [wrong.wrong]: "WRONG", [wrong.short]: "sho", [wrong.long]: "long and then some" };
    const at = site({
      hold: (rest) => {
        const hash = rest.replace("blobs/", "");
        if (hash === wrong.lost) return Response.json({ error: "Not in the archive" }, { status: 404 });
        return body[hash] ? new Response(body[hash]) : null;
      },
    });
    const name = (n) => `DJI_2026111810000${n}_000${n}_D.MP4`;
    const bodies = ["wrong", "short", "long", "lost", "right"];
    await at.file(
      `_originals-${day}`,
      bodies.map((clip, n) => [`assets/${name(n)}`, clip]),
    );
    const state = await bringAll(at, folders, { what: "original", day });
    expect(state).toMatchObject({ finished: "done", error: null, landed: 1, gotBytes: 23 });
    expect(state.failed.map((one) => one.why)).toEqual([
      `${name(0)} came back different from what was archived`,
      `${name(1)} came back 3 bytes long, not 5`,
      `${name(2)} came back longer than the 4 bytes listed`,
      `${name(3)} isn't in the archive any more`,
    ]);
    expect(state.failed[0]).toMatchObject({ what: "original", day, name: name(0) });
    expect(files(folders.original)).toEqual([name(4)]);
  }));

test("skips the very same file, and leaves another of its name as it is", () =>
  movies(async (folders) => {
    const at = site();
    await at.file(`_originals-${day}`, [
      [`assets/${A}`, "same as here"],
      [`assets/${B}`, "in the archive"],
      [`assets/${C}`, "same size, other bytes"],
    ]);
    writeFileSync(join(folders.original, A), "same as here");
    // The same name to the Mac's disk, whatever its case.
    writeFileSync(join(folders.original, B.toLowerCase()), "put here by hand");
    writeFileSync(join(folders.original, C), "SAME size, other bytes");
    const state = await bringAll(at, folders, { what: "original", names: [A, B, C] });
    expect(state).toMatchObject({ finished: "done", landed: 0, skipped: 1 });
    expect(state.failed.map((one) => [one.name, one.why])).toEqual([
      [B, `Another file is already Original/${B.toLowerCase()}`],
      [C, `Another file is already Original/${C}`],
    ]);
    expect(files(folders.original)).toEqual([A, C, B.toLowerCase()].sort());
    expect(text(folders.original, B.toLowerCase())).toBe("put here by hand");
    expect(text(folders.original, C)).toBe("SAME size, other bytes");
    expect(at.asked.some((ask) => ask.includes("blobs/"))).toBe(false);
  }));

test("a file put there while a clip comes isn't written over", () =>
  movies(async (folders) => {
    const graded = A.replace(".MP4", ".mp4");
    const at = site({
      hold: (rest) => {
        // An export of the clip lands meanwhile.
        if (rest.startsWith("blobs/")) writeFileSync(join(folders.graded, graded), "a newer export");
        return null;
      },
    });
    await at.file(`_graded-${day}`, [[`assets/${graded}`, "the archive's copy"]]);
    const state = await bringAll(at, folders, { what: "graded", day });
    expect(state).toMatchObject({ landed: 0, failed: [{ why: `Another file is already Exported/${graded}` }] });
    expect(files(folders.graded)).toEqual([graded]);
    expect(text(folders.graded, graded)).toBe("a newer export");
  }));

/** An answer that says what it has and then no more, until the request is cut, as fetch cuts it. */
const stalled = (said, { signal }) =>
  new Response(
    new ReadableStream({
      start(it) {
        it.enqueue(Buffer.from(said));
        signal.addEventListener("abort", () => it.error(signal.reason), { once: true });
      },
    }),
  );
async function until(check, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("stopping cuts the clip coming, keeps nothing of it, drops the rest and keeps what's landed", () =>
  movies(async (folders) => {
    let signal = null;
    const at = site({
      hold: (rest, init) => {
        if (rest !== `blobs/${sha("the second, stalled")}`) return null;
        signal = init.signal;
        return stalled("the second", init);
      },
    });
    await at.file(`_originals-${day}`, [
      [`assets/${A}`, "the first"],
      [`assets/${B}`, "the second, stalled"],
      [`assets/${C}`, "the third"],
    ]);
    const run = bringer({ folders, room: plenty });
    const clips = pickClips(await listed(at, folders), { what: "original", day });
    await run.add(at.request, clips);
    await until(() => run.state().current?.got === 10);
    expect(run.state()).toMatchObject({ running: true, landed: 1, current: { name: B, size: 19 }, gotBytes: 19 });
    expect(run.state().queued.map((clip) => clip.name)).toEqual([C]);
    expect(files(folders.original)).toEqual([`.${B}.bring.part`, A]);
    expect(run.stop()).toBe(true);
    await run.settled();
    expect(signal.aborted).toBe(true);
    expect(run.state()).toMatchObject({
      running: false,
      finished: "stopped",
      error: null,
      landed: 1,
      failed: [],
      queued: [],
    });
    expect(files(folders.original)).toEqual([A]);
    expect(run.stop()).toBe(false);
    // Asked for again, it's a new run.
    await run.add(at.request, [clips[2]]);
    await run.settled();
    expect(run.state()).toMatchObject({ finished: "done", total: 1, landed: 1 });
    expect(files(folders.original)).toEqual([A, C]);
  }));

test("refuses what wouldn't leave the room kept free, and what an export or an offload still needs", () =>
  movies(async (folders) => {
    const at = site();
    await at.file(`_originals-${day}`, [
      [`assets/${A}`, "twenty bytes, first."],
      [`assets/${B}`, "twenty bytes, second"],
    ]);
    const clips = await listed(at, folders);
    const of = (names) => pickClips(clips, { what: "original", names });
    const refusal = async (names, options) => {
      const run = bringer({ folders, ...options });
      const error = await run.add(at.request, of(names)).then(
        () => null,
        (e) => e,
      );
      await run.settled();
      return error && `${error.status} ${error.message}`;
    };
    // Scaled so the words come out in GB.
    const big = clips.map((clip) => ({ ...clip, size: 2e9 }));
    const run = bringer({ folders, room: async () => 8e9, keepFree: 5e9 });
    await expect(run.add(at.request, big)).rejects.toThrow(
      "No room on this Mac: 4.0 GB to bring, 8.0 GB free, 5.0 GB of it kept free",
    );
    expect(run.state()).toMatchObject({ running: false, total: 0 });
    const sharing = bringer({
      folders,
      room: async () => 10e9,
      keepFree: 5e9,
      claims: async () => [
        { by: "the export", bytes: 0 },
        { by: "the camera", bytes: 3e9 },
      ],
    });
    await expect(sharing.add(at.request, big)).rejects.toThrow(
      "No room on this Mac: 4.0 GB to bring, 10.0 GB free, 5.0 GB of it kept free, and 3.0 GB still to come from the camera",
    );

    // To the byte: 20 more are left out of 59 free with 40 kept, not out of 60.
    expect(await refusal([A], { room: async () => 59, keepFree: 40 })).toMatch(/^409 No room on this Mac/);
    expect(files(folders.original)).toEqual([]);
    expect(await refusal([A], { room: async () => 60, keepFree: 40 })).toBeNull();
    expect(files(folders.original)).toEqual([A]);
    // Two at once are counted together, and what's here already takes none.
    rmSync(join(folders.original, A));
    expect(await refusal([A, B], { room: async () => 70, keepFree: 40 })).toMatch(/^409/);
    writeFileSync(join(folders.original, A), "twenty bytes, first.");
    const now = await listed(at, folders);
    const again = bringer({ folders, room: async () => 60, keepFree: 40 });
    await again.add(at.request, pickClips(now, { what: "original", names: [A, B] }));
    await again.settled();
    expect(again.state()).toMatchObject({ landed: 1, skipped: 1, error: null });
  }));

test("stopped just as a clip has landed, it keeps that one and starts no other", () =>
  movies(async (folders) => {
    const at = site();
    await at.file(`_originals-${day}`, [
      [`assets/${A}`, "the first"],
      [`assets/${B}`, "the second"],
    ]);
    const run = bringer({ folders, room: plenty, landed: () => run.stop() });
    await run.add(at.request, pickClips(await listed(at, folders), { what: "original", day }));
    await run.settled();
    expect(run.state()).toMatchObject({ finished: "stopped", landed: 1, queued: [] });
    expect(files(folders.original)).toEqual([A]);
  }));

test("room is looked at again before each clip: one that no longer fits isn't asked for", () =>
  movies(async (folders) => {
    const at = site();
    await at.file(`_originals-${day}`, [
      [`assets/${A}`, "twenty bytes, first."],
      [`assets/${B}`, "twenty bytes, second"],
    ]);
    // Something else fills the disk once the first is in.
    const room = async () => (existsSync(join(folders.original, A)) ? 59 : 80);
    const state = await bringAll(at, folders, { what: "original", day }, { room, keepFree: 40 });
    expect(state).toMatchObject({ finished: null, landed: 1, failed: [] });
    expect(state.error).toMatch(/^No room on this Mac/);
    expect(files(folders.original)).toEqual([A]);
    expect(at.asked.filter((ask) => ask.includes("blobs/"))).toEqual([`GET blobs/${sha("twenty bytes, first.")}`]);
  }));

test("a clip coming gives way, and the run says why, when an export or an offload starts and room is short", () =>
  movies(async (folders) => {
    const at = site({ hold: (rest, init) => (rest.startsWith("blobs/") ? stalled("twenty bytes", init) : null) });
    await at.file(`_originals-${day}`, [
      [`assets/${A}`, "twenty bytes, first."],
      [`assets/${B}`, "twenty bytes, second"],
    ]);
    const claims = [];
    const run = bringer({ folders, room: async () => 90, keepFree: 40, claims: async () => claims, every: 10 });
    await run.add(at.request, pickClips(await listed(at, folders), { what: "original", day }));
    await until(() => run.state().current?.got === 12);
    // Room for both: it goes on.
    claims.push({ by: "the export", bytes: 30 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(run.state()).toMatchObject({ running: true, error: null });
    claims[0].bytes = 60;
    await run.settled();
    expect(run.state()).toMatchObject({ running: false, finished: null, landed: 0, failed: [], queued: [] });
    expect(run.state().error).toMatch(/^No room on this Mac: .*, and 0\.0 GB still to come from the export$/);
    expect(files(folders.original)).toEqual([]);
  }));

test("an archive that can't be reached: the list stays as last read and says so, and a run ends saying why", () =>
  movies(async (folders) => {
    let down = false;
    const at = site({
      hold: () => {
        if (down) throw new Error("Unable to connect");
        return null;
      },
    });
    await at.file(`_originals-${day}`, [
      [`assets/${A}`, "the first"],
      [`assets/${B}`, "the second"],
    ]);
    const days = archiveDays();
    const { clips, readAt } = await days.read(at.request);
    down = true;
    const refreshed = await days.read(at.request, { refresh: true });
    expect(refreshed).toEqual({ clips, readAt, error: "Couldn't read the Cloudflare archive: Unable to connect" });
    // It isn't asked again at every look.
    at.asked.length = 0;
    await days.read(at.request);
    expect(at.asked).toEqual([]);
    expect(await archiveDays().read(at.request)).toMatchObject({ clips: [], readAt: null, error: refreshed.error });

    const run = bringer({ folders, room: plenty });
    await run.add(at.request, pickClips(await withHere(clips, folders), { what: "original", day }));
    await run.settled();
    expect(run.state()).toMatchObject({ running: false, finished: null, landed: 0, failed: [], queued: [] });
    expect(run.state().error).toBe(`${A} didn't come: Unable to connect`);
    expect(files(folders.original)).toEqual([]);
    down = false;
    expect((await days.read(at.request, { refresh: true })).error).toBeNull();
  }));

test("a connection lost halfway through a clip keeps nothing of it", () =>
  movies(async (folders) => {
    const lost = (it) => {
      it.enqueue(Buffer.from("half of"));
      setTimeout(() => it.error(new Error("terminated")), 20);
    };
    const at = site({
      hold: (rest) => (rest.startsWith("blobs/") ? new Response(new ReadableStream({ start: lost })) : null),
    });
    await at.file(`_originals-${day}`, [[`assets/${A}`, "half of this clip"]]);
    const state = await bringAll(at, folders, { what: "original", day });
    expect(state.error).toBe(`${A} didn't come: terminated`);
    expect(files(folders.original)).toEqual([]);
  }));

test("gives a big clip longer than a request's usual ten minutes", () =>
  movies(async (folders) => {
    const timeouts = [];
    const request = async (_path, { timeout }) => {
      timeouts.push(timeout);
      throw new Error("enough");
    };
    const clip = { what: "original", day, name: A, sha256: sha("x"), mtime: MTIME };
    for (const size of [1000, 3.5e9, 1e15])
      await bringClip(request, { ...clip, size }, folders.original).catch(() => {});
    // At least 50 KB/s: 3.5 GB takes 16 minutes at 30 Mbit/s, and is given 19 hours. A timer holds no more than 2³¹ ms.
    expect(timeouts).toEqual([600_000, 70_000_000, 2 ** 31 - 1]);
  }));

test("two clips named alike but for their kind of file are two rows", () =>
  movies(async (folders) => {
    const at = site();
    await at.file(`_originals-${day}`, [
      ["assets/IMG_0001.MOV", "a phone's"],
      ["assets/IMG_0001.MP4", "another's"],
    ]);
    const rows = dayClips(await listed(at, folders), day);
    expect(rows.map((row) => [row.stem, row.original.name])).toEqual([
      ["IMG_0001", "IMG_0001.MOV"],
      ["IMG_0001.MP4", "IMG_0001.MP4"],
    ]);
    expect(await bringAll(at, folders, { what: "original", day })).toMatchObject({ landed: 2, failed: [] });
    expect(files(folders.original)).toEqual(["IMG_0001.MOV", "IMG_0001.MP4"]);
  }));

test("asks for clips by name, or a day's that aren't here, and says what isn't there", () =>
  movies(async (folders) => {
    const at = site();
    await at.file(`_originals-${day}`, [
      [`assets/${A}`, "one"],
      ["assets/IMG_0001.MOV", "the 18th's"],
    ]);
    await at.file("_originals-2026-11-17", [["assets/IMG_0001.MOV", "the 17th's"]]);
    writeFileSync(join(folders.original, A), "one");
    const clips = await listed(at, folders);
    expect(pickClips(clips, { what: "original", day }).map((clip) => clip.name)).toEqual(["IMG_0001.MOV"]);
    expect(pickClips(clips, { what: "original", names: ["IMG_0001.MOV"], day })[0].sha256).toBe(sha("the 18th's"));
    const why = (asked) => {
      try {
        pickClips(clips, asked);
      } catch (error) {
        return `${error.status} ${error.message}`;
      }
    };
    expect(why({ what: "original", names: ["IMG_0001.MOV"] })).toBe("400 Two days have a IMG_0001.MOV: say which");
    expect(why({ what: "graded", names: [A] })).toBe(`400 ${A} isn't in the archive as a graded copy`);
    expect(why({ what: "original", names: ["../../etc/passwd"] })).toMatch(
      /^400 .* isn't in the archive as an original$/,
    );
    for (const asked of [{}, { what: "everything", day }, { what: "original" }, { what: "original", names: [] }])
      expect(why(asked)).toMatch(/^400 /);
  }));

test("clears only what a run cut short by a restart left behind", () =>
  movies(async (folders) => {
    for (const name of [`.${A}.bring.part`, `.${A}.part`, A, "notes.bring.part"])
      writeFileSync(join(folders.original, name), "x");
    await clearParts([folders.original, join(folders.original, "nowhere")]);
    expect(files(folders.original)).toEqual([`.${A}.part`, A, "notes.bring.part"].sort());
  }));

// ---- the server end to end: a Movies folder with a clip graded and then offloaded, and an archive that holds it -------

const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const usable = spawnSync(ffmpeg, ["-version"]).status === 0;
const port = 9000 + Math.floor(Math.random() * 90);
const root = mkdtempSync(join(tmpdir(), "bring-server-"));
const original = join(root, "Movies/Original");
const exported = join(root, "Movies/Exported");
const data = join(root, "data");
const clipDay = "2026-03-01";
const name = "DJI_20260301101500_0007_D.MP4";
const gradedName = name.replace(".MP4", ".mp4");
const folder = `mac:${clipDay}`;
const slow = "DJI_20260302090000_0008_D.MP4";
const huge = "DJI_20260303090000_0009_D.MP4";
let server;
let film = null;
/** The archive's blobs by hash, its manifests by project, what it was asked, and what's let go of a blob held back. */
const held = { blobs: new Map(), manifests: new Map(), asked: [], slow: null, down: false, stall: false };
const archive = createServer((req, res) => {
  const path = decodeURIComponent(req.url.replace("/api/publisher/helper/archive/", "").split("?")[0]);
  held.asked.push(`${req.method} ${path}`);
  const reply = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (held.down) return req.socket.destroy();
  if (held.stall && req.method === "POST") return;
  if (path === "projects")
    return reply(200, {
      projects: [...held.manifests].map(([project, { archivedAt }]) => ({ name: project, archivedAt })),
    });
  const manifest = held.manifests.get(path.replace("projects/", ""));
  if (manifest) return reply(200, manifest);
  const blob = held.blobs.get(path.replace("blobs/", ""));
  if (!blob) return reply(404, { error: "Not found" });
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": blob.length });
  if (path !== `blobs/${held.slow}`) return res.end(blob);
  // Half of it, and then no more.
  res.write(blob.subarray(0, blob.length / 2));
});
function hold(project, path, body, lie = {}) {
  held.blobs.set(sha(body), body);
  const manifest = held.manifests.get(project) ?? { files: [], archivedAt: "2026-03-05T00:00:00.000Z" };
  manifest.files.push({ path, sha256: sha(body), size: body.length, mtime: MTIME, ...lie });
  held.manifests.set(project, manifest);
}

const url = (path) => `http://127.0.0.1:${port}${path}`;
const json = async (path) => (await fetch(url(path))).json();
const post = (path, body, method = "POST") =>
  fetch(url(path), {
    method,
    headers: { "X-Grade": "1", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const bringing = async () => (await json("/api/jobs")).bring;
/** Asks for clips and waits for the run to end. */
async function brought(asked) {
  const answer = await post("/api/bring", asked);
  if (!answer.ok) return { status: answer.status, ...(await answer.json()) };
  return until(async () => {
    const run = await bringing();
    return !run.running && run;
  });
}

beforeAll(async () => {
  if (!usable) return;
  for (const dir of [original, exported, join(data, "luts"), join(root, "publisher"), join(root, "cache/thumbs")])
    mkdirSync(dir, { recursive: true });
  const cube = new Float32Array(2 ** 3 * 3).fill(0.5);
  writeFileSync(join(data, "luts/dlog2-to-rec709-aces2.cube"), writeCube(2, cube, "grey"));
  writeFileSync(join(root, `cache/thumbs/${name.replace(".MP4", ".jpg")}`), "a picture");
  const source = join(root, "clip.mp4");
  execFileSync(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=1"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"],
    ...["-metadata", "com.dji.camera.ColorGammaSxS=D-Log2", "-movflags", "use_metadata_tags", source],
  ]);
  film = readFileSync(source);
  hold(`_originals-${clipDay}`, `assets/${name}`, film);
  hold(`_originals-${clipDay}`, `transcripts/${name.replace(".MP4", ".vtt")}`, Buffer.from("WEBVTT"));
  hold(`_graded-${clipDay}`, `assets/${gradedName}`, Buffer.from("the graded copy"));
  hold("_originals-2026-03-02", `assets/${slow}`, Buffer.alloc(1000, "slow"));
  hold("_originals-2026-03-03", `assets/${huge}`, Buffer.from("not really"), { size: 1e15 });
  held.slow = sha(Buffer.alloc(1000, "slow"));
  await new Promise((resolve) => archive.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${archive.address().port}`;
  writeFileSync(join(root, "publisher/config.json"), JSON.stringify({ origin, token: "t".repeat(64) }));
  // Left by a server killed as it brought a clip.
  writeFileSync(join(original, `.${name}.bring.part`), "half of it");
  server = spawn(process.execPath, [join(import.meta.dir, "server.mjs")], {
    env: {
      ...process.env,
      GRADE_ROOT: join(root, "Movies"),
      GRADE_DATA: data,
      GRADE_CACHE: join(root, "cache"),
      GRADE_CAMERA: join(root, "card/DCIM"),
      GRADE_PORT: String(port),
      GRADE_PUBLISHER: join(root, "publisher"),
      GRADE_LEDGER_EVERY: "600000",
      GRADE_KEEP_FREE: "1000000",
      GRADE_UVX: join(root, "no-uvx"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => server.stdout.on("data", (said) => String(said).includes("grade:") && resolve()));
}, 60_000);

afterAll(() => {
  server?.kill();
  archive.closeAllConnections?.();
  archive.close();
  rmSync(root, { recursive: true, force: true });
});

test.if(usable)("says what's in Cloudflare and not here, and opens a missing clip's day there", async () => {
  expect(files(original)).toEqual([]);
  const cloud = await json("/api/cloud");
  expect(cloud).toMatchObject({ paired: true, error: null, room: { keepFree: 1_000_000 } });
  expect(cloud.days.map((one) => [one.id, one.away])).toEqual([
    ["cloud:2026-03-03", 1],
    ["cloud:2026-03-02", 1],
    [`cloud:${clipDay}`, 1],
  ]);
  expect(cloud.days[2].original.missing).toEqual({ clips: 1, bytes: film.length });
  expect(cloud.clips).toBeUndefined();
  const asked = held.asked.length;
  const { clips } = await json(`/api/cloud?day=${clipDay}`);
  expect(clips).toEqual([
    {
      stem: name.replace(".MP4", ""),
      transcript: true,
      thumb: true,
      original: { name, size: film.length, sha256: sha(film), here: "no" },
      graded: { name: gradedName, size: 15, sha256: sha("the graded copy"), here: "no" },
    },
  ]);
  expect(held.asked).toHaveLength(asked);
  expect(await (await fetch(url(`/media/cloud/${name.replace(".MP4", ".jpg")}`))).text()).toBe("a picture");
  expect((await fetch(url("/media/cloud/..%2F..%2Fdata%2Fgrades.jpg"))).status).toBe(404);
  // The Footage tab's Grade, of a clip that's on neither the card nor this Mac.
  expect(await json(`/api/find?clip=${name}`)).toEqual({ source: `cloud:${clipDay}`, name });
  expect((await fetch(url("/api/find?clip=DJI_20200101000000_0001_D.MP4"))).status).toBe(404);
});

test.if(usable)(
  "brings a clip back to its day, where its grade still applies",
  async () => {
    // Graded while it was here, then offloaded.
    const grade = { base: "aces", exposure: 0.5, kelvin: 4800, tint: 0, contrast: 1, saturation: 1 };
    writeFileSync(join(original, name), film);
    expect((await post(`/api/sources/${folder}/grades`, { clips: { [name]: grade } }, "PUT")).status).toBe(200);
    rmSync(join(original, name));
    expect((await fetch(url(`/api/sources/${folder}`))).status).toBe(404);

    expect(await brought({ what: "original", names: [name] })).toMatchObject({
      finished: "done",
      error: null,
      landed: 1,
      failed: [],
      gotBytes: film.length,
    });
    expect(files(original)).toEqual([name]);
    expect(readFileSync(join(original, name))).toEqual(film);
    const library = await json("/api/library");
    expect(library.folders).toEqual([{ id: folder, label: clipDay, clips: 1, graded: 0 }]);
    const day = await json(`/api/sources/${folder}`);
    expect(day.clips[0]).toMatchObject({ name, profile: "dlog2", bytes: film.length });
    expect(day.grades).toEqual({ [name]: grade });
    expect(await json(`/api/find?clip=${name}`)).toEqual({ source: folder, name });
    const { days } = await json("/api/cloud");
    expect(days.find((one) => one.day === clipDay)).toMatchObject({ away: 1, original: { missing: { clips: 0 } } });

    // Exported, it's made with that grade.
    expect((await post("/api/export", { source: folder, names: [name] })).status).toBe(200);
    const record = await until(() => {
      const path = join(data, "exports.json");
      return existsSync(path) && JSON.parse(readFileSync(path, "utf8")).clips[name];
    }, 60_000);
    expect(record.grade).toEqual(grade);
    expect(record.key).toBe(gradeKey(grade));
  },
  90_000,
);

test.if(usable)(
  "a graded copy of another export stays in the archive; with that gone, it comes back among the exports",
  async () => {
    const export_ = readFileSync(join(exported, gradedName));
    const refused = await brought({ what: "graded", names: [gradedName] });
    expect(refused.failed).toMatchObject([{ name: gradedName, why: `Another file is already Exported/${gradedName}` }]);
    expect(readFileSync(join(exported, gradedName))).toEqual(export_);
    // A day's clips are those not here: this one's name is taken, so there's none.
    expect(await brought({ what: "graded", day: clipDay })).toMatchObject({ landed: 0 });
    rmSync(join(exported, gradedName));
    expect(await brought({ what: "graded", day: clipDay })).toMatchObject({ landed: 1, failed: [] });
    expect(text(exported, gradedName)).toBe("the graded copy");
    expect(files(exported)).toEqual([gradedName]);
    // The original of the same name but for its case is another file, and as it was.
    expect(readFileSync(join(original, name))).toEqual(film);
  },
  30_000,
);

test.if(usable)("says how far a clip is while it comes, and stops, keeping nothing of it", async () => {
  expect((await post("/api/bring", { what: "original", day: "2026-03-02" })).status).toBe(200);
  const run = await until(async () => {
    const now = await bringing();
    return now.current?.got === 500 && now;
  });
  expect(run).toMatchObject({
    running: true,
    total: 1,
    bytes: 1000,
    gotBytes: 500,
    current: { what: "original", name: slow, size: 1000 },
  });
  expect(files(original)).toEqual([`.${slow}.bring.part`, name]);
  // A half-come clip isn't one of the day's.
  expect((await json("/api/library")).folders.map((one) => one.id)).toEqual([folder]);
  expect((await post("/api/bring/stop", {})).status).toBe(200);
  const ended = await until(async () => {
    const now = await bringing();
    return !now.running && now;
  });
  expect(ended).toMatchObject({ finished: "stopped", error: null, landed: 0 });
  expect(files(original)).toEqual([name]);
});

test.if(usable)("refuses what there's no room for, what isn't there, and other origins' requests", async () => {
  const noRoom = await brought({ what: "original", day: "2026-03-03" });
  expect(noRoom).toMatchObject({ status: 409 });
  expect(noRoom.error).toMatch(/^No room on this Mac: 1000000\.0 GB to bring, .* GB free, 0\.0 GB of it kept free$/);
  expect(await brought({ what: "original", names: ["../../x.MP4"] })).toMatchObject({ status: 400 });
  expect(await brought({ what: "all", day: clipDay })).toMatchObject({ status: 400 });
  expect((await fetch(url("/api/bring"), { method: "POST", body: "{}" })).status).toBe(403);
  expect(files(original)).toEqual([name]);
  // Nothing was ever asked of the archive but to say what it has, bar the ledger the app keeps there.
  expect(held.asked.filter((ask) => !ask.startsWith("GET ") && !ask.includes(" ledger"))).toEqual([]);
});

/** A file that says it's 10 TB and takes none of the disk. */
function vast(path) {
  writeFileSync(path, "");
  truncateSync(path, 1e13);
}

test.if(usable)(
  "leaves room for what an export has still to write",
  async () => {
    const next = "DJI_20260301101600_0008_D.MP4";
    vast(join(original, next));
    const busy = join(original, "DJI_20260301101700_0009_D.MP4");
    const lavfi = [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=1280x720:r=24:d=60",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      busy,
    ];
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...lavfi]);
    expect((await post("/api/export", { source: folder, names: [busy.split("/").at(-1), next] })).status).toBe(200);
    expect((await json("/api/jobs")).export.queue).toHaveLength(1);
    const refused = await brought({ what: "original", names: [slow] });
    expect(refused).toMatchObject({ status: 409 });
    expect(refused.error).toMatch(/kept free, and 10000\.\d GB still to come from the 2 exports$/);
    await post("/api/export/stop", {});
    await until(async () => !(await json("/api/jobs")).export.current);
    for (const path of [busy, join(original, next)]) rmSync(path);
  },
  60_000,
);

test.if(usable)(
  "leaves room for what an offload has still to copy off the camera",
  async () => {
    const card = join(root, "card/DCIM/DJI_001");
    mkdirSync(card, { recursive: true });
    vast(join(card, "DJI_20260304090000_0010_D.MP4"));
    // The card's listing is kept a few seconds.
    await until(async () => (await json("/api/offload")).camera.clips === 1);
    // The Mac's clip is going up, and the archive doesn't answer: the copy waits for the room that would make.
    held.stall = true;
    expect((await post("/api/offload", {})).status).toBe(200);
    await until(async () => (await json("/api/jobs")).offload.waiting === "room");
    const refused = await brought({ what: "original", names: [slow] });
    expect(refused).toMatchObject({ status: 409 });
    expect(refused.error).toMatch(/kept free, and 10000\.0 GB still to come from the camera$/);
    await post("/api/offload/stop", {});
    await until(async () => !(await json("/api/jobs")).offload.running);
    held.stall = false;
    rmSync(join(root, "card"), { recursive: true });
    expect(files(original)).toEqual([name]);
  },
  30_000,
);

test.if(usable)(
  "says when the archive can't be read, with the days as last read, and a run then ends saying why",
  async () => {
    held.down = true;
    const cloud = await json("/api/cloud?refresh=1");
    expect(cloud.error).toMatch(/^Couldn't read the Cloudflare archive: /);
    expect(cloud.days).toHaveLength(3);
    const run = await brought({ what: "original", names: [slow] });
    expect(run).toMatchObject({ finished: null, landed: 0, queued: [] });
    expect(run.error).toMatch(new RegExp(`^${slow} didn't come: `));
    expect(files(original)).toEqual([name]);
    const missing = await fetch(url("/api/find?clip=DJI_20200101000000_0001_D.MP4"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatch(/Couldn't read the Cloudflare archive/);
  },
  30_000,
);
