import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveResponse } from "../../src/lib/publisher/archive.ts";
import { memoryArchive, memoryMedia } from "../../src/lib/publisher/memory-archive.ts";
import { archiveClient, archiveProject } from "./archive.mjs";
import {
  archiveFootage,
  clipDescription,
  clipTitle,
  exportedClips,
  footageStatus,
  progressMeter,
  readState,
  uploadFootage,
  uploadVideo,
  watchedFootage,
  watchFootage,
} from "./footage.mjs";

const HOUR = 60 * 60_000;
const record = {
  source: "Pocket 4P: DCIM/DJI_001/DJI_20261115224628_0313_D.MP4",
  profile: "dlog2",
  base: { id: "opendrt-colorful", name: "Colorful" },
  grade: { base: "opendrt-colorful", exposure: 0, kelvin: null, contrast: 1.3 },
  exportedAt: "2026-11-16T04:12:16.287Z",
};

/** YouTube's upload endpoints in memory: they check every part lands where the last one ended. */
function youtube({ granularity = 4, failOnce = null } = {}) {
  const parts = [];
  const calls = [];
  let held = 0;
  let finished = false;
  let failed = false;
  const client = {
    async start(payload) {
      calls.push(["start", payload]);
      held = 0;
      finished = false;
      return new Response(null, {
        headers: {
          "x-goog-upload-url": "https://upload.example/1",
          "x-goog-upload-chunk-granularity": String(granularity),
        },
      });
    },
    async send(url, init) {
      expect(url).toBe("https://upload.example/1");
      const command = init.headers["x-goog-upload-command"];
      if (command === "query")
        return new Response(null, {
          headers: {
            "x-goog-upload-status": finished ? "final" : "active",
            "x-goog-upload-size-received": String(held),
          },
        });
      const offset = Number(init.headers["x-goog-upload-offset"]);
      if (offset === failOnce && !failed) {
        failed = true;
        throw new Error("network went away");
      }
      expect(offset).toBe(held);
      held += init.body.length;
      parts.push([command, init.body.length]);
      if (command === "upload, finalize") {
        finished = true;
        return Response.json({ status: "STATUS_SUCCESS", scottyResourceId: "scotty-1" });
      }
      return new Response(null);
    },
    async create(body) {
      calls.push(["create", body]);
      return { success: true, data: { contents: [{ videoId: "abcDEF12345" }] } };
    },
  };
  return { client, parts, calls, held: (bytes) => (held = bytes) };
}

const bytes = (text) => ({
  size: text.length,
  read: async (offset, length) => Buffer.from(text.slice(offset, offset + length)),
});

test("a clip is titled by the camera's clock and described by its grade", () => {
  expect(clipTitle("DJI_20261115224628_0313_D.mp4")).toBe("2026-11-15 22:46:28 · clip 0313");
  expect(clipTitle("IMG_4857.MOV")).toBe("IMG_4857");
  expect(clipDescription("DJI_20261115224628_0313_D.mp4", record)).toBe(
    "DJI_20261115224628_0313_D, graded footage.\n" +
      "Source: Pocket 4P: DCIM/DJI_001/DJI_20261115224628_0313_D.MP4\n" +
      "Grade: Colorful from dlog2 (exposure 0, contrast 1.3)\n" +
      "Exported 2026-11-16",
  );
  expect(clipDescription("DJI_20261115224628_0313_D.mp4")).toBe("DJI_20261115224628_0313_D, graded footage.");
  // A grade with the export's deflicker on says so; off, a grade has no deflicker field at all.
  const deflickered = { ...record, grade: { ...record.grade, deflicker: "light" } };
  const described = clipDescription("DJI_20261115224628_0313_D.mp4", deflickered);
  expect(described).toContain("(exposure 0, contrast 1.3, deflicker light)");
});

