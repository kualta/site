import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archivedFootage,
  comparable,
  ledgerCloud,
  mergeLedger,
  recordedAt,
  unionLedgers,
  youtubeUploads,
} from "./ledger.mjs";

const A = "DJI_20261111161230_0258_D";
const B = "DJI_20261108122204_0086_D";
const record = { profile: "dlog2", base: { name: "Umbra" }, exportedAt: "2026-11-12T17:03:56.093Z" };

/** What the grade app sees, nothing unless given. */
const seen = (at, extra = {}) => ({
  at,
  camera: { name: "Pocket 4P", mounted: false, clips: [] },
  mac: [],
  metas: new Map(),
  exports: {},
  exported: [],
  grades: [],
  youtube: {},
  archive: null,
  ...extra,
});

test("a clip's recording time is the camera's clock in its name", () => {
  expect(recordedAt(`${A}.MP4`)).toBe("2026-11-11T16:12:30");
  expect(recordedAt("IMG_4857.MOV", "fallback")).toBe("fallback");
});

test("a clip is followed off the card, through grading, onto YouTube and into the archive, and keeps its record", () => {
  const card = { name: "Pocket 4P", mounted: true, clips: [{ name: `${A}.MP4`, size: 1000 }] };
  let ledger = mergeLedger(
    null,
    seen("2026-11-11T18:00:00Z", {
      camera: card,
      metas: new Map([[A.toLowerCase(), { profile: "dlog2", duration: 12.5 }]]),
    }),
  );
  expect(ledger.clips[A]).toEqual({
    name: `${A}.MP4`,
    recorded: "2026-11-11T16:12:30",
    profile: "dlog2",
    duration: 12.5,
    size: 1000,
    original: { camera: true, mac: false, cloudflare: false },
    graded: null,
    gradePending: false,
    firstSeen: "2026-11-11T18:00:00Z",
  });
  expect(ledger.camera).toEqual({ name: "Pocket 4P", mounted: true, seenAt: "2026-11-11T18:00:00Z" });

  // Unplugged: the card's clips stay as last seen. A grade is saved but not exported yet.
  ledger = mergeLedger(ledger, seen("2026-11-12T09:00:00Z", { grades: [`${A}.MP4`] }));
  expect(ledger.clips[A].original.camera).toBe(true);
  expect(ledger.clips[A].gradePending).toBe(true);
  expect(ledger.camera).toEqual({ name: "Pocket 4P", mounted: false, seenAt: "2026-11-11T18:00:00Z" });

  // Exported.
  const exported = [{ name: `${A}.mp4`, size: 300, mtime: Date.parse("2026-11-12T17:03:56Z") }];
  ledger = mergeLedger(
    ledger,
    seen("2026-11-12T18:00:00Z", { exports: { [`${A}.MP4`]: record }, exported, grades: [`${A}.MP4`] }),
  );
  expect(ledger.clips[A].graded).toEqual({
    look: "Umbra",
    at: "2026-11-12T17:03:56.093Z",
    size: 300,
    mac: true,
    cloudflare: false,
    youtube: null,
  });
  expect(ledger.clips[A].gradePending).toBe(false);

  // Up on YouTube and in a film's archive.
  const youtube = { [`${A}.mp4`]: [{ video: "v1", size: 300, uploadedAt: "2026-11-17T10:00:00Z" }] };
  const archive = [{ name: `${A}.mp4`, size: 300, sha256: "ab", project: "013-maybe-later" }];
  ledger = mergeLedger(
    ledger,
    seen("2026-11-17T11:00:00Z", { exports: { [`${A}.MP4`]: record }, exported, youtube, archive }),
  );
  expect(ledger.clips[A].graded).toMatchObject({
    mac: true,
    cloudflare: "current",
    youtube: { video: "v1", at: "2026-11-17T10:00:00Z", current: true },
  });

  // The card is wiped and the film cleaned up: the clip's copies are the archive's and YouTube's.
  ledger = mergeLedger(
    ledger,
    seen("2026-11-18T09:00:00Z", {
      camera: { ...card, clips: [] },
      exports: { [`${A}.MP4`]: record },
      youtube,
      archive,
    }),
  );
  expect(ledger.clips[A].original).toEqual({ camera: false, mac: false, cloudflare: false });
  expect(ledger.clips[A].graded).toMatchObject({
    size: 300,
    mac: false,
    cloudflare: "current",
    youtube: { current: true },
  });
  expect(ledger.clips[A].size).toBe(1000);

  // Graded again: what's on YouTube and in the archive is an earlier grade now.
  const regraded = [{ name: `${A}.mp4`, size: 310, mtime: Date.parse("2026-11-19T10:00:00Z") }];
  ledger = mergeLedger(
    ledger,
    seen("2026-11-19T11:00:00Z", { exports: { [`${A}.MP4`]: record }, exported: regraded, youtube, archive }),
  );
  expect(ledger.clips[A].graded).toMatchObject({
    size: 310,
    mac: true,
    cloudflare: "earlier",
    youtube: { current: false },
  });

  // The archive not asked this time: its answer stays as it was.
  const kept = mergeLedger(
    ledger,
    seen("2026-11-19T12:00:00Z", { exports: { [`${A}.MP4`]: record }, exported: regraded, youtube }),
  );
  expect(kept.clips[A].graded.cloudflare).toBe("earlier");
  expect(kept.archiveAt).toBe("2026-11-19T11:00:00Z");
});

