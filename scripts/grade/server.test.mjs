import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { gradeKey, writeCube } from "./color.mjs";

// The grade server end to end on a throwaway Movies folder, data and cache, and a fake camera card: listing the card
// and Movies/Original by shoot day, probing, thumbnails (from a clip's embedded still or a decoded frame), previews
// made on request, saving grades, exporting into Movies/Exported with nothing else written there, and the guards on
// its HTTP surface.
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const usable = spawnSync(ffmpeg, ["-version"]).status === 0;
const GPU_TRY = ["-loglevel", "quiet", "-f", "lavfi", "-i", "color=s=320x180:d=0.2", "-c:v", "h264_videotoolbox", "-f", "null", "-"];
const gpu = usable && spawnSync(ffmpeg, GPU_TRY).status === 0;
const port = 8900 + Math.floor(Math.random() * 90);
const url = (p) => `http://127.0.0.1:${port}${p}`;
const root = mkdtempSync(join(tmpdir(), "grade-test-"));
const movies = join(root, "Movies");
const original = join(movies, "Original");
const exported = join(movies, "Exported");
const data = join(root, "data");
const trash = join(root, "trash");
const camera = join(root, "card/DCIM");
const name = "DJI_20260203101500_0007_D.MP4";
const folder = "mac:2026-02-03";
const day = "2026-02-05";
const camId = `camera:${day}`;
const withStill = "DJI_20260205090000_0001_D.MP4";
const noStill = "DJI_20260205090100_0002_D.MP4";
const slow = "mac:2026-02-07";
const slowClips = ["DJI_20260207100000_0001_D.MP4", "DJI_20260207100100_0002_D.MP4"];
let server;
// The site's archive as the ledger meets it: a film holding a clip no longer anywhere else, and the ledger it's sent.
const publisher = join(root, "publisher");
const token = "a".repeat(64);
const site = { ledger: null, sends: 0, auth: new Set(), thumbs: new Map(), blobs: new Map(), manifests: new Map(), watched: 0, listings: 0, asked: 0, settings: [], slow: 0 };
const bytesOf = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
};
const siteServer = createServer(async (req, res) => {
  site.auth.add(req.headers.authorization);
  site.asked++;
  const path = req.url.replace("/api/publisher/helper/archive/", "");
  const reply = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  // The offload keeps the composer counted as watching the footage uploads.
  if (req.url === "/api/publisher/helper/footage/watch" && req.method === "POST") {
    // As Astro does: a POST that says no type is a cross-site form submission.
    if (!req.headers["content-type"]) return reply(403, { error: "Cross-site POST form submissions are forbidden" });
    site.watched++;
    return reply(200, { watching: true });
  }
  // What's offloaded: files by hash (whole, or in parts), and a manifest per shoot day; and the settings.
  if (path === "missing" && req.method === "POST") {
    const { blobs } = JSON.parse(await bytesOf(req));
    return reply(200, { missing: blobs.filter((hash) => !site.blobs.has(hash)) });
  }
  if (path.startsWith("blobs/") && req.method === "PUT") {
    site.blobs.set(path.slice("blobs/".length), await bytesOf(req));
    return reply(201, { ok: true });
  }
  if (path.startsWith("blobs/") && site.blobs.has(path.slice("blobs/".length))) {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    return res.end(site.blobs.get(path.slice("blobs/".length)));
  }
  if (path === "uploads" && req.method === "POST") {
    const { blob } = JSON.parse(await bytesOf(req));
    site.uploads ??= new Map();
    site.uploads.set(blob, []);
    return reply(200, { upload: `up-${blob.slice(0, 8)}` });
  }
  const partOf = /^uploads\/(\w+)\/(\d+)\?/.exec(path);
  if (partOf && req.method === "PUT") {
    site.uploads.get(partOf[1])[Number(partOf[2]) - 1] = await bytesOf(req);
    return reply(200, { partNumber: Number(partOf[2]), etag: `e${partOf[2]}` });
  }
  const completing = /^uploads\/(\w+)\/complete$/.exec(path)?.[1];
  if (completing && req.method === "POST") {
    await bytesOf(req);
    site.blobs.set(completing, Buffer.concat(site.uploads.get(completing)));
    return reply(200, { ok: true });
  }
  const day = /^projects\/(_[\w-]+)(\?.*)?$/.exec(path)?.[1];
  if (day && req.method === "PUT") {
    await new Promise((resolve) => setTimeout(resolve, site.slow));
    const manifest = JSON.parse(await bytesOf(req));
    if (day === "_settings") site.settings.push({ at: Date.now(), files: manifest.files });
    site.manifests.set(day, { ...manifest, archivedAt: new Date().toISOString() });
    return reply(201, { key: `projects/${day}` });
  }
  if (day) return site.manifests.has(day) ? reply(200, site.manifests.get(day)) : reply(404, { error: "No such archived project" });
  if (path === "ledger" && req.method === "PUT") {
    let body = "";
    for await (const chunk of req) body += chunk;
    site.ledger = body;
    site.sends++;
    return reply(200, { ok: true });
  }
  if (path.startsWith("ledger/thumbs/") && req.method === "PUT") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    site.thumbs.set(decodeURIComponent(path.slice("ledger/thumbs/".length)), Buffer.concat(chunks));
    return reply(200, { ok: true });
  }
  if (path === "ledger") return site.ledger ? reply(200, site.ledger) : reply(404, { error: "No ledger yet" });
  if (path === "projects") {
    site.listings++;
    return reply(200, {
      projects: [
        { name: "001-film", archivedAt: "2026-02-10T00:00:00.000Z", versions: 1 },
        ...[...site.manifests].map(([name, manifest]) => ({ name, archivedAt: manifest.archivedAt, versions: 1 })),
      ],
    });
  }
  if (path.startsWith("projects/001-film?"))
    return reply(200, { files: [{ path: "assets/DJI_20260101120000_0099_D.mp4", size: 17, sha256: "ab" }] });
  reply(404, { error: "Not found" });
});

// A flat colour by default (the inversion check needs a flat patch); `busy` is a moving pattern that takes a while to
// export (20 s, or `seconds`), for stopping one midway; `flicker` swings the flat colour's brightness every 3 frames.
function clip(dst, gamma, { still = false, busy = false, flicker = false, seconds: busySeconds = 20 } = {}) {
  const plain = `${dst}.plain.mp4`;
  const seconds = busy ? busySeconds : 1;
  const swing = flicker ? ",eq=brightness='0.05*sin(2*PI*n/3)':eval=frame" : "";
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", busy ? `testsrc2=s=1280x720:r=24:d=${seconds}` : `color=c=0x507090:s=320x180:r=24:d=1${swing}`,
    "-f", "lavfi", "-i", `sine=d=${seconds}`,
    "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-metadata", `com.dji.camera.ColorGammaSxS=${gamma}`, "-metadata", "com.dji.camera.WhiteBalanceKelvin=5180",
    "-movflags", "use_metadata_tags", still ? plain : dst,
  ]);
  if (!still) return;
  // A JPEG carried as an attached picture, the way DJI files carry their thumbnail. ffmpeg's MP4 writer drops cover
  // art when it writes custom tags, so this clip goes untagged (it reads as Rec.709); DJI's own files carry both.
  const jpg = `${dst}.jpg`;
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=160x90", "-frames:v", "1", jpg]);
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", plain, "-i", jpg, "-map", "0", "-map", "1", "-c", "copy", "-disposition:v:1", "attached_pic", dst]);
  rmSync(plain);
  rmSync(jpg);
}

const api = (p, opts = {}) =>
  fetch(url(p), { ...opts, headers: { "X-Grade": "1", "Content-Type": "application/json", ...opts.headers } });