test("a file goes up in whole chunks, the last part finishing it, as an unlisted video", async () => {
  const yt = youtube();
  const saved = [];
  const id = await uploadVideo(
    yt.client,
    bytes("0123456789"),
    { title: "T", description: "D" },
    {
      chunk: 5,
      save: async (session) => saved.push(session),
    },
  );
  expect(id).toBe("abcDEF12345");
  // 5 bytes round down to one 4-byte chunk of YouTube's.
  expect(yt.parts).toEqual([
    ["upload", 4],
    ["upload", 4],
    ["upload, finalize", 2],
  ]);
  expect(saved).toHaveLength(1);
  const [, created] = yt.calls.find(([call]) => call === "create");
  expect(created.resourceId.scottyResourceId.id).toBe("scotty-1");
  expect(created.frontendUploadId).toBe(saved[0].frontendUploadId);
  expect(created.initialMetadata.privacy.newPrivacy).toBe("UNLISTED");
  expect(created.initialMetadata.title.newTitle).toBe("T");
});

test("an upload cut short resumes where YouTube says it stopped, and a failed part is sent again", async () => {
  const yt = youtube({ failOnce: 8 });
  yt.held(4);
  const session = { url: "https://upload.example/1", frontendUploadId: "earlier", granularity: 4 };
  const waits = [];
  const id = await uploadVideo(
    yt.client,
    bytes("0123456789"),
    { title: "T", description: "D" },
    {
      session,
      chunk: 4,
      wait: async (ms) => waits.push(ms),
    },
  );
  expect(id).toBe("abcDEF12345");
  expect(yt.calls.some(([call]) => call === "start")).toBe(false);
  expect(yt.parts).toEqual([
    ["upload", 4],
    ["upload, finalize", 2],
  ]);
  expect(waits).toEqual([5000]);
  expect(yt.calls.find(([call]) => call === "create")[1].frontendUploadId).toBe("earlier");
});

/** A state folder, an export folder of two graded clips and a stray file, and the grade app's record of the two. */
async function footage(root) {
  const stateDir = join(root, "state");
  const exported = join(root, "Exported");
  await mkdir(stateDir, { recursive: true });
  await mkdir(exported, { recursive: true });
  // Exported days before any clock the tests run on.
  const old = new Date("2026-11-11T12:00:00Z");
  for (const [name, body] of [
    ["DJI_20261111161230_0258_D.mp4", "first clip"],
    ["DJI_20261111161344_0259_D.mp4", "second clip"],
    ["notes.txt", "not footage"],
  ]) {
    await writeFile(join(exported, name), body);
    await utimes(join(exported, name), old, old);
  }
  const exportsFile = join(root, "exports.json");
  await writeFile(
    exportsFile,
    JSON.stringify({
      clips: { "DJI_20261111161230_0258_D.MP4": record, "DJI_20261111161344_0259_D.MP4": record },
    }),
  );
  return { stateDir, exported, exportsFile };
}