test("an offloaded original counts as the original in Cloudflare, and its day isn't a film", () => {
  const card = { name: "Pocket 4P", mounted: true, clips: [{ name: `${A}.MP4`, size: 1000 }] };
  const archive = [{ name: `${A}.MP4`, size: 1000, sha256: "ab", project: "_originals-2026-11-11" }];
  const ledger = mergeLedger(null, seen("2026-11-21T10:00:00Z", { camera: card, archive }));
  expect(ledger.clips[A].original).toEqual({ camera: true, mac: false, cloudflare: true });
  expect(ledger.clips[A].graded).toBeNull();
  expect(ledger.projects).toEqual({});
});

test("the settings kept in the archive are no footage", async () => {
  const card = { name: "Pocket 4P", mounted: true, clips: [{ name: `${A}.MP4`, size: 1000 }] };
  const manifests = {
    "_originals-2026-11-11": [{ path: `assets/${A}.MP4`, size: 1000, sha256: "ab" }],
    _settings: [{ path: "assets/grades.mp4", size: 5, sha256: "ef" }],
  };
  const asked = [];
  const archive = await archivedFootage(async (path) => {
    asked.push(path.split("?")[0]);
    if (path === "projects")
      return { projects: Object.keys(manifests).map((name) => ({ name, archivedAt: "2026-11-21T09:00:00.000Z" })) };
    return { files: manifests[path.split("/")[1].split("?")[0]] };
  });
  expect(asked).toEqual(["projects", "projects/_originals-2026-11-11"]);
  const ledger = mergeLedger(null, seen("2026-11-21T10:01:00Z", { camera: card, archive }));
  expect(ledger.clips[A].original).toEqual({ camera: true, mac: false, cloudflare: true });
  expect(Object.keys(ledger.clips)).toEqual([A]);
  expect(ledger.projects).toEqual({});
});

test("what's offloaded shows as in Cloudflare before the archive is asked again", () => {
  const card = { name: "Pocket 4P", mounted: true, clips: [{ name: `${A}.MP4`, size: 1000 }] };
  const before = mergeLedger(null, seen("2026-11-21T10:00:00Z", { camera: card, archive: [] }));
  const landed = [
    { name: `${A}.MP4`, size: 1000 },
    // One the ledger never saw.
    { name: `${B}.MP4`, size: 7 },
  ];
  const gone = { name: "Pocket 4P", mounted: true, clips: [] };
  const after = mergeLedger(before, seen("2026-11-21T10:00:30Z", { camera: gone, landed }));
  expect(after.clips[A].original).toEqual({ camera: false, mac: false, cloudflare: true });
  expect(Object.keys(after.clips)).toEqual([A]);
  // A file of another size isn't the original.
  const other = mergeLedger(before, seen("2026-11-21T10:00:30Z", { landed: [{ name: `${A}.MP4`, size: 999 }] }));
  expect(other.clips[A].original.cloudflare).toBe(false);
});

