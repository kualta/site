import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { gradeKey, writeCube } from "./color.mjs";

// The grade server end to end on a throwaway library: probing, proxies, saving grades, exporting with a sidecar,
// importing a shoot day off a fake camera card, and the guards on its HTTP surface.
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const usable = spawnSync(ffmpeg, ["-version"]).status === 0;
const port = 8900 + Math.floor(Math.random() * 90);
const url = (p) => `http://127.0.0.1:${port}${p}`;
const root = mkdtempSync(join(tmpdir(), "grade-test-"));
const camera = join(root, "card/DCIM");
const shoot = "2026-02-03";
const name = "DJI_20260203101500_0007_D.MP4";
let server;

function clip(dst, gamma) {
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x507090:s=320x180:r=24:d=1",
    "-f", "lavfi", "-i", "sine=d=1",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-metadata", `com.dji.camera.ColorGammaSxS=${gamma}`, "-metadata", "com.dji.camera.WhiteBalanceKelvin=5180",
    "-movflags", "use_metadata_tags", dst,
  ]);
}

const api = (p, opts = {}) =>
  fetch(url(p), { ...opts, headers: { "X-Grade": "1", "Content-Type": "application/json", ...opts.headers } });

async function until(check, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  if (!usable) return;
  mkdirSync(join(root, "lib", shoot, "originals"), { recursive: true });
  mkdirSync(join(root, "lib/luts"), { recursive: true });
  mkdirSync(join(camera, "DJI_001"), { recursive: true });
  clip(join(root, "lib", shoot, "originals", name), "D-Log2");
  clip(join(camera, "DJI_001/DJI_20260205090000_0001_D.MP4"), "D-Log");
  clip(join(camera, "DJI_001/DJI_20260205090100_0002_D.MP4"), "Rec.709");
  // An inverting stand-in for the D-Log2 ACES conversion, easy to recognise in the export.
  const data = new Float32Array(2 ** 3 * 3);
  for (let b = 0, i = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) data.set([1 - r, 1 - g, 1 - b], i++ * 3);
  writeFileSync(join(root, "lib/luts/dlog2-to-rec709-aces2.cube"), writeCube(2, data, "invert"));
  server = spawn(process.execPath, [join(import.meta.dir, "server.mjs")], {
    env: { ...process.env, GRADE_ROOT: join(root, "lib"), GRADE_CAMERA: camera, GRADE_PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => server.stdout.on("data", (c) => String(c).includes("grade:") && resolve()));
});

afterAll(() => {
  server?.kill();
  rmSync(root, { recursive: true, force: true });
});

test.if(usable)("lists the shoot and reads the camera's profile and white balance", async () => {
  const lib = await (await fetch(url("/api/library"))).json();
  expect(lib.shoots).toEqual([{ id: shoot, clips: 1 }]);
  expect(lib.camera).toMatchObject({ mounted: true, newClips: 2, shoots: [{ shoot: "2026-02-05", clips: 2 }] });
  const bases = await (await fetch(url("/api/bases"))).json();
  expect(bases.dlog2.map((b) => b.id)).toEqual(["none", "aces"]);
  expect(bases.rec709.map((b) => b.id)).toEqual(["none"]);
  const s = await until(async () => {
    const body = await (await fetch(url(`/api/shoots/${shoot}`))).json();
    return body.clips[0].proxy === "ready" && body;
  });
  expect(s.clips[0]).toMatchObject({ name, profile: "dlog2", cameraKelvin: 5180, width: 320, height: 180, exported: null });
  const proxy = await fetch(url(`/media/${shoot}/proxy/${name.replace(".MP4", ".mp4")}`), { headers: { Range: "bytes=0-99" } });
  expect(proxy.status).toBe(206);
  expect((await proxy.arrayBuffer()).byteLength).toBe(100);
});

test.if(usable)("saves a grade and exports it with a sidecar that says what was applied", async () => {
  const grade = { base: "aces", exposure: 0, kelvin: null, tint: 0, contrast: 1, saturation: 1 };
  expect((await api(`/api/shoots/${shoot}/grades`, { method: "PUT", body: JSON.stringify({ clips: { [name]: grade } }) })).status).toBe(200);
  expect(JSON.parse(readFileSync(join(root, "lib", shoot, "grades.json"), "utf8")).clips[name]).toEqual(grade);
  expect((await api("/api/export", { method: "POST", body: JSON.stringify({ shoot, names: [name] }) })).status).toBe(200);
  const s = await until(async () => {
    const body = await (await fetch(url(`/api/shoots/${shoot}`))).json();
    return body.clips[0].exported && body;
  });
  const sidecar = JSON.parse(readFileSync(join(root, "lib", shoot, "graded/DJI_20260203101500_0007_D.grade.json"), "utf8"));
  expect(sidecar.key).toBe(gradeKey(grade));
  expect(s.clips[0].exported.key).toBe(sidecar.key);
  expect(existsSync(join(root, "lib", shoot, sidecar.lut))).toBe(true);
  const count = (f) => {
    const p = spawnSync(ffmpeg, ["-hide_banner", "-i", f, "-map", "0:v:0", "-f", "null", "-"]);
    const all = [...p.stderr.toString().matchAll(/frame=\s*(\d+)/g)];
    return Number(all.at(-1)?.[1]);
  };
  expect(count(join(root, "lib", shoot, sidecar.graded))).toBe(count(join(root, "lib", shoot, "originals", name)));
  // The stand-in base inverts: a source patch comes out as its inverse (within two H.264 round trips).
  const patch = (f) =>
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", f, "-frames:v", "1", "-vf", "crop=16:16:40:40,scale=1:1:flags=area+accurate_rnd+full_chroma_int,format=rgb24", "-f", "rawvideo", "-"]);
  const out = patch(join(root, "lib", shoot, sidecar.graded));
  const src = patch(join(root, "lib", shoot, "originals", name));
  for (let k = 0; k < 3; k++) expect(Math.abs(out[k] - (255 - src[k]))).toBeLessThan(6);
}, 120_000);

test.if(usable)("imports one shoot day off the camera and checks each copy", async () => {
  expect((await api("/api/import", { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
  expect((await api("/api/import", { method: "POST", body: JSON.stringify({ shoot: "2026-02-05" }) })).status).toBe(200);
  await until(async () => !(await (await fetch(url("/api/jobs"))).json()).import.running && true);
  const jobs = await (await fetch(url("/api/jobs"))).json();
  expect(jobs.import).toMatchObject({ total: 2, done: 2, failed: [] });
  const lib = await (await fetch(url("/api/library"))).json();
  expect(lib.shoots.map((s) => s.id)).toEqual(["2026-02-05", shoot]);
  const s = await (await fetch(url("/api/shoots/2026-02-05"))).json();
  expect(s.clips.map((c) => c.profile)).toEqual(["dlog", "rec709"]);
}, 120_000);

test.if(usable)("refuses other origins' requests, unknown clips and paths out of the library", async () => {
  expect((await fetch(url(`/api/shoots/${shoot}/grades`), { method: "PUT", body: "{}" })).status).toBe(403);
  expect((await fetch(url("/api/library"), { headers: { Host: "evil.example" } })).status).toBe(421);
  expect((await api(`/api/shoots/${shoot}/grades`, { method: "PUT", body: JSON.stringify({ clips: { "nope.MP4": {} } }) })).status).toBe(400);
  expect((await fetch(url("/api/shoots/..%2F..%2Fetc"))).status).toBe(404);
  expect((await fetch(url("/api/shoots/.hidden"))).status).toBe(400);
  expect((await fetch(url(`/media/${shoot}/proxy/..%2Fgrades.json`))).status).toBe(404);
});
