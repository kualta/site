import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveResponse } from "../../src/lib/publisher/archive.ts";
import { memoryArchive, memoryMedia } from "../../src/lib/publisher/memory-archive.ts";
import { archiveClient, archiveProject } from "./archive.mjs";
import { clipDescription, clipTitle, exportedClips, readState, uploadFootage, uploadVideo } from "./footage.mjs";

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