test("a transcript in a day's originals is no footage: it only marks its clip", async () => {
  const request = async (path) =>
    path === "projects"
      ? { projects: [{ name: "_originals-2026-11-11", archivedAt: "2026-11-21T09:00:00.000Z", versions: 3 }] }
      : {
          files: [
            { path: `assets/${A}.MP4`, size: 1000, sha256: "ab" },
            { path: `transcripts/${A}.vtt`, size: 20, sha256: "cd" },
            { path: `transcripts/${A}.json`, size: 30, sha256: "ef" },
            // However a clip is named, what's in transcripts/ isn't it.
            { path: `transcripts/${B}.mp4`, size: 40, sha256: "01" },
          ],
        };
  const archive = await archivedFootage(request);
  expect(archive).toEqual([{ name: `${A}.MP4`, size: 1000, sha256: "ab", project: "_originals-2026-11-11" }]);

  const card = { name: "Pocket 4P", mounted: true, clips: [{ name: `${A}.MP4`, size: 1000 }] };
  const before = mergeLedger(null, seen("2026-11-21T10:00:00Z", { camera: card, archive, transcripts: [] }));
  expect(before.clips[A].graded).toBeNull();
  expect(before.clips[A]).not.toHaveProperty("transcript");
  // Once it's filed, and for good; a clip the ledger doesn't know isn't made one by its transcript.
  const transcripts = [`${A}.MP4`, `${B}.MP4`];
  const filed = mergeLedger(before, seen("2026-11-21T10:01:00Z", { camera: card, archive, transcripts }));
  expect(Object.keys(filed.clips)).toEqual([A]);
  expect(filed.clips[A].transcript).toBe(true);
  expect(comparable(filed)).not.toBe(comparable(before));
  expect(mergeLedger(filed, seen("2026-11-21T10:02:00Z")).clips[A].transcript).toBe(true);
});

test("a film's clips come from its project on this Mac and from the archive, kept between askings", () => {
  const card = {
    name: "Pocket 4P",
    mounted: true,
    clips: [
      { name: `${A}.MP4`, size: 1000 },
      { name: `${B}.MP4`, size: 900 },
    ],
  };
  // A clip the ledger doesn't know (a phone recording dropped in) isn't one of the film's.
  const projects = [{ name: "014-walk", files: [`${A}.mp4`, "IMG_9999.MOV"] }];
  const archive = [{ name: `${B}.mp4`, size: 50, sha256: "cd", project: "013-maybe-later" }];
  let ledger = mergeLedger(null, seen("2026-11-20T10:00:00Z", { camera: card, projects, archive }));
  expect(ledger.projects).toEqual({
    "013-maybe-later": { clips: [B], local: false, archived: true },
    "014-walk": { clips: [A], local: true, archived: false },
  });
  // The archive not asked this time, and the walk film gone from the Mac without being archived.
  ledger = mergeLedger(ledger, seen("2026-11-20T10:00:30Z", { camera: card, projects: [] }));
  expect(ledger.projects).toEqual({ "013-maybe-later": { clips: [B], local: false, archived: true } });
});

test("clips only the archive or YouTube still has get records, and an archived original counts as the original", () => {
  const mac = [{ name: "IMG_4857.MOV", size: 2780, mtime: new Date(2026, 9, 30, 20, 15, 4).getTime() }];
  const archive = [
    { name: `${B}.mp4`, size: 17, sha256: "cd", project: "013-maybe-later" },
    { name: "IMG_4857.MOV", size: 2780, sha256: "ef", project: "lorax" },
  ];
  const youtube = { "DJI_20261101090000_0001_D.mp4": [{ video: "v9", size: 40, uploadedAt: "2026-11-17T10:00:00Z" }] };
  const ledger = mergeLedger(null, seen("2026-11-20T10:00:00Z", { mac, archive, youtube }));
  expect(ledger.clips[B]).toMatchObject({
    name: `${B}.mp4`,
    recorded: "2026-11-08T12:22:04",
    original: { camera: false, mac: false, cloudflare: false },
    graded: { size: 17, cloudflare: "current", youtube: null },
  });
  expect(ledger.clips.IMG_4857).toMatchObject({
    recorded: "2026-10-30T20:15:04",
    size: 2780,
    original: { mac: true, cloudflare: true },
    graded: null,
  });
  expect(ledger.clips.DJI_20261101090000_0001_D.graded).toMatchObject({
    size: 40,
    youtube: { video: "v9", current: true },
  });
});

test("a graded copy exported and cleaned off the Mac before the ledger saw it weighs what the archive's copy does", () => {
  const record = { profile: "dlog2", base: { name: "Umbra" }, exportedAt: "2026-11-12T17:03:56.093Z" };
  const archive = [{ name: `${A}.mp4`, size: 300, sha256: "ab", project: "013-maybe-later" }];
  const ledger = mergeLedger(null, seen("2026-11-21T10:00:00Z", { exports: { [`${A}.MP4`]: record }, archive }));
  expect(ledger.clips[A].graded).toMatchObject({ look: "Umbra", size: 300, mac: false, cloudflare: "current" });
});