const json = async (p) => (await fetch(url(p))).json();
const records = () => JSON.parse(readFileSync(join(data, "exports.json"), "utf8")).clips;
/** What Movies/Exported holds, hidden files included: it must only ever be exports. */
const exportedFiles = () => readdirSync(exported).sort();

async function until(check, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

const frames = (f) => Number([...spawnSync(ffmpeg, ["-hide_banner", "-i", f, "-map", "0:v:0", "-f", "null", "-"]).stderr.toString().matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1]);
const patch = (f) =>
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", f, "-map", "0:v:0", "-frames:v", "1", "-vf", "crop=16:16:40:40,scale=1:1:flags=area+accurate_rnd+full_chroma_int,format=rgb24", "-f", "rawvideo", "-"]);

// A stand-in for uvx and the Whisper it runs: it waits for `go`, then says the name of the clip it was given.
const uvx = join(root, "uvx");
const go = join(root, "go");
const STAND_IN = `#!/bin/sh
name=$(basename "$5" .m4a)
while [ $# -gt 0 ]; do [ "$1" = --output-dir ] && out="$2"; shift; done
while [ ! -e "${go}" ]; do [ -e "${uvx}" ] || exit 1; sleep 0.05; done
echo '{"language": "en", "segments": [{"start": 0, "end": 1, "text": " '"$name"'", "words": [{"word": " x", "start": 0.2, "end": 0.9}]}]}' > "$out/transcript.json"
`;

// The server's ffmpeg: the real one, but for the GPU's encoder, which it doesn't have while `noGpu` is there.
const serverFfmpeg = join(root, "ffmpeg");
const noGpu = join(root, "no-gpu");
const WITHOUT_GPU = `#!/bin/sh
if [ -e "${noGpu}" ]; then
  case " $* " in *" h264_videotoolbox "*) echo "Unknown encoder 'h264_videotoolbox'" >&2; exit 1 ;; esac
fi
exec "${ffmpeg}" "$@"
`;

async function startServer() {
  server = spawn(process.execPath, [join(import.meta.dir, "server.mjs")], {
    env: {
      ...process.env,
      FFMPEG_PATH: serverFfmpeg,
      GRADE_ROOT: movies,
      GRADE_DATA: data,
      GRADE_CACHE: join(root, "cache"),
      GRADE_CAMERA: camera,
      GRADE_PORT: String(port),
      GRADE_TRASH: trash,
      GRADE_PUBLISHER: publisher,
      GRADE_LEDGER_EVERY: "300",
      GRADE_DEFAULT_LOOK: "agx-punchy",
      GRADE_KEEP_FREE: "1000000",
      GRADE_SETTLE: "300",
      GRADE_WATCHED_FOR: "700",
      GRADE_BACKUP_EVERY: "3000",
      GRADE_UVX: uvx,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => server.stdout.on("data", (c) => String(c).includes("grade:") && resolve()));
}

beforeAll(async () => {
  if (!usable) return;
  mkdirSync(original, { recursive: true });
  // A film being made on this Mac, using a clip from Movies/Original (its graded copy, under the same name).
  const film = join(movies, "OpenFilm/Projects/014-walk");
  mkdirSync(join(film, "assets"), { recursive: true });
  writeFileSync(join(film, "film.html"), "<!doctype html>");
  writeFileSync(join(film, "assets/DJI_20260203101500_0007_D.mp4"), "graded copy");
  writeFileSync(join(film, "assets/song.mp3"), "not footage");
  mkdirSync(join(data, "luts/agx"), { recursive: true });
  mkdirSync(join(camera, "DJI_001"), { recursive: true });
  clip(join(original, name), "D-Log2");
  clip(join(camera, "DJI_001", withStill), "Rec.709", { still: true });
  clip(join(camera, "DJI_001", noStill), "D-Log2");
  for (const n of slowClips) clip(join(original, n), "D-Log2", { busy: true });
  // An inverting stand-in for the D-Log2 ACES conversion, easy to recognise in an export.
  const cube = new Float32Array(2 ** 3 * 3);
  for (let b = 0, i = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) cube.set([1 - r, 1 - g, 1 - b], i++ * 3);
  writeFileSync(join(data, "luts/dlog2-to-rec709-aces2.cube"), writeCube(2, cube, "invert"));
  writeFileSync(join(data, "luts/agx/dlog2-punchy.cube"), writeCube(2, cube, "agx stand-in"));
  await new Promise((resolve) => siteServer.listen(0, "127.0.0.1", resolve));
  mkdirSync(publisher);
  writeFileSync(join(publisher, "config.json"), JSON.stringify({ origin: `http://127.0.0.1:${siteServer.address().port}`, token }));
  const uploads = { [withStill.replace(".MP4", ".mp4")]: [{ video: "vid1", size: 123, uploadedAt: "2026-02-06T10:00:00Z" }] };
  writeFileSync(join(publisher, "footage.json"), JSON.stringify({ clips: uploads, days: {} }));
  writeFileSync(uvx, STAND_IN, { mode: 0o755 });
  writeFileSync(serverFfmpeg, WITHOUT_GPU, { mode: 0o755 });
  await startServer();
}, 120_000);

afterAll(() => {
  server?.kill();
  siteServer.close();
  rmSync(root, { recursive: true, force: true });
});

test.if(usable)("lists the camera's clips and Movies/Original by shoot day", async () => {
  const library = await json("/api/library");
  expect(library).toMatchObject({ original, exported });
  expect(library.camera).toMatchObject({ mounted: true, days: [{ id: camId, label: day, clips: 2, graded: 0 }] });
  expect(library.folders).toEqual([
    { id: slow, label: "2026-02-07", clips: 2, graded: 0 },
    { id: folder, label: "2026-02-03", clips: 1, graded: 0 },
  ]);
  expect(exportedFiles()).toEqual([]);
  const bases = await json("/api/bases");
  expect(bases.dlog2.map((b) => b.id)).toEqual(["none", "aces", "agx-punchy"]);
  expect(bases.hlg.map((b) => b.id)).toEqual(["none"]);
  expect(bases.rec709.map((b) => b.id)).toEqual(["none"]);
});

test.if(usable)("reads a camera day straight off the card: metadata, thumbnails from stills or frames", async () => {
  const s = await until(async () => {
    const body = await json(`/api/sources/${encodeURIComponent(camId)}`);
    return body.clips.every((c) => c.thumb) && body;
  });
  expect(s.kind).toBe("camera");
  expect(s.clips.map((c) => [c.name, c.profile, c.still !== null])).toEqual([[withStill, "rec709", true], [noStill, "dlog2", false]]);
  expect(s.clips.map((c) => c.bytes)).toEqual([withStill, noStill].map((n) => statSync(join(camera, "DJI_001", n)).size));
  // The still is red; a decoded frame would be the clip's blue-grey.
  const thumb = Buffer.from(await (await fetch(url(`/media/${encodeURIComponent(camId)}/thumb/${withStill.replace(".MP4", ".jpg")}`))).arrayBuffer());
  const px = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-i", "-", "-vf", "scale=1:1:flags=area,format=rgb24", "-f", "rawvideo", "-"], { input: thumb });
  expect(px[0]).toBeGreaterThan(200);
  expect(px[2]).toBeLessThan(60);
  expect(readdirSync(join(camera, "DJI_001")).sort()).toEqual([withStill, noStill].sort());
  // Full-quality preview streams the original straight off the card, seekable.
  const clipOnCard = await fetch(url(`/media/${encodeURIComponent(camId)}/original/${noStill}`), { headers: { Range: "bytes=10-109" } });
  expect(clipOnCard.status).toBe(206);
  expect(Buffer.from(await clipOnCard.arrayBuffer())).toEqual(readFileSync(join(camera, "DJI_001", noStill)).subarray(10, 110));
});

test.if(usable)("makes previews only on request", async () => {
  const before = await json(`/api/sources/${folder}`);
  expect(before).toMatchObject({ kind: "mac", label: "2026-02-03" });
  expect(before.clips[0]).toMatchObject({ name, profile: "dlog2", cameraKelvin: 5180, proxy: "none", exported: null });
  expect((await api(`/api/sources/${folder}/prepare`, { method: "POST", body: JSON.stringify({ names: [name, "nope.MP4"] }) })).status).toBe(200);
  await until(async () => (await json(`/api/sources/${folder}`)).clips[0].proxy === "ready");
  const proxy = await fetch(url(`/media/${folder}/proxy/${name.replace(".MP4", ".mp4")}`), { headers: { Range: "bytes=0-99" } });
  expect(proxy.status).toBe(206);
  expect((await proxy.arrayBuffer()).byteLength).toBe(100);
});

test.if(usable)("exports a clip from Movies/Original into Movies/Exported, recording what was applied in exports.json", async () => {
  const grade = { base: "aces", exposure: 0, kelvin: null, tint: 0, contrast: 1, saturation: 1 };
  expect((await api(`/api/sources/${folder}/grades`, { method: "PUT", body: JSON.stringify({ clips: { [name]: grade } }) })).status).toBe(200);
  expect(JSON.parse(readFileSync(join(data, "grades.json"), "utf8")).clips[name]).toEqual(grade);
  expect((await api("/api/export", { method: "POST", body: JSON.stringify({ source: folder, names: [name] }) })).status).toBe(200);
  const s = await until(async () => {
    const body = await json(`/api/sources/${folder}`);
    // Its record is written once the file is in place.
    return body.clips[0].exported?.key && body;
  });
  const record = records()[name];
  expect(record).toMatchObject({ source: `Original/${name}`, file: "Exported/DJI_20260203101500_0007_D.mp4", key: gradeKey(grade), quality: 100 });
  expect(["gpu", "cpu"]).toContain(record.encoder);
  expect(s.clips[0].exported.key).toBe(record.key);
  expect(exportedFiles()).toEqual(["DJI_20260203101500_0007_D.mp4"]);
  const graded = join(movies, record.file);
  expect(frames(graded)).toBe(frames(join(original, name)));
  // The stand-in base inverts: a source patch comes out as its inverse (within two H.264 round trips).
  const out = patch(graded);
  const src = patch(join(original, name));
  for (let k = 0; k < 3; k++) expect(Math.abs(out[k] - (255 - src[k]))).toBeLessThan(6);
}, 120_000);

test.if(usable)("exports straight off the card, writing only the export", async () => {
  expect((await api("/api/export", { method: "POST", body: JSON.stringify({ source: camId, names: [withStill] }) })).status).toBe(200);
  await until(async () => (await json(`/api/sources/${encodeURIComponent(camId)}`)).clips[0].exported);
  expect(exportedFiles()).toEqual(["DJI_20260203101500_0007_D.mp4", "DJI_20260205090000_0001_D.mp4"]);
  const record = records()[withStill];
  expect(record.source).toBe(`Pocket 4P: DCIM/DJI_001/${withStill}`);
  expect(frames(join(movies, record.file))).toBe(frames(join(camera, "DJI_001", withStill)));
  expect(readdirSync(join(camera, "DJI_001")).sort()).toEqual([withStill, noStill].sort());
  const library = await json("/api/library");
  expect(library.camera.days[0]).toMatchObject({ id: camId, clips: 2, graded: 1 });
}, 120_000);

test.if(usable)("counts an export put in Movies/Exported by hand as graded", async () => {
  writeFileSync(join(exported, "DJI_20260205090100_0002_D.mp4"), "made by hand");
  const s = await json(`/api/sources/${encodeURIComponent(camId)}`);
  expect(s.clips[1].exported).toMatchObject({ key: null });
  expect((await json("/api/library")).camera.days[0].graded).toBe(2);
});

test.if(usable)("keeps a ledger of every clip and where its copies are, sent whole to the site's archive", async () => {
  const graded = (clip) => clip?.graded;
  const { ledger, cloud, error } = await until(async () => {
    const body = await json("/api/ledger");
    const clips = body.ledger?.clips ?? {};
    return graded(clips.DJI_20260203101500_0007_D)?.mac && graded(clips.DJI_20260205090100_0002_D)?.mac && body;
  });
  expect({ cloud, error }).toEqual({ cloud: true, error: null });
  expect(ledger.camera).toMatchObject({ name: "Pocket 4P", mounted: true });
  expect(ledger.clips.DJI_20260203101500_0007_D).toMatchObject({
    name,
    recorded: "2026-02-03T10:15:00",
    profile: "dlog2",
    size: statSync(join(original, name)).size,
    original: { camera: false, mac: true, cloudflare: false },
    graded: { look: "ACES 2.0", mac: true, cloudflare: false, youtube: null },
    gradePending: false,
  });
  // Graded off the card, and on YouTube by the footage archive's record (an earlier grade: its size isn't this one's).
  expect(ledger.clips.DJI_20260205090000_0001_D).toMatchObject({
    profile: "rec709",
    original: { camera: true, mac: false },
    graded: { mac: true, youtube: { video: "vid1", current: false } },
  });
  // Only a film in the archive still holds this one.
  expect(ledger.clips.DJI_20260101120000_0099_D).toMatchObject({
    recorded: "2026-01-01T12:00:00",
    original: { camera: false, mac: false, cloudflare: false },
    graded: { size: 17, mac: false, cloudflare: "current" },
  });
  // Not graded yet.
  expect(ledger.clips.DJI_20260207100000_0001_D).toMatchObject({ graded: null, gradePending: false });
  const sent = await until(() => {
    const body = site.ledger && JSON.parse(site.ledger);
    return body?.clips.DJI_20260205090100_0002_D?.graded?.mac && body;
  });
  expect(Object.keys(sent.clips).sort()).toEqual(Object.keys(ledger.clips).sort());
  expect([...site.auth]).toEqual([`Bearer ${token}`]);
  expect(Object.keys(JSON.parse(readFileSync(join(data, "ledger.json"), "utf8")).clips)).toContain("DJI_20260101120000_0099_D");

  // Each clip here gets a small picture, sent to the archive once for the composer's Footage tab, and its record says
  // so; the one only the archive holds has none.
  const marked = await until(() => {
    const body = site.ledger && JSON.parse(site.ledger);
    return body?.clips.DJI_20260203101500_0007_D?.thumb && body;
  });
  const jpeg = site.thumbs.get("DJI_20260203101500_0007_D");
  expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect(marked.clips.DJI_20260101120000_0099_D.thumb).toBeUndefined();

  // The films: one on this Mac, one only the archive holds.
  expect(marked.projects).toEqual({
    "001-film": { clips: ["DJI_20260101120000_0099_D"], local: false, archived: true },
    "014-walk": { clips: ["DJI_20260203101500_0007_D"], local: true, archived: false },
  });
}, 60_000);

test.if(usable)("finds a clip's day by its name, and lets only the composer frame the app", async () => {
  expect(await json(`/api/find?clip=${encodeURIComponent("DJI_20260205090000_0001_D.mp4")}`)).toEqual({
    source: camId,
    name: withStill,
  });
  expect(await json(`/api/find?clip=${name}`)).toEqual({ source: folder, name });
  expect((await fetch(url("/api/find?clip=DJI_20200101000000_0001_D.MP4"))).status).toBe(404);
  const page = await fetch(url("/"));
  expect(page.headers.get("content-security-policy")).toBe(
    "frame-ancestors 'self' https://post.kualta.dev http://localhost:4321 http://127.0.0.1:4321",
  );
});

test.if(usable)("stops exporting: drops the queue, and the clip in progress leaves nothing behind", async () => {
  expect((await api("/api/export", { method: "POST", body: JSON.stringify({ source: slow, names: slowClips }) })).status).toBe(200);
  await until(async () => (await json("/api/jobs")).export.current?.name === slowClips[0]);
  const { stopped } = await (await api("/api/export/stop", { method: "POST" })).json();
  expect(stopped).toBe(2);
  await until(async () => !(await json("/api/jobs")).export.current);
  const jobs = await json("/api/jobs");
  expect(jobs.export.queue).toEqual([]);
  expect(jobs.export.failed.filter((f) => f.id === slow)).toEqual([]);
  expect(jobs.export.stopped.count).toBe(2);
  expect(exportedFiles().filter((f) => f.includes("20260207"))).toEqual([]);
  expect(records()[slowClips[0]]).toBeUndefined();
  expect((await json(`/api/sources/${slow}`)).clips.map((c) => c.exported)).toEqual([null, null]);
}, 120_000);

const encoder = async () => (await json("/api/jobs")).export.encoder;
const encodeOn = (on) => api("/api/export/encoder", { method: "POST", body: JSON.stringify({ encoder: on }) });
/** Exports the clip off the card again: the record of it, once it's written. */
async function exportAgain(asked) {
  const { exportedAt } = records()[withStill];
  const res = await api("/api/export", { method: "POST", body: JSON.stringify({ source: camId, names: [withStill], ...asked }) });
  expect(res.status).toBe(200);
  return until(() => records()[withStill].exportedAt !== exportedAt && records()[withStill]);
}

test.if(usable)("exports are encoded on the GPU till the CPU is chosen, and neither makes an export stale", async () => {
  expect(await encoder()).toBe("gpu");
  for (const bad of ["tpu", "", null, undefined, "constructor"]) expect((await encodeOn(bad)).status).toBe(400);
  expect((await fetch(url("/api/export/encoder"), { method: "POST", body: '{"encoder":"cpu"}' })).status).toBe(403);
  expect((await api("/api/export", { method: "POST", body: JSON.stringify({ source: camId, names: [withStill], encoder: "tpu" }) })).status).toBe(400);
  expect(await encoder()).toBe("gpu");

  const before = records()[withStill];
  expect((await encodeOn("cpu")).status).toBe(200);
  expect(await encoder()).toBe("cpu");
  const onCpu = await exportAgain();
  expect(onCpu.encoder).toBe("cpu");
  expect(onCpu).not.toHaveProperty("fallback");
  // What encoded it is the record's alone: its key is the grade's, and an export from before this was recorded stays current.
  expect(onCpu.key).toBe(before.key);
  expect((await json(`/api/sources/${encodeURIComponent(camId)}`)).clips[0].exported.key).toBe(before.key);
  const { encoder: _, ...old } = before;
  const all = JSON.parse(readFileSync(join(data, "exports.json"), "utf8"));
  writeFileSync(join(data, "exports.json"), JSON.stringify({ ...all, clips: { ...all.clips, [withStill]: old } }));
  expect((await json(`/api/sources/${encodeURIComponent(camId)}`)).clips[0].exported.key).toBe(before.key);
  expect((await encodeOn("gpu")).status).toBe(200);
  expect(await encoder()).toBe("gpu");
}, 120_000);

test.if(usable)("a clip the GPU can't encode is exported on the CPU, and its record and the app say why", async () => {
  writeFileSync(noGpu, "");
  const why = "Unknown encoder 'h264_videotoolbox'";
  const record = await exportAgain();
  expect(record).toMatchObject({ encoder: "cpu", fallback: why });
  expect(frames(join(movies, record.file))).toBe(frames(join(camera, "DJI_001", withStill)));
  const { export: jobs } = await until(async () => {
    const now = await json("/api/jobs");
    return !now.export.current && now;
  });
  expect(jobs.done[0]).toMatchObject({ name: withStill, encoder: "cpu", fallback: why });
  expect(jobs.failed).toEqual([]);
  expect((await json(`/api/sources/${encodeURIComponent(camId)}`)).clips[0].exported).toMatchObject({ fallback: why });
  // Asked for the CPU, there's nothing to fall back from; the next export on the GPU is tried there again.
  expect(await exportAgain({ encoder: "cpu" })).not.toHaveProperty("fallback");
  rmSync(noGpu);
  expect((await exportAgain()).encoder).toBe(gpu ? "gpu" : "cpu");
}, 120_000);

test.if(usable)("refuses other origins' requests, unknown clips, missing days and paths out of the library", async () => {
  expect((await fetch(url(`/api/sources/${folder}/grades`), { method: "PUT", body: "{}" })).status).toBe(403);
  expect((await fetch(url("/api/library"), { headers: { Host: "evil.example" } })).status).toBe(421);
  expect((await api(`/api/sources/${folder}/grades`, { method: "PUT", body: JSON.stringify({ clips: { "nope.MP4": {} } }) })).status).toBe(400);
  expect((await fetch(url(`/api/sources/${encodeURIComponent("camera:2020-01-01")}`))).status).toBe(404);
  expect((await fetch(url("/api/sources/mac:2020-01-01"))).status).toBe(404);
  expect((await fetch(url("/api/sources/..%2F..%2Fetc"))).status).toBe(404);
  expect((await fetch(url("/api/sources/.hidden"))).status).toBe(400);
  expect((await fetch(url(`/media/${folder}/proxy/..%2Fgrades.json`))).status).toBe(404);
});

test.if(usable)("moves a clip and its .LRF to the Trash, keeps its grade, and won't trash one that's exporting", async () => {
  const [gone, kept] = slowClips;
  const lrf = gone.replace(".MP4", ".LRF");
  writeFileSync(join(original, lrf), "the camera's low-res proxy");
  const grade = { base: "aces", exposure: 1, kelvin: null, tint: 0, contrast: 1, saturation: 1 };
  expect((await api(`/api/sources/${slow}/grades`, { method: "PUT", body: JSON.stringify({ clips: { [gone]: grade } }) })).status).toBe(200);
  const trashOf = (clips) => api(`/api/sources/${slow}/trash`, { method: "POST", body: JSON.stringify({ clips }) });

  expect((await api("/api/export", { method: "POST", body: JSON.stringify({ source: slow, names: [kept] }) })).status).toBe(200);
  await until(async () => (await json("/api/jobs")).export.current?.name === kept);
  expect((await trashOf([kept])).status).toBe(409);
  await api("/api/export/stop", { method: "POST" });
  await until(async () => !(await json("/api/jobs")).export.current);

  const res = await trashOf([gone]);
  expect(res.status).toBe(200);
  expect((await res.json()).trashed.sort()).toEqual([lrf, gone].sort());
  expect(readdirSync(trash).sort()).toEqual([lrf, gone].sort());
  expect(readdirSync(original).filter((f) => f.includes("20260207"))).toEqual([kept]);
  const s = await json(`/api/sources/${slow}`);
  expect(s.clips.map((c) => c.name)).toEqual([kept]);
  expect(JSON.parse(readFileSync(join(data, "grades.json"), "utf8")).clips[gone]).toEqual(grade);
  expect((await trashOf([gone])).status).toBe(400);
  expect((await trashOf([])).status).toBe(400);
}, 120_000);

test.if(usable)("trashes a card clip the cached listing still has after its MP4 already went", async () => {
  // A second ⌘⌫ landing while the first is still moving files: the card listing (cached a few seconds) still has it.
  const dir = join(camera, "DJI_001");
  const lrf = noStill.replace(".MP4", ".LRF");
  writeFileSync(join(dir, lrf), "the camera's low-res proxy");
  await json(`/api/sources/${encodeURIComponent(camId)}`);
  rmSync(join(dir, noStill));
  const res = await api(`/api/sources/${encodeURIComponent(camId)}/trash`, { method: "POST", body: JSON.stringify({ clips: [noStill] }) });
  expect(res.status).toBe(200);
  expect((await res.json()).trashed).toEqual([lrf]);
  expect(readdirSync(dir)).toEqual([withStill]);
});

// A short moving clip of its own, for frames and sizes; its base is the inverting stand-in.
const moving = "mac:2026-02-13";
const movingClip = "DJI_20260213100000_0001_D.MP4";
const movingFile = () => join(original, movingClip);
/** Frame `k` of a file as small RGB, read the way the export reads it (BT.709, limited range). */
const frameAt = (file, k) =>
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select=eq(n\\,${k}),scale=160:90:flags=area:in_color_matrix=bt709:in_range=tv,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"]);
const meanDiff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

test.if(usable)("exports the frame on screen as a graded PNG beside the exports: that very frame, through the clip's grade", async () => {
  clip(movingFile(), "D-Log2", { busy: true, seconds: 3 });
  const res = await api("/api/export-frame", { method: "POST", body: JSON.stringify({ source: moving, name: movingClip, frame: 12 }) });
  expect(res.status).toBe(200);
  const { file } = await res.json();
  expect(file).toBe("Exported/DJI_20260213100000_0001_D_f0012.png");
  const png = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", join(movies, file), "-vf", "scale=160:90:flags=area,format=rgb24", "-f", "rawvideo", "-"]);
  const inverted = (k) => frameAt(movingFile(), k).map((v) => 255 - v);
  const [before, at, after] = [11, 12, 13].map((k) => meanDiff(png, inverted(k)));
  expect(at).toBeLessThan(4);
  expect(at).toBeLessThan(before);
  expect(at).toBeLessThan(after);
  expect((await api("/api/export-frame", { method: "POST", body: JSON.stringify({ source: moving, name: movingClip, frame: -1 }) })).status).toBe(400);
});

test.if(usable)("exports below full quality at the share of the original's bitrate it promises", async () => {
  expect((await api("/api/export", { method: "POST", body: JSON.stringify({ source: moving, names: [movingClip], quality: 20 }) })).status).toBe(200);
  // Its own export's record, not `exported`: the file lands before its record is written.
  await until(async () => records()[movingClip]?.quality === 20, 120_000);
  const record = records()[movingClip];
  expect(record.quality).toBe(20);
  // The whole file against what the menu shows: a fifth of the original's video bitrate, plus its sound as is.
  const [c] = (await json(`/api/sources/${moving}`)).clips;
  const rate = (statSync(join(movies, record.file)).size * 8) / c.duration;
  expect(Math.abs(rate / (c.videoBitrate * 0.2 + c.audioBitrate) - 1)).toBeLessThan(0.3);
  // Still nothing in Exported but exports.
  expect(exportedFiles().every((f) => /\.(mp4|png)$/.test(f) && !f.startsWith("."))).toBe(true);
}, 180_000);

const audioLeft = () => {
  const days = readdirSync(join(root, "cache/audio"));
  return days.flatMap((on) => readdirSync(join(root, "cache/audio", on))).sort();
};
const paths = (manifest) => manifest.files.map((f) => f.path).sort();

const post = (p, body = {}) => api(p, { method: "POST", body: JSON.stringify(body) });
/** The run as it ended. */
const ended = () =>
  until(async () => {
    const summary = await json("/api/offload");
    return !summary.run.running && summary;
  });
const daysFiled = () => [...site.manifests.keys()].filter((project) => project !== "_settings").sort();

test.if(usable)("keeps days and clips out of offload: counted apart, and nothing it doesn't understand is kept", async () => {
  expect(await json("/api/offload/keep")).toEqual({ days: [], clips: [] });
  const before = await json("/api/offload");
  expect(before).toMatchObject({ mac: { clips: 3 }, kept: { days: [], clips: [], count: 0 } });
  expect(before.days.map((d) => [d.day, d.clips, d.kept])).toEqual([
    ["2026-02-13", 1, false],
    ["2026-02-07", 1, false],
    ["2026-02-05", 1, false],
    ["2026-02-03", 1, false],
  ]);
  for (const bad of [{ days: "2026-02-05" }, { days: ["yesterday"] }, { clips: ["../x.MP4"] }, { clips: [7] }])
    expect((await post("/api/offload/keep", bad)).status).toBe(400);
  expect((await fetch(url("/api/offload/keep"), { method: "POST", body: "{}" })).status).toBe(403);
  const kept = await post("/api/offload/keep", { days: [day], clips: [name] });
  expect(await kept.json()).toEqual({ days: [day], clips: [name] });
  expect(await json("/api/offload")).toMatchObject({ camera: { clips: 0 }, mac: { clips: 2 }, kept: { count: 2 } });
  // What isn't given stays.
  expect(await (await post("/api/offload/keep", { days: [] })).json()).toEqual({ days: [], clips: [name] });
  expect(JSON.parse(readFileSync(join(data, "keep.json"), "utf8"))).toMatchObject({ days: [], clips: [name] });
  expect(await (await post("/api/offload/keep", { clips: [] })).json()).toEqual({ days: [], clips: [] });
});

test.if(usable)("won't start on what it doesn't understand, nor on a list of kept clips it can't read", async () => {
  for (const bad of [{ lanes: ["everything"] }, { lanes: "copy" }, { unattended: "yes" }, { youtube: 0 }, { clearCardAfter: "never" }])
    expect((await post("/api/offload", bad)).status).toBe(400);
  writeFileSync(join(data, "keep.json"), "{ half written");
  const refused = await post("/api/offload", { unattended: true });
  expect(refused.status).toBe(500);
  expect((await refused.json()).error).toMatch(/list of kept clips can't be read/);
  rmSync(join(data, "keep.json"));
  expect((await json("/api/offload")).run).toBeNull();
  expect(daysFiled()).toEqual([]);
});

test.if(usable)("offloads the card through this Mac to the archive by day, deleting each once the next has it, with the default look", async () => {
  const kept = slowClips[1];
  const grades = () => JSON.parse(readFileSync(join(data, "grades.json"), "utf8")).clips;
  expect(grades()[movingClip]).toBeUndefined();
  // A clip being exported stays on the Mac: let any export end first.
  await until(async () => {
    const { export: running } = await json("/api/jobs");
    return !running.current && !running.queue.length;
  }, 120_000);
  const before = await json("/api/offload");
  expect(before.camera).toMatchObject({ mounted: true, clips: 1 });
  expect(before.mac).toMatchObject({ clips: 3 });
  expect(before.room.keepFree).toBe(1_000_000);
  expect(before.run).toBeNull();

  // The clips land further apart than the ledger's looks.
  const listings = site.listings;
  site.slow = 700;
  expect((await post("/api/offload", { unattended: true })).status).toBe(200);
  await until(async () => (await json("/api/offload")).run.send.done === 4);
  expect(site.listings).toBe(listings);
  const after = await ended();
  site.slow = 0;
  expect(after.run).toMatchObject({ finished: "done", error: null, waiting: null });
  expect(after.run.copy).toMatchObject({ total: 1, done: 1, ended: true, error: null });
  expect(after.run.send).toMatchObject({ total: 4, done: 4, current: [] });
  expect(after.camera.clips).toBe(0);
  expect(after.mac.clips).toBe(0);
  // Off the card, .LRF and all; through the Mac, leaving nothing behind.
  expect(readdirSync(join(camera, "DJI_001"))).toEqual([]);
  expect(readdirSync(original)).toEqual([]);
  expect(daysFiled()).toEqual([
    "_originals-2026-02-03",
    "_originals-2026-02-05",
    "_originals-2026-02-07",
    "_originals-2026-02-13",
  ]);
  expect(site.manifests.get("_originals-2026-02-05").files.map((f) => f.path)).toEqual([`assets/${withStill}`]);
  for (const project of daysFiled()) for (const file of site.manifests.get(project).files) expect(site.blobs.get(file.sha256).length).toBe(file.size);
  // Each clip's sound was taken before it went; Whisper, still on the first, held nothing up.
  expect(after.transcripts).toEqual({ done: 0, total: 4, current: name, waiting: 3, failed: 0, error: null, toSend: 0 });
  expect((await json("/api/jobs")).transcripts).toMatchObject({ current: name, waiting: 3 });
  expect(audioLeft()).toHaveLength(4);
  // The composer counted as watching meanwhile, so graded clips went up to YouTube too.
  expect(site.watched).toBeGreaterThan(0);
  // The log clips without a grade got the default look; the graded one kept its own, the Rec.709 one has none.
  expect(grades()[movingClip].base).toBe("agx-punchy");
  expect(grades()[kept].base).toBe("agx-punchy");
  expect(grades()[name].base).toBe("aces");
  expect(grades()[withStill]).toBeUndefined();
  // Nothing more to take.
  expect((await post("/api/offload", { unattended: true })).status).toBe(200);
  const again = await ended();
  expect(again.run.send.total).toBe(0);
  // The ledger has them in Cloudflare, though they're on neither the card nor the Mac, and no day of them is a film.
  const ledger = await until(async () => {
    const body = await json("/api/ledger");
    return body.ledger.clips.DJI_20260205090000_0001_D?.original.cloudflare && body.ledger;
  });
  expect(ledger.clips.DJI_20260205090000_0001_D.original).toEqual({ camera: false, mac: false, cloudflare: true });
  expect(ledger.clips.DJI_20260203101500_0007_D.original).toEqual({ camera: false, mac: false, cloudflare: true });
  expect(Object.keys(ledger.projects).some((film) => film.startsWith("_"))).toBe(false);
  // The archive's projects were listed once for all four clips, at the end.
  await until(() => site.listings > listings);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(site.listings - listings).toBe(1);
}, 120_000);

test.if(usable)("transcribes the offloaded clips meanwhile, through a restart, and files each beside its clip in the next run", async () => {
  // The server is stopped with Whisper on its first clip.
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGKILL");
  await exited;
  await startServer();
  expect((await json("/api/jobs")).transcripts).toMatchObject({ done: 0, total: 4, waiting: 3, failed: 0 });
  const filed = daysFiled().map((project) => site.manifests.get(project).archivedAt);
  const before = new Map(site.manifests);
  writeFileSync(go, "");
  const made = await until(async () => {
    const { transcripts } = await json("/api/offload");
    return !transcripts.current && !transcripts.waiting && transcripts;
  });
  expect(made).toMatchObject({ done: 4, total: 4, failed: 0, error: null, toSend: 4 });
  expect(audioLeft()).toEqual([]);
  const stem = withStill.replace(".MP4", "");
  const kept = join(data, "transcripts", day);
  expect(readdirSync(kept).sort()).toEqual([`${stem}.json`, `${stem}.vtt`]);
  expect(readFileSync(join(kept, `${stem}.vtt`), "utf8")).toBe(`WEBVTT\n\n00:00:00.200 --> 00:00:00.900\n${withStill}\n`);
  // They go nowhere by themselves, however often the server looks.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(daysFiled().map((project) => site.manifests.get(project).archivedAt)).toEqual(filed);
  const unsent = (await json("/api/ledger")).ledger;
  expect(Object.values(unsent.clips).some((clip) => clip.transcript)).toBe(false);

  // The next run has only them to send.
  expect((await post("/api/offload", { unattended: true })).status).toBe(200);
  const after = await ended();
  expect(after.run).toMatchObject({ finished: "done", error: null, transcripts: { sent: 4, error: null } });
  expect(after.run.send.total).toBe(0);
  expect(after.transcripts.toSend).toBe(0);
  // Every day keeps its clip, as it was filed, and has the transcript beside it.
  expect(daysFiled()).toHaveLength(4);
  for (const on of daysFiled()) {
    const manifest = site.manifests.get(on);
    const [asset] = before.get(on).files;
    const clipStem = asset.path.slice("assets/".length, -".MP4".length);
    expect(paths(manifest)).toEqual([asset.path, `transcripts/${clipStem}.json`, `transcripts/${clipStem}.vtt`]);
    expect(manifest.files).toContainEqual(asset);
    const transcript = manifest.files.find((f) => f.path.endsWith(".json"));
    const stored = site.blobs.get(transcript.sha256);
    expect(stored.length).toBe(transcript.size);
    expect(JSON.parse(stored)).toMatchObject({ clip: `${clipStem}.MP4`, day: on.slice("_originals-".length), language: "en" });
  }
  // The ledger marks the clips, and takes no transcript for a clip, a graded copy or a film.
  const ledger = await until(async () => {
    const body = await json("/api/ledger");
    return body.ledger.clips[stem].transcript && body.ledger;
  });
  expect(Object.keys(ledger.clips)).toEqual(Object.keys(unsent.clips));
  expect(ledger.clips[stem].original).toEqual({ camera: false, mac: false, cloudflare: true });
  expect(ledger.clips[stem].graded).toEqual(unsent.clips[stem].graded);
  expect(ledger.projects).toEqual(unsent.projects);
}, 120_000);

// After the offload's counts of this Mac's originals: a clip of its own whose light flickers.
test.if(usable)("exports with deflicker on: its record and key say so, and the export and a frame of it hold steady", async () => {
  const flickerDay = "mac:2026-02-17";
  const flickering = "DJI_20260217100000_0001_D.MP4";
  clip(join(original, flickering), "D-Log2", { flicker: true });
  const grade = { base: "aces", exposure: 0, kelvin: null, tint: 0, contrast: 1, saturation: 1, deflicker: "light" };
  expect((await api(`/api/sources/${flickerDay}/grades`, { method: "PUT", body: JSON.stringify({ clips: { [flickering]: grade } }) })).status).toBe(200);
  expect((await api("/api/export", { method: "POST", body: JSON.stringify({ source: flickerDay, names: [flickering] }) })).status).toBe(200);
  // Its own export's record, written once the file is in place.
  await until(async () => records()[flickering], 120_000);
  const record = records()[flickering];
  expect(record.grade).toEqual(grade);
  expect(record.key).toBe(gradeKey(grade));
  expect(record.key).not.toBe(gradeKey({ ...grade, deflicker: undefined }));

  const exportedClip = join(movies, record.file);
  const lumas = (file) =>
    [...execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"]).toString().matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  const spread = (values) => Math.max(...values) - Math.min(...values);
  // The last few frames have less after them to be evened out with.
  const steadyPart = (values) => values.slice(0, -8);
  expect(spread(steadyPart(lumas(join(original, flickering))))).toBeGreaterThan(10);
  expect(spread(steadyPart(lumas(exportedClip)))).toBeLessThan(2);
  expect(frames(exportedClip)).toBe(frames(join(original, flickering)));

  const res = await api("/api/export-frame", { method: "POST", body: JSON.stringify({ source: flickerDay, name: flickering, frame: 4 }) });
  expect(res.status).toBe(200);
  const png = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", join(movies, (await res.json()).file), "-vf", "scale=160:90:flags=area,format=rgb24", "-f", "rawvideo", "-"]);
  // accurate_rnd: swscale's default 8-bit YUV→RGB path reads limited range about 2 levels low.
  const vf = "select=eq(n\\,4),scale=160:90:flags=area+accurate_rnd+full_chroma_int:in_color_matrix=bt709:in_range=tv,format=rgb24";
  const exportedFrame = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", exportedClip, "-vf", vf, "-frames:v", "1", "-f", "rawvideo", "-"]);
  expect(meanDiff(png, exportedFrame)).toBeLessThan(2);
}, 120_000);

// The flickering clip is the one original left, its export and the earlier ones beside it.
test.if(usable)("sends the exports alone, when that's asked for, and they count as exported and as in Cloudflare", async () => {
  const stem = "DJI_20260217100000_0001_D";
  const before = await until(async () => {
    const summary = await json("/api/offload");
    return summary.exports.clips === 4 && summary;
  });
  expect(before.run.exports).toMatchObject({ on: false, total: 0 });
  // The first one's clip is kept, and the footage uploads have begun putting up another.
  await post("/api/offload/keep", { days: ["2026-02-03"] });
  const uploads = JSON.parse(readFileSync(join(publisher, "footage.json"), "utf8"));
  const goingUp = movingClip.replace(".MP4", ".mp4");
  writeFileSync(join(publisher, "footage.json"), JSON.stringify({ ...uploads, current: { name: goingUp } }));
  const watched = site.watched;
  expect((await post("/api/offload", { lanes: ["exports"], unattended: true, youtube: false })).status).toBe(200);
  const after = await ended();
  expect(after.run).toMatchObject({ finished: "done", youtube: false, exports: { done: 3, total: 3, skipped: [] }, send: { on: false, total: 0 }, copy: { total: 0 } });
  // One put there by hand has no record of how it was made; a frame is no export.
  const left = exportedFiles();
  expect(left.filter((f) => f.endsWith(".mp4"))).toEqual(["DJI_20260203101500_0007_D.mp4", "DJI_20260205090100_0002_D.mp4", goingUp]);
  expect(left.filter((f) => f.endsWith(".png")).length).toBeGreaterThan(0);
  expect(readdirSync(original)).toEqual([`${stem}.MP4`]);
  expect(daysFiled().filter((project) => project.startsWith("_graded"))).toEqual([
    "_graded-2026-02-05",
    "_graded-2026-02-13",
    "_graded-2026-02-17",
  ]);
  expect(paths(site.manifests.get("_graded-2026-02-17"))).toEqual([`assets/${stem}.mp4`]);
  const sent = JSON.parse(readFileSync(join(data, "graded.json"), "utf8")).clips;
  expect(Object.keys(sent)).toContain(`${stem}.mp4`);
  expect(Object.keys(JSON.parse(readFileSync(join(data, "offloaded.json"), "utf8")).clips)).not.toContain(`${stem}.mp4`);
  // The YouTube uploads weren't told anyone's watching.
  expect(site.watched).toBe(watched);
  // The clip still counts as exported, with that grade.
  const [c] = (await json("/api/sources/mac:2026-02-17")).clips;
  expect(c.exported.key).toBe(records()[`${stem}.MP4`].key);
  const ledger = await until(async () => {
    const body = await json("/api/ledger");
    const { graded } = body.ledger.clips[stem] ?? {};
    return graded?.cloudflare === "current" && !graded.mac && body.ledger;
  });
  expect(ledger.clips[stem].original).toEqual({ camera: false, mac: true, cloudflare: false });
  expect(Object.keys(ledger.projects).some((film) => film.startsWith("_"))).toBe(false);

  // Put up, the other goes too: it's in the archive already.
  writeFileSync(join(publisher, "footage.json"), JSON.stringify(uploads));
  expect((await post("/api/offload", { lanes: ["exports"], unattended: true, youtube: false })).status).toBe(200);
  expect((await ended()).run.exports).toMatchObject({ total: 0, done: 0 });
  expect(exportedFiles()).not.toContain(goingUp);
  await post("/api/offload/keep", { days: [] });
}, 120_000);

test.if(usable)("what's brought back is kept: the next offload leaves it, whichever switches are on, till it's let go", async () => {
  const gradedName = withStill.replace(".MP4", ".mp4");
  const bring = async (asked) => {
    expect((await post("/api/bring", asked)).status).toBe(200);
    return until(async () => {
      const { bring: run } = await json("/api/jobs");
      return !run.running && run;
    });
  };
  // The one original left is none of this, nor the export kept before.
  await post("/api/offload/keep", { days: ["2026-02-03", "2026-02-17"] });
  expect(await bring({ what: "original", names: [withStill] })).toMatchObject({ landed: 1, failed: [] });
  expect(await bring({ what: "graded", names: [gradedName] })).toMatchObject({ landed: 1, failed: [] });
  expect(await json("/api/offload/keep")).toEqual({ days: ["2026-02-03", "2026-02-17"], clips: [withStill, gradedName] });
  const here = await json("/api/offload");
  expect(here.kept.count).toBe(3);
  expect(here.days.find((d) => d.day === day)).toMatchObject({ clips: 1, kept: false, keptClips: [withStill, gradedName] });
  const offload = async () => {
    const options = { lanes: ["copy", "send", "exports"], unattended: true, youtube: false };
    expect((await post("/api/offload", options)).status).toBe(200);
    return (await ended()).run;
  };
  expect(await offload()).toMatchObject({ send: { total: 0 }, exports: { total: 0 } });
  expect(readdirSync(original)).toContain(withStill);
  expect(exportedFiles()).toContain(gradedName);

  // Let go, they're in the archive already and only deleted.
  await post("/api/offload/keep", { clips: [] });
  expect(await offload()).toMatchObject({ send: { total: 0 }, exports: { total: 0 } });
  expect(readdirSync(original)).not.toContain(withStill);
  expect(exportedFiles()).not.toContain(gradedName);
  await post("/api/offload/keep", { days: [] });
}, 120_000);

test.if(usable)("pauses what it sends while no page is open, and goes on once one asks", async () => {
  const stem = "DJI_20260217100000_0001_D";
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect((await post("/api/offload", { lanes: ["send"], youtube: false })).status).toBe(200);
  const paused = await until(async () => {
    const { run } = await json("/api/offload");
    return run.paused && run;
  });
  expect(paused).toMatchObject({ running: true, unattended: false, paused: { for: "page", why: "No Grade page is open" } });
  const filed = daysFiled();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(daysFiled()).toEqual(filed);
  expect(readdirSync(original)).toEqual([`${stem}.MP4`]);
  expect((await json("/api/jobs")).offload.paused).not.toBeNull();
  const after = await until(async () => {
    await json("/api/jobs");
    const summary = await json("/api/offload");
    return !summary.run.running && summary;
  });
  expect(after.run).toMatchObject({ finished: "done", paused: null, send: { done: 1 } });
  expect(readdirSync(original)).toEqual([]);

  // Told to, it goes on with nobody looking.
  clip(join(original, "DJI_20260221100000_0011_D.MP4"), "D-Log2");
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect((await post("/api/offload", { lanes: ["send"] })).status).toBe(200);
  await until(async () => (await json("/api/offload")).run.paused);
  expect((await post("/api/offload", { lanes: ["send"] })).status).toBe(409);
  expect((await post("/api/offload", { lanes: [], unattended: true })).status).toBe(200);
  expect((await ended()).run).toMatchObject({ finished: "done", unattended: true, send: { done: 1 } });
}, 120_000);

test.if(usable)("takes the card's clips alone, remembers to leave them there till they're sent, and then clears them", async () => {
  const onCard = "DJI_20260219100000_0009_D.MP4";
  const dir = join(camera, "DJI_001");
  clip(join(dir, onCard), "D-Log2");
  writeFileSync(join(dir, onCard.replace(".MP4", ".LRF")), "the camera's low-res proxy");
  const filed = daysFiled();
  expect((await post("/api/offload", { lanes: ["copy"], unattended: true, clearCardAfter: "sent" })).status).toBe(200);
  const copied = await ended();
  expect(copied.run.copy).toMatchObject({ done: 1, onCamera: 1, finished: "done" });
  expect(daysFiled()).toEqual(filed);
  expect(readdirSync(dir).sort()).toEqual([onCard, onCard.replace(".MP4", ".LRF")].sort());
  expect(readdirSync(original)).toEqual([onCard]);
  expect(copied.clearCardAfter).toBe("sent");
  expect(JSON.parse(readFileSync(join(data, "offload.json"), "utf8"))).toEqual({ clearCardAfter: "sent" });

  // Through a restart: nothing starts by itself, and the choice is kept, as is what encodes exports.
  expect((await encodeOn("cpu")).status).toBe(200);
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGKILL");
  await exited;
  await startServer();
  expect(await json("/api/offload")).toMatchObject({ clearCardAfter: "sent", run: null, camera: { clips: 1 }, mac: { clips: 1 } });
  expect((await post("/api/offload", { lanes: ["send"], unattended: true, youtube: false })).status).toBe(200);
  const sent = await ended();
  expect(sent.run).toMatchObject({ finished: "done", send: { done: 1 }, copy: { on: false } });
  // Mac → Cloudflare deletes from the Mac; the card is Camera → Mac's to clear.
  expect(readdirSync(original)).toEqual([]);
  expect(readdirSync(dir)).toHaveLength(2);
  expect((await post("/api/offload", { lanes: ["copy"], unattended: true })).status).toBe(200);
  const cleared = await ended();
  expect(cleared.run.copy).toMatchObject({ total: 0, done: 0, finished: "done" });
  expect(readdirSync(dir)).toEqual([]);
  expect(readdirSync(original)).toEqual([]);
  expect(await encoder()).toBe("cpu");
}, 120_000);

test.if(usable)("stops a switch by itself, finishing what's in flight, or at once", async () => {
  expect(await (await post("/api/offload/stop")).json()).toMatchObject({ stopping: false });
  const waiting = "DJI_20260222100000_0012_D.MP4";
  clip(join(original, waiting), "D-Log2");
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect((await post("/api/offload", { lanes: ["send"], youtube: false })).status).toBe(200);
  await until(async () => (await json("/api/offload")).run.paused);
  // Nothing in flight: it ends, the clip where it was.
  expect((await post("/api/offload/stop", { lanes: ["copy"] })).status).toBe(200);
  expect((await json("/api/offload")).run.send).toMatchObject({ on: true, mode: "on" });
  expect((await post("/api/offload/stop", { lanes: ["send"] })).status).toBe(200);
  expect((await ended()).run).toMatchObject({ finished: "stopped", send: { done: 0, finished: "stopped" } });
  expect(readdirSync(original)).toEqual([waiting]);
  expect((await post("/api/offload/stop", { lanes: ["all"] })).status).toBe(400);
}, 60_000);

test.if(usable)("backs up the settings with a ledger that's sent, when they've changed and not often, and asks nothing when nothing has", async () => {
  // A grade and a ledger that change twice a second.
  const before = { sends: site.sends, settings: site.settings.length };
  for (let n = 1; n <= 12; n++) {
    writeFileSync(join(original, `IMG_90${n}.MOV`), "no video");
    const grades = JSON.parse(readFileSync(join(data, "grades.json"), "utf8"));
    grades.clips[`IMG_90${n}.MOV`] = { base: "none" };
    writeFileSync(join(data, "grades.json"), JSON.stringify(grades));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  expect(site.sends - before.sends).toBeGreaterThan(1);
  expect(site.settings.length - before.settings).toBeGreaterThan(0);
  expect(site.settings.length - before.settings).toBeLessThanOrEqual(site.sends - before.sends);
  // Over all the tests: each time something new, and no two close together.
  for (const [i, { at, files }] of site.settings.entries()) {
    if (!i) continue;
    expect(at - site.settings[i - 1].at).toBeGreaterThanOrEqual(2900);
    expect(files.map((f) => f.sha256)).not.toEqual(site.settings[i - 1].files.map((f) => f.sha256));
  }
  const { files } = site.settings.at(-1);
  expect(files.map((f) => f.path)).toEqual(["grades.json", "exports.json"]);
  expect(JSON.parse(site.blobs.get(files[1].sha256)).clips[name].key).toBe(records()[name].key);
  // Quiet: the server looks every 300 ms, and the site hears nothing of it.
  await until(async () => {
    const asked = site.asked;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return site.asked === asked;
  });
}, 60_000);

test.if(usable)("offloads what's been moved into Movies/Preexp as Original's, its .LRF with it, and not what's kept", async () => {
  const preexp = join(movies, "Preexp");
  mkdirSync(preexp, { recursive: true });
  const moved = "DJI_20260220100000_0009_D.MP4";
  clip(join(preexp, moved), "D-Log2");
  const lrf = moved.replace(".MP4", ".LRF");
  writeFileSync(join(preexp, lrf), "low-res");
  const preexpDay = "2026-02-20";
  // It's a clip of its shoot day like any other.
  const library = await until(async () => {
    const found = (await json("/api/library")).folders.find((f) => f.label === preexpDay);
    return found && found;
  });
  expect(library.clips).toBe(1);

  // Kept, it's not touched.
  await post("/api/offload/keep", { days: [preexpDay] });
  expect((await post("/api/offload", { lanes: ["send"], unattended: true, youtube: false })).status).toBe(200);
  await ended();
  expect(readdirSync(preexp).sort()).toEqual([lrf, moved].sort());

  // Not kept, it goes up like Original's and takes its .LRF with it.
  await post("/api/offload/keep", { days: [] });
  const sent = site.manifests.has(`_originals-${preexpDay}`);
  expect(sent).toBe(false);
  expect((await post("/api/offload", { lanes: ["send"], unattended: true, youtube: false })).status).toBe(200);
  const after = await ended();
  expect(after.run).toMatchObject({ finished: "done", error: null });
  expect(readdirSync(preexp)).toEqual([]);
  expect(site.manifests.get(`_originals-${preexpDay}`).files.map((f) => f.path)).toEqual([`assets/${moved}`]);
}, 120_000);

test.if(usable)("leaves a clip being copied into Preexp alone until it's been still for a while", async () => {
  const preexp = join(movies, "Preexp");
  const copying = "DJI_20260221100000_0010_D.MP4";
  clip(join(preexp, copying), "D-Log2");
  // Old by its own time, as a card's clip is: what changes it is what's looked at.
  utimesSync(join(preexp, copying), new Date("2026-01-01"), new Date("2026-01-01"));
  const summary = await json("/api/offload");
  expect(summary.mac.clips).toBeGreaterThanOrEqual(1);
  const started = Date.now();
  // It counts as still being written until 300 ms after it was last changed.
  const grow = setInterval(() => writeFileSync(join(preexp, copying), `${"x".repeat(50)}${Date.now()}`), 100);
  try {
    expect((await post("/api/offload", { lanes: ["send"], unattended: true, youtube: false })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(readdirSync(preexp)).toContain(copying);
  } finally {
    clearInterval(grow);
  }
  expect(Date.now() - started).toBeGreaterThan(1000);
  await post("/api/offload/stop", { now: true });
  await ended();
}, 120_000);