test("only the grade app's finished exports are footage", async () => {
  const root = await mkdtemp(join(tmpdir(), "footage-"));
  try {
    const { exported, exportsFile } = await footage(root);
    await writeFile(join(exported, "DJI_20261111161531_0260_D.mp4"), "still being written");
    const clips = await exportedClips({ exported, exportsFile });
    expect(clips.map((clip) => clip.name)).toEqual(["DJI_20261111161230_0258_D.mp4", "DJI_20261111161344_0259_D.mp4"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clips go up a day's worth at a time, a regraded clip again, and a failure waits before the next try", async () => {
  const root = await mkdtemp(join(tmpdir(), "footage-"));
  try {
    const { stateDir, exported, exportsFile } = await footage(root);
    const yt = youtube({ granularity: 256 * 1024 });
    let connects = 0;
    const connect = async () => {
      connects++;
      return yt.client;
    };
    let clock = Date.parse("2026-11-17T10:00:00Z");
    const run = (extra = {}) =>
      uploadFootage({ stateDir, config: {}, connect, exported, exportsFile, now: () => clock, daily: 1, ...extra });

    expect(await run()).toEqual({ uploaded: 1, left: 1 });
    expect(await run()).toEqual({ uploaded: 0, left: 1 });
    clock += 24 * HOUR;
    expect(await run()).toEqual({ uploaded: 1, left: 0 });
    let state = await readState(stateDir);
    expect(Object.keys(state.clips)).toEqual(["DJI_20261111161230_0258_D.mp4", "DJI_20261111161344_0259_D.mp4"]);
    expect(state.clips["DJI_20261111161230_0258_D.mp4"][0]).toMatchObject({ video: "abcDEF12345", from: "exported" });

    // Graded again: a new export under the same name goes up as a new video.
    const later = new Date(clock - HOUR);
    await writeFile(join(exported, "DJI_20261111161230_0258_D.mp4"), "first clip, graded warmer");
    await utimes(join(exported, "DJI_20261111161230_0258_D.mp4"), later, later);
    clock += 24 * HOUR;
    yt.client.create = async () => ({ success: false, data: {} });
    await expect(run()).rejects.toThrow("didn't confirm");
    state = await readState(stateDir);
    expect(state.pausedUntil).toBe(clock + HOUR / 2);
    expect(state.lastError.clip).toBe("DJI_20261111161230_0258_D.mp4");
    const before = connects;
    expect((await run()).pausedUntil).toBe(clock + HOUR / 2);
    expect(connects).toBe(before);

    yt.client.create = async () => ({ success: true, data: { videoId: "regraded123" } });
    clock += HOUR;
    expect(await run()).toEqual({ uploaded: 1, left: 0 });
    state = await readState(stateDir);
    expect(state.clips["DJI_20261111161230_0258_D.mp4"].map((v) => v.video)).toEqual(["abcDEF12345", "regraded123"]);
    expect(state.failures).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** The site's archive routes, answered in memory, as the laptop's fetch reaches them. */
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
  return { origin: "https://post.kualta.dev", token: "token", fetcher };
}

test("a clip only the archive still holds goes up from there, checked against its hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "footage-"));
  try {
    const { stateDir, exportsFile } = await footage(root);
    const exported = join(root, "empty");
    await mkdir(exported);
    const auth = site();
    const film = join(root, "013-maybe-later");
    await mkdir(join(film, "assets"), { recursive: true });
    await writeFile(join(film, "film.html"), "<!doctype html>");
    await writeFile(join(film, "assets/DJI_20261108122204_0086_D.mp4"), "bikes on the road");
    await writeFile(join(film, "assets/song.mp3"), "not footage");
    await archiveProject(film, auth);
    await rm(film, { recursive: true });

    const yt = youtube({ granularity: 256 * 1024 });
    const request = archiveClient(auth);
    const run = () =>
      uploadFootage({ stateDir, config: {}, connect: async () => yt.client, request, exported, exportsFile });
    expect(await run()).toEqual({ uploaded: 1, left: 0 });
    expect(yt.parts).toEqual([["upload, finalize", "bikes on the road".length]]);
    const state = await readState(stateDir);
    expect(state.clips["DJI_20261108122204_0086_D.mp4"][0]).toMatchObject({ from: "archive", size: 17 });
    expect(await run()).toEqual({ uploaded: 0, left: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Lets the timers of a test run go by at once. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
/** A part that hangs until its own signal aborts, as one in flight when the Archive tab closes. */
const hangs = (init) =>
  new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
const first = "DJI_20261111161230_0258_D.mp4";
const second = "DJI_20261111161344_0259_D.mp4";

test("the Archive tab closing stops a part in flight, with nothing to wait out, and the upload resumes there", async () => {
  const root = await mkdtemp(join(tmpdir(), "footage-"));
  try {
    const { stateDir, exported, exportsFile } = await footage(root);
    const yt = youtube();
    const send = yt.client.send;
    const stop = new AbortController();
    yt.client.send = (url, init) => {
      if (init.signal && init.headers["x-goog-upload-offset"] === "4") {
        setTimeout(() => stop.abort(), 1);
        return hangs(init);
      }
      return send(url, init);
    };
    const heard = [];
    const run = (extra = {}) =>
      uploadFootage({
        stateDir,
        config: {},
        connect: async () => yt.client,
        exported,
        exportsFile,
        chunk: 4,
        ...extra,
      });
    expect(await run({ signal: stop.signal, progress: (p) => heard.push([p.name, p.sent]) })).toEqual({
      uploaded: 0,
      left: 2,
      stopped: true,
    });
    expect(heard).toEqual([
      [first, 0],
      [first, 0],
      [first, 4],
    ]);
    let state = await readState(stateDir);
    expect(state.current.name).toBe(first);
    expect(state.pausedUntil).toBeUndefined();
    expect(state.failures).toBeUndefined();

    yt.client.send = send;
    const starts = yt.calls.filter(([call]) => call === "start").length;
    expect(await run()).toEqual({ uploaded: 2, left: 0 });
    // The first clip carried on from YouTube's 4 bytes; only the second started a new upload.
    expect(yt.calls.filter(([call]) => call === "start").length).toBe(starts + 1);
    state = await readState(stateDir);
    expect(Object.keys(state.clips)).toEqual([first, second]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the speed is bytes over the last minute of parts, carried on to the next clip", () => {
  let clock = 0;
  const meter = progressMeter(() => clock);
  meter.update({ name: "a", size: 10e6, sent: 0, from: "exported" });
  expect(meter.speed).toBeNull();
  clock = 2_000;
  meter.update({ name: "a", size: 10e6, sent: 4e6, from: "exported" });
  expect(meter.speed).toBe(2e6);
  clock = 120_000;
  meter.update({ name: "a", size: 10e6, sent: 5e6, from: "exported" });
  // The minute-old part no longer counts: 1 MB in the last 118 seconds.
  expect(Math.round(meter.speed)).toBe(Math.round(1e6 / 118));
  meter.update({ name: "b", size: 10e6, sent: 0, from: "exported" });
  expect(meter.current).toEqual({ name: "b", size: 10e6, sent: 0, from: "exported" });
  expect(Math.round(meter.speed)).toBe(Math.round(1e6 / 118));
  meter.clear();
  expect(meter.current).toBeNull();
});

test("the tab's status lists every clip, the one going up, and what's left today", async () => {
  const root = await mkdtemp(join(tmpdir(), "footage-"));
  try {
    const { stateDir, exported, exportsFile } = await footage(root);
    const yt = youtube({ granularity: 256 * 1024 });
    const now = Date.parse("2026-11-21T10:00:00Z");
    const config = { footage: { channel: "@archive", daily: 2 } };
    await uploadFootage({
      stateDir,
      config,
      connect: async () => yt.client,
      exported,
      exportsFile,
      now: () => now,
      daily: 1,
    });
    const archived = [{ name: "DJI_20261108122204_0086_D.mp4", sha256: "ab", size: 17, from: "archive" }];
    const status = await footageStatus({
      stateDir,
      config,
      exported,
      exportsFile,
      archived,
      progress: { name: second, size: 11, sent: 3, from: "exported" },
      speed: 2e6,
      now,
    });
    expect(status).toMatchObject({
      channel: "@archive",
      daily: 2,
      today: 1,
      state: "uploading",
      pausedUntil: null,
      current: { name: second, sent: 3, title: "2026-11-11 16:13:44 · clip 0259" },
      speed: 2e6,
      // Today has room for one more: the export going up, 8 of its 11 bytes still to send.
      totals: { up: 1, upBytes: 10, due: 2, dueBytes: 11 + 17 - 3, today: 1, todayBytes: 8 },
    });
    expect(status.clips.map((clip) => [clip.name, clip.state, clip.from])).toEqual([
      [second, "uploading", "exported"],
      [first, "up", "exported"],
      ["DJI_20261108122204_0086_D.mp4", "due", "archive"],
    ]);
    expect(status.clips[1].video).toBe("abcDEF12345");

    const idle = await footageStatus({ stateDir, config: { footage: { daily: 1 } }, exported, exportsFile, now });
    expect(idle).toMatchObject({ state: "limit", current: null, totals: { due: 1, today: 0 } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the helper uploads while the tab is open, reporting each part's progress and speed", async () => {
  const root = await mkdtemp(join(tmpdir(), "footage-"));
  try {
    const { stateDir, exported, exportsFile } = await footage(root);
    const yt = youtube();
    const send = yt.client.send;
    // Each part takes a few milliseconds, as parts take seconds on a real uplink.
    yt.client.send = async (url, init) => {
      if (init.signal) await new Promise((resolve) => setTimeout(resolve, 5));
      return send(url, init);
    };
    const statuses = [];
    const ask = async (status) => {
      statuses.push(status);
      return { watching: status.state !== "done" };
    };
    const config = { footage: { channel: "@archive" } };
    await watchedFootage({
      stateDir,
      config,
      ask,
      connect: async () => yt.client,
      exported,
      exportsFile,
      chunk: 4,
      wait: tick,
    });
    expect(Object.keys((await readState(stateDir)).clips)).toEqual([first, second]);
    expect(statuses[0]).toMatchObject({ state: "waiting", channel: "@archive", totals: { up: 0, due: 2 } });
    expect(statuses.some((s) => s.state === "uploading" && s.current.sent > 0 && s.speed > 0)).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ state: "done", current: null, totals: { up: 2, due: 0 } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploads stop when the site stops answering, since there's no telling whether the tab is open", async () => {
  const root = await mkdtemp(join(tmpdir(), "footage-"));
  try {
    const { stateDir, exported, exportsFile } = await footage(root);
    const yt = youtube();
    const send = yt.client.send;
    yt.client.send = (url, init) => (init.signal ? hangs(init) : send(url, init));
    let asks = 0;
    const ask = async () => {
      if (++asks > 1) throw new Error("fetch failed");
      return { watching: true };
    };
    const logs = [];
    await watchedFootage({
      stateDir,
      config: {},
      ask,
      connect: async () => yt.client,
      exported,
      exportsFile,
      wait: tick,
      log: (line) => logs.push(line),
    });
    expect(asks).toBe(4);
    expect(logs.some((line) => line.includes("didn't answer"))).toBe(true);
    const state = await readState(stateDir);
    expect(state.current.name).toBe(first);
    expect(state.pausedUntil).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("with the tab shut nothing goes up, and nothing is asked until the footage archive is connected", async () => {
  const root = await mkdtemp(join(tmpdir(), "footage-"));
  try {
    const { stateDir, exported, exportsFile } = await footage(root);
    const connect = async () => {
      throw new Error("nothing should go up");
    };
    const shut = new AbortController();
    let asks = 0;
    await watchFootage({
      stateDir,
      exported,
      exportsFile,
      connect,
      loadConfig: async () => ({ platforms: ["youtube-footage"] }),
      ask: async (status) => {
        expect(status).toBeNull();
        if (++asks === 3) shut.abort();
        return { watching: false };
      },
      wait: tick,
      signal: shut.signal,
    });
    expect(asks).toBe(3);

    const unconnected = new AbortController();
    let loads = 0;
    await watchFootage({
      stateDir,
      connect,
      loadConfig: async () => {
        if (++loads === 3) unconnected.abort();
        return { platforms: [] };
      },
      ask: async () => {
        throw new Error("nothing should be asked");
      },
      wait: tick,
      signal: unconnected.signal,
    });
    expect(loads).toBe(3);
    expect((await readState(stateDir)).clips).toEqual({});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a site that's down is logged once, not every time the helper asks", async () => {
  const done = new AbortController();
  const logs = [];
  let asks = 0;
  await watchFootage({
    loadConfig: async () => ({ platforms: ["youtube-footage"] }),
    ask: async () => {
      if (++asks === 4) done.abort();
      throw new Error(asks < 3 ? "fetch failed" : "Publisher request failed (503)");
    },
    log: (line) => logs.push(line),
    wait: tick,
    signal: done.signal,
  });
  expect(logs).toEqual(["Footage archive: fetch failed", "Footage archive: Publisher request failed (503)"]);
});

test("a shoot day's offloaded originals and their transcripts aren't graded footage, so they never go to YouTube", async () => {
  const file = (name) => ({ path: `assets/${name}`, sha256: "ab", size: 1 });
  const transcripts = (clip) =>
    ["vtt", "json", "mp4"].map((ext) => ({ path: `transcripts/${clip}.${ext}`, sha256: "cd", size: 1 }));
  const projects = {
    "_originals-2026-11-08": [file("DJI_20261108115341_0022_D.MP4"), ...transcripts("DJI_20261108115341_0022_D")],
    // Nor would they from a film a day was brought back into.
    "014-walk": [
      file("DJI_20261115224628_0313_D.mp4"),
      ...transcripts("DJI_20261115224628_0314_D"),
      file("DJI_20261115224628_0315_D.vtt"),
      file("DJI_20261115224628_0315_D.json"),
    ],
  };
  const request = async (path) =>
    path === "projects"
      ? { projects: Object.keys(projects).map((name) => ({ name })) }
      : { files: projects[path.slice("projects/".length)] };
  expect((await archiveFootage(request)).map((clip) => clip.name)).toEqual(["DJI_20261115224628_0313_D.mp4"]);
});