test("only a change in what the ledger says is a change, and the archive's copy fills in clips this Mac lost", () => {
  const card = { name: "Pocket 4P", mounted: true, clips: [{ name: `${A}.MP4`, size: 1000 }] };
  const first = mergeLedger(null, seen("2026-11-20T10:00:00Z", { camera: card }));
  const again = mergeLedger(first, seen("2026-11-20T10:00:30Z", { camera: card }));
  expect(again.camera.seenAt).toBe("2026-11-20T10:00:30Z");
  expect(comparable(again)).toBe(comparable(first));
  const unplugged = mergeLedger(again, seen("2026-11-20T10:01:00Z"));
  expect(comparable(unplugged)).not.toBe(comparable(again));

  const cloud = { ...first, clips: { ...first.clips, [B]: { name: `${B}.MP4` }, [A]: { name: "older" } } };
  const union = unionLedgers(first, cloud);
  expect(Object.keys(union.clips).sort()).toEqual([B, A].sort());
  expect(union.clips[A].name).toBe(`${A}.MP4`);
  expect(unionLedgers(null, cloud)).toBe(cloud);
  expect(unionLedgers(first, null)).toBe(first);
});

test("the archive's projects are listed with each manifest read once per archiving", async () => {
  const asked = [];
  let archivedAt = "2026-11-16T01:50:00.000Z";
  const request = async (path) => {
    asked.push(path);
    if (path === "projects") return { projects: [{ name: "013-maybe-later", archivedAt, versions: 1 }] };
    return {
      files: [
        { path: `assets/${B}.mp4`, size: 17, sha256: "cd" },
        { path: `zh/assets/${B}.mp4`, size: 17, sha256: "cd" },
        { path: "assets/song.mp3", size: 5, sha256: "aa" },
        { path: "film.html", size: 9, sha256: "bb" },
      ],
    };
  };
  const cache = new Map();
  const files = await archivedFootage(request, cache);
  expect(files).toEqual([
    { name: `${B}.mp4`, size: 17, sha256: "cd", project: "013-maybe-later" },
    { name: `${B}.mp4`, size: 17, sha256: "cd", project: "013-maybe-later" },
  ]);
  await archivedFootage(request, cache);
  archivedAt = "2026-11-21T09:00:00.000Z";
  await archivedFootage(request, cache);
  expect(asked).toEqual([
    "projects",
    "projects/013-maybe-later?at=2026-11-16T01%3A50%3A00.000Z",
    "projects",
    "projects",
    "projects/013-maybe-later?at=2026-11-21T09%3A00%3A00.000Z",
  ]);
});

test("the ledger is read and written on the helper's pairing, and YouTube's uploads come from its footage.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-"));
  try {
    expect(await ledgerCloud(dir)).toBeNull();
    expect(await youtubeUploads(dir)).toEqual({});
    await writeFile(
      join(dir, "footage.json"),
      JSON.stringify({ clips: { [`${A}.mp4`]: [{ video: "v1" }] }, days: {} }),
    );
    expect(await youtubeUploads(dir)).toEqual({ [`${A}.mp4`]: [{ video: "v1" }] });
    await writeFile(join(dir, "footage.json"), "{ half written");
    expect(await youtubeUploads(dir)).toBeNull();

    await writeFile(join(dir, "config.json"), JSON.stringify({ origin: "https://post.kualta.dev", token: "t0k3n" }));
    let stored = null;
    const calls = [];
    const fetcher = async (url, init = {}) => {
      calls.push([init.method ?? "GET", url, init.headers]);
      if (init.method === "PUT") {
        stored = init.body;
        return Response.json({ ok: true });
      }
      return stored === null ? Response.json({ error: "No ledger yet" }, { status: 404 }) : new Response(stored);
    };
    const cloud = await ledgerCloud(dir, fetcher);
    expect(await cloud.read()).toBeNull();
    await cloud.write({ version: 1, clips: {} });
    expect(await cloud.read()).toEqual({ version: 1, clips: {} });
    expect(calls[1]).toEqual([
      "PUT",
      "https://post.kualta.dev/api/publisher/helper/archive/ledger",
      { Authorization: "Bearer t0k3n", "Content-Type": "application/json" },
    ]);
    const refusing = await ledgerCloud(dir, async () =>
      Response.json({ error: "Helper authentication required" }, { status: 401 }),
    );
    await expect(refusing.write({})).rejects.toThrow("Helper authentication required");
    await expect(refusing.read()).rejects.toThrow("Reading the ledger failed (401)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
