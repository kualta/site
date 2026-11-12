import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { gradeKey, writeCube } from "./color.mjs";

// The grade server end to end on a throwaway library and a fake camera card: listing the card by shoot day and the
// Mac's folders, probing, thumbnails (from a clip's embedded still or a decoded frame), previews made on request,
// saving grades, exporting straight off the card with only the graded copy written, and the guards on its HTTP surface.
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const usable = spawnSync(ffmpeg, ["-version"]).status === 0;
const port = 8900 + Math.floor(Math.random() * 90);
const url = (p) => `http://127.0.0.1:${port}${p}`;
const root = mkdtempSync(join(tmpdir(), "grade-test-"));
const lib = join(root, "lib");
const trash = join(root, "trash");
const camera = join(root, "card/DCIM");
const folder = "2026-02-03";
const name = "DJI_20260203101500_0007_D.MP4";
const day = "2026-02-05";
const camId = `camera:${day}`;
const withStill = "DJI_20260205090000_0001_D.MP4";
const noStill = "DJI_20260205090100_0002_D.MP4";
const slow = "2026-02-07";
const slowClips = ["DJI_20260207100000_0001_D.MP4", "DJI_20260207100100_0002_D.MP4"];
let server;

// A flat colour by default (the inversion check needs a flat patch); `busy` is a moving pattern that takes a while to
// export (20 s, or `seconds`), for stopping one midway.
function clip(dst, gamma, { still = false, busy = false, seconds: busySeconds = 20 } = {}) {
  const plain = `${dst}.plain.mp4`;
  const seconds = busy ? busySeconds : 1;
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", busy ? `testsrc2=s=1280x720:r=24:d=${seconds}` : "color=c=0x507090:s=320x180:r=24:d=1",
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

beforeAll(async () => {
  if (!usable) return;
  mkdirSync(join(lib, folder, "originals"), { recursive: true });
  mkdirSync(join(lib, "luts"), { recursive: true });
  mkdirSync(join(camera, "DJI_001"), { recursive: true });
  clip(join(lib, folder, "originals", name), "D-Log2");
  clip(join(camera, "DJI_001", withStill), "Rec.709", { still: true });
  clip(join(camera, "DJI_001", noStill), "D-Log2");
  mkdirSync(join(lib, slow, "originals"), { recursive: true });
  for (const n of slowClips) clip(join(lib, slow, "originals", n), "D-Log2", { busy: true });
  // An inverting stand-in for the D-Log2 ACES conversion, easy to recognise in an export.
  const data = new Float32Array(2 ** 3 * 3);
  for (let b = 0, i = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) data.set([1 - r, 1 - g, 1 - b], i++ * 3);
  writeFileSync(join(lib, "luts/dlog2-to-rec709-aces2.cube"), writeCube(2, data, "invert"));
  mkdirSync(join(lib, "luts/agx"), { recursive: true });
  writeFileSync(join(lib, "luts/agx/dlog2-punchy.cube"), writeCube(2, data, "agx stand-in"));
  server = spawn(process.execPath, [join(import.meta.dir, "server.mjs")], {
    env: { ...process.env, GRADE_ROOT: lib, GRADE_CAMERA: camera, GRADE_PORT: String(port), GRADE_TRASH: trash },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => server.stdout.on("data", (c) => String(c).includes("grade:") && resolve()));
}, 120_000);

afterAll(() => {
  server?.kill();
  rmSync(root, { recursive: true, force: true });
});

test.if(usable)("lists the camera's clips by shoot day and the Mac's folders", async () => {
  const library = await json("/api/library");
  expect(library.camera).toMatchObject({ mounted: true, days: [{ id: camId, label: day, clips: 2, graded: 0 }] });
  expect(library.folders).toEqual([
    { id: slow, label: slow, clips: 2, graded: 0 },
    { id: folder, label: folder, clips: 1, graded: 0 },
  ]);
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
  const original = await fetch(url(`/media/${encodeURIComponent(camId)}/original/${noStill}`), { headers: { Range: "bytes=10-109" } });
  expect(original.status).toBe(206);
  expect(Buffer.from(await original.arrayBuffer())).toEqual(readFileSync(join(camera, "DJI_001", noStill)).subarray(10, 110));
});

test.if(usable)("makes previews only on request", async () => {
  const before = await json(`/api/sources/${folder}`);
  expect(before.clips[0]).toMatchObject({ name, profile: "dlog2", cameraKelvin: 5180, proxy: "none", exported: null });
  expect((await api(`/api/sources/${folder}/prepare`, { method: "POST", body: JSON.stringify({ names: [name, "nope.MP4"] }) })).status).toBe(200);
  await until(async () => (await json(`/api/sources/${folder}`)).clips[0].proxy === "ready");
  const proxy = await fetch(url(`/media/${folder}/proxy/${name.replace(".MP4", ".mp4")}`), { headers: { Range: "bytes=0-99" } });
  expect(proxy.status).toBe(206);
  expect((await proxy.arrayBuffer()).byteLength).toBe(100);
});

test.if(usable)("exports a Mac folder's clip with a record of what was applied", async () => {
  const grade = { base: "aces", exposure: 0, kelvin: null, tint: 0, contrast: 1, saturation: 1 };
  expect((await api(`/api/sources/${folder}/grades`, { method: "PUT", body: JSON.stringify({ clips: { [name]: grade } }) })).status).toBe(200);
  expect(JSON.parse(readFileSync(join(lib, folder, "grades.json"), "utf8")).clips[name]).toEqual(grade);
  expect((await api("/api/export", { method: "POST", body: JSON.stringify({ source: folder, names: [name] }) })).status).toBe(200);
  const s = await until(async () => {
    const body = await json(`/api/sources/${folder}`);
    return body.clips[0].exported && body;
  });
  const sidecar = JSON.parse(readFileSync(join(lib, folder, "graded/DJI_20260203101500_0007_D.grade.json"), "utf8"));
  expect(sidecar).toMatchObject({ source: `originals/${name}`, key: gradeKey(grade), quality: 100 });
  expect(s.clips[0].exported.key).toBe(sidecar.key);
  expect(existsSync(join(lib, folder, sidecar.lut))).toBe(true);
  const graded = join(lib, folder, sidecar.graded);
  expect(frames(graded)).toBe(frames(join(lib, folder, "originals", name)));
  // The stand-in base inverts: a source patch comes out as its inverse (within two H.264 round trips).
  const out = patch(graded);
  const src = patch(join(lib, folder, "originals", name));
  for (let k = 0; k < 3; k++) expect(Math.abs(out[k] - (255 - src[k]))).toBeLessThan(6);
}, 120_000);

test.if(usable)("exports straight off the card, writing only the graded copy", async () => {
  expect((await api("/api/export", { method: "POST", body: JSON.stringify({ source: camId, names: [withStill] }) })).status).toBe(200);
  await until(async () => (await json(`/api/sources/${encodeURIComponent(camId)}`)).clips[0].exported);
  const dir = join(lib, day);
  expect(readdirSync(dir).filter((f) => !f.startsWith(".")).sort()).toEqual(["graded"]);
  expect(readdirSync(join(dir, "graded")).sort()).toEqual(["DJI_20260205090000_0001_D.grade.json", "DJI_20260205090000_0001_D.mp4", "luts"]);
  const sidecar = JSON.parse(readFileSync(join(dir, "graded/DJI_20260205090000_0001_D.grade.json"), "utf8"));
  expect(sidecar.source).toBe(`Pocket 4P: DCIM/DJI_001/${withStill}`);
  expect(frames(join(dir, sidecar.graded))).toBe(frames(join(camera, "DJI_001", withStill)));
  expect(readdirSync(join(camera, "DJI_001")).sort()).toEqual([withStill, noStill].sort());
  const library = await json("/api/library");
  expect(library.camera.days[0]).toMatchObject({ id: camId, clips: 2, graded: 1 });
}, 120_000);

test.if(usable)("counts a graded file made outside the app as graded", async () => {
  mkdirSync(join(lib, day, "graded"), { recursive: true });
  writeFileSync(join(lib, day, "graded/DJI_20260205090100_0002_D.mp4"), "made by hand");
  const s = await json(`/api/sources/${encodeURIComponent(camId)}`);
  expect(s.clips[1].exported).toMatchObject({ key: null });
  expect((await json("/api/library")).camera.days[0].graded).toBe(2);
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
  const graded = join(lib, slow, "graded");
  const left = existsSync(graded) ? readdirSync(graded, { recursive: true }).map(String) : [];
  expect(left.filter((f) => /\.(mp4|json|cube)$/.test(f))).toEqual([]);
  expect((await json(`/api/sources/${slow}`)).clips.map((c) => c.exported)).toEqual([null, null]);
}, 120_000);

test.if(usable)("refuses other origins' requests, unknown clips, missing days and paths out of the library", async () => {
  expect((await fetch(url(`/api/sources/${folder}/grades`), { method: "PUT", body: "{}" })).status).toBe(403);
  expect((await fetch(url("/api/library"), { headers: { Host: "evil.example" } })).status).toBe(421);
  expect((await api(`/api/sources/${folder}/grades`, { method: "PUT", body: JSON.stringify({ clips: { "nope.MP4": {} } }) })).status).toBe(400);
  expect((await fetch(url(`/api/sources/${encodeURIComponent("camera:2020-01-01")}`))).status).toBe(404);
  expect((await fetch(url("/api/sources/..%2F..%2Fetc"))).status).toBe(404);
  expect((await fetch(url("/api/sources/.hidden"))).status).toBe(400);
  expect((await fetch(url(`/media/${folder}/proxy/..%2Fgrades.json`))).status).toBe(404);
});

test.if(usable)("moves a clip and its .LRF to the Trash, keeps its grade, and won't trash one that's exporting", async () => {
  const dir = join(lib, slow, "originals");
  const [gone, kept] = slowClips;
  const lrf = gone.replace(".MP4", ".LRF");
  writeFileSync(join(dir, lrf), "the camera's low-res proxy");
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
  expect(readdirSync(dir)).toEqual([kept]);
  const s = await json(`/api/sources/${slow}`);
  expect(s.clips.map((c) => c.name)).toEqual([kept]);
  expect(s.grades[gone]).toEqual(grade);
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
const moving = "2026-02-13";
const movingClip = "DJI_20260213100000_0001_D.MP4";
const movingFile = () => join(lib, moving, "originals", movingClip);
/** Frame `k` of a file as small RGB, read the way the export reads it (BT.709, limited range). */
const frameAt = (file, k) =>
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select=eq(n\\,${k}),scale=160:90:flags=area:in_color_matrix=bt709:in_range=tv,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"]);
const meanDiff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

test.if(usable)("exports the frame on screen as a graded PNG: that very frame, through the clip's grade", async () => {
  mkdirSync(join(lib, moving, "originals"), { recursive: true });
  clip(movingFile(), "D-Log2", { busy: true, seconds: 3 });
  const res = await api("/api/export-frame", { method: "POST", body: JSON.stringify({ source: moving, name: movingClip, frame: 12 }) });
  expect(res.status).toBe(200);
  const { file } = await res.json();
  expect(file).toBe("graded/frames/DJI_20260213100000_0001_D_f0012.png");
  const png = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", join(lib, moving, file), "-vf", "scale=160:90:flags=area,format=rgb24", "-f", "rawvideo", "-"]);
  const inverted = (k) => frameAt(movingFile(), k).map((v) => 255 - v);
  const [before, at, after] = [11, 12, 13].map((k) => meanDiff(png, inverted(k)));
  expect(at).toBeLessThan(4);
  expect(at).toBeLessThan(before);
  expect(at).toBeLessThan(after);
  expect((await api("/api/export-frame", { method: "POST", body: JSON.stringify({ source: moving, name: movingClip, frame: -1 }) })).status).toBe(400);
});

test.if(usable)("exports below full quality at the share of the original's bitrate it promises", async () => {
  expect((await api("/api/export", { method: "POST", body: JSON.stringify({ source: moving, names: [movingClip], quality: 20 }) })).status).toBe(200);
  await until(async () => (await json(`/api/sources/${moving}`)).clips[0].exported, 120_000);
  const sidecar = JSON.parse(readFileSync(join(lib, moving, "graded/DJI_20260213100000_0001_D.grade.json"), "utf8"));
  expect(sidecar.quality).toBe(20);
  // The whole file against what the menu shows: a fifth of the original's video bitrate, plus its sound as is.
  const [c] = (await json(`/api/sources/${moving}`)).clips;
  const rate = (statSync(join(lib, moving, sidecar.graded)).size * 8) / c.duration;
  expect(Math.abs(rate / (c.videoBitrate * 0.2 + c.audioBitrate) - 1)).toBeLessThan(0.3);
}, 180_000);
