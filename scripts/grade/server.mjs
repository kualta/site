#!/usr/bin/env node
// The grade app's local server. Clips come from sources: the camera's card, by shoot day ("camera:2026-11-08", read
// only, nothing is copied off it; ⌘⌫ only moves clips to the card's Trash), and folders on this Mac
// (<root>/<folder>/originals). Whatever a source is, what the
// app makes for it lives in <root>/<day or folder>/: grades.json, the .grade/ cache (metadata, thumbnails, preview
// proxies), and graded/ with each export and a .grade.json saying exactly what was applied. So a clip graded off the
// card and the same clip in a Mac folder share one grade and one export. Listens on 127.0.0.1 only.
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { composeLut, gradeKey, parseCube, PROFILES, resolveGrade, writeCube } from "./color.mjs";
import { cameraDays, exportClip, exportFrame, makeCalibration, makeProxy, makeThumb, probe, VIDEO } from "./media.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.GRADE_ROOT || join(homedir(), "Movies/Pocket4P");
const LUTS = process.env.GRADE_LUTS || join(ROOT, "luts");
const CAMERA = process.env.GRADE_CAMERA || "/Volumes/Pocket4P/DCIM";
const CAMERA_NAME = process.env.GRADE_CAMERA_NAME || "Pocket 4P";
const PORT = Number(process.env.GRADE_PORT || 4777);
const EXPORT_LUT_SIZE = 65;

// ---- base looks: a .cube per profile that takes that profile's code values ------------------------------------

const P4P = [
  ["01", "Neutral", "Start here"], ["02", "FlatBase", "Start here"], ["03", "Natural", "Everyday"], ["12", "Punch", "Everyday"],
  ["04", "PrintFilm", "Film"], ["06", "Bleach", "Film"], ["11", "RetroFade", "Film"], ["10", "Mono", "Film"],
  ["05", "TealAmber", "Situational"], ["07", "NightNeon", "Situational"], ["08", "Golden", "Situational"], ["09", "Nordic", "Situational"],
];
const DJI = "dji/DJI OSMO Pocket 4P";
/** One generated file per log profile, from make_luts.py: `name(profile)` is its path under the LUT folder. */
const perLogProfile = (name) => Object.fromEntries(["dlog2", "dlog", "hlg"].map((p) => [p, name(p)]));
/** A make_luts.py pack: <dir>/<profile>-<slug>.cube for each [slug, name], with ids `<dir>-<slug>`. */
const pack = (group, dir, looks) =>
  looks.map(([slug, name]) => ({ id: `${dir}-${slug}`, name, group, files: perLogProfile((p) => `${dir}/${p}-${slug}.cube`) }));
const REGISTRY = [
  { id: "none", name: "As shot", group: "Camera", files: { dlog2: null, dlog: null, hlg: null, rec709: null } },
  { id: "dji", name: "Rec.709", group: "DJI", files: { dlog2: `${DJI} D-Log2 to Rec.709 V1.0 size65.cube`, dlog: `${DJI} D-Log to Rec.709 V2.0 size33.cube` } },
  { id: "dji-vivid", name: "Rec.709 vivid", group: "DJI", files: { dlog2: `${DJI} D-Log2 to Rec.709 vivid V1.0 size65.cube`, dlog: `${DJI} D-Log to Rec.709 vivid V2.0 size33.cube` } },
  { id: "aces", name: "ACES 2.0", group: "ACES", files: perLogProfile((p) => `${p}-to-rec709-aces2.cube`) },
  { id: "aces1", name: "ACES 1.0", group: "ACES", files: perLogProfile((p) => `${p}-to-rec709-aces1.cube`) },
  ...pack("ARRI", "arri", [["reveal", "ALEXA 35 REVEAL"], ["classic", "ALEXA Classic"]]),
  ...pack("AgX", "agx", [["base", "Base"], ["punchy", "Punchy"], ["high", "High contrast"], ["low", "Low contrast"]]),
  ...pack("OpenDRT", "opendrt", [["default", "Default"], ["colorful", "Colorful"], ["umbra", "Umbra"]]),
  ...pack("Fujifilm", "fujifilm", [
    ["provia", "Provia"], ["velvia", "Velvia"], ["astia", "Astia"], ["classic-chrome", "Classic Chrome"], ["reala-ace", "Reala Ace"],
    ["pro-neg-std", "Pro Neg. Std"], ["classic-neg", "Classic Neg."], ["eterna", "Eterna"], ["eterna-bb", "Eterna Bleach Bypass"], ["acros", "Acros"],
  ]),
  ...pack("Sony", "sony", [["s709", "s709"], ["cool", "Cool"], ["teal-orange", "Teal & orange"], ["vintage", "Vintage"], ["warm", "Warm"]]),
  ...P4P.map(([n, name, group]) => ({ id: `p4p-${n}`, name, group: `P4P · ${group}`, files: { dlog2: `p4p/P4P_${n}_${name}_size65.cube` } })),
];

async function exists(p) {
  return stat(p).then(() => true, () => false);
}

/** Base looks available per profile: the registry's files that are present, plus <luts>/custom/<profile>/*.cube. */
async function bases() {
  const out = Object.fromEntries(Object.keys(PROFILES).map((p) => [p, []]));
  for (const b of REGISTRY)
    for (const [profile, file] of Object.entries(b.files))
      if (file === null || (await exists(join(LUTS, file)))) out[profile].push({ id: b.id, name: b.name, group: b.group, file });
  for (const profile of Object.keys(PROFILES)) {
    const dir = join(LUTS, "custom", profile);
    const files = await readdir(dir).catch(() => []);
    for (const f of files.filter((f) => f.toLowerCase().endsWith(".cube")).sort())
      out[profile].push({ id: `custom:${f}`, name: basename(f, extname(f)), group: "Custom", file: join("custom", profile, f) });
  }
  return out;
}

const cubes = new Map();
async function loadCube(file) {
  const path = join(LUTS, file);
  const { mtimeMs } = await stat(path);
  const hit = cubes.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.lut;
  const lut = parseCube(await readFile(path, "utf8"));
  cubes.set(path, { mtimeMs, lut });
  return lut;
}

// ---- sources ------------------------------------------------------------------------------------------------------

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.part`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, path);
}

const stemOf = (name) => name.slice(0, name.length - extname(name).length);
const isVideo = (f) => VIDEO.test(f) && !f.startsWith(".");
const CAMERA_ID = /^camera:(\d{4}-\d{2}-\d{2})$/;
const FOLDER_ID = /^[A-Za-z0-9_-][\w.-]*$/;

// The card's listing, read at most every few seconds so polling stays cheap and a plugged-in camera shows up quickly.
let cardCache = null;
async function card() {
  if (cardCache && Date.now() - cardCache.at < 3000) return cardCache.days;
  const days = await cameraDays(CAMERA);
  cardCache = { at: Date.now(), days };
  return days;
}

/**
 * A source by id: where its clips are (`paths`, name → file) and where everything the app makes for it goes (`dir`).
 * A camera day that isn't on the card (unplugged) is a 404.
 */
async function source(id) {
  const cam = CAMERA_ID.exec(id);
  if (cam) {
    const list = (await card())?.get(cam[1]);
    if (!list) throw httpError(404, `${CAMERA_NAME} isn't connected, or has no clips from ${cam[1]}`);
    return { id, kind: "camera", label: cam[1], dir: join(ROOT, cam[1]), paths: new Map(list.map((c) => [c.name, c.path])) };
  }
  if (!FOLDER_ID.test(id) || id.includes("..")) throw httpError(400, "bad folder name");
  const files = await readdir(join(ROOT, id, "originals")).catch(() => {
    throw httpError(404, "no such folder");
  });
  const names = files.filter(isVideo).sort();
  return { id, kind: "folder", label: id, dir: join(ROOT, id), paths: new Map(names.map((n) => [n, join(ROOT, id, "originals", n)])) };
}

const gradesFile = (src) => join(src.dir, "grades.json");
const proxyFile = (src, name) => join(src.dir, ".grade/proxies", `${stemOf(name)}.mp4`);
const thumbFile = (src, name) => join(src.dir, ".grade/thumbs", `${stemOf(name)}.jpg`);
const gradedFile = (src, name) => join(src.dir, "graded", `${stemOf(name)}.mp4`);
const sidecarFile = (src, name) => join(src.dir, "graded", `${stemOf(name)}.grade.json`);

/** Clip stems with a graded file in a day's or folder's graded/ (with or without the app's .grade.json beside it). */
async function gradedStems(dir) {
  const files = await readdir(join(dir, "graded")).catch(() => []);
  return new Set(files.filter((f) => f.endsWith(".mp4") && !f.startsWith(".")).map(stemOf));
}

/** Everything the picker lists: the camera's days, then the folders on this Mac, each with how many are graded. */
async function library() {
  const days = await card();
  const camera = { name: CAMERA_NAME, path: CAMERA, mounted: Boolean(days), days: [] };
  for (const [day, list] of [...(days ?? new Map())].sort((a, b) => b[0].localeCompare(a[0]))) {
    const graded = await gradedStems(join(ROOT, day));
    camera.days.push({ id: `camera:${day}`, label: day, clips: list.length, graded: list.filter((c) => graded.has(stemOf(c.name))).length });
  }
  const folders = [];
  const dirs = (await readdir(ROOT, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && !d.name.startsWith("."));
  for (const d of dirs) {
    const files = await readdir(join(ROOT, d.name, "originals")).catch(() => null);
    if (!files) continue;
    const names = files.filter(isVideo);
    const graded = await gradedStems(join(ROOT, d.name));
    folders.push({ id: d.name, label: d.name, clips: names.length, graded: names.filter((n) => graded.has(stemOf(n))).length });
  }
  folders.sort((a, b) => b.id.localeCompare(a.id));
  return { root: ROOT, luts: LUTS, camera, folders };
}

/**
 * Camera metadata per clip, probed once (eight at a time) and kept in .grade/meta.json by size and modification time,
 * plus the file's size (`bytes`).
 */
async function metas(src, names) {
  const file = join(src.dir, ".grade/meta.json");
  const cache = await readJson(file, {});
  let changed = false;
  const out = {};
  const todo = [...names];
  async function worker() {
    for (let name = todo.shift(); name !== undefined; name = todo.shift()) {
      const s = await stat(src.paths.get(name));
      const hit = cache[name];
      if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs && "videoBitrate" in hit.meta) out[name] = hit.meta;
      else {
        out[name] = await probe(src.paths.get(name));
        cache[name] = { size: s.size, mtimeMs: s.mtimeMs, meta: out[name] };
        changed = true;
      }
      out[name] = { ...out[name], bytes: s.size };
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  if (changed) await writeJson(file, cache);
  return out;
}

// ---- background jobs: thumbnails (automatic), previews (on request), exports ---------------------------------------

const jobs = {
  thumb: { queue: [], busy: 0, failed: {} },
  proxy: { queue: [], current: null, failed: {} },
  export: { queue: [], current: null, done: [], failed: [], stopped: null },
};
const key = (id, name) => `${id}/${name}`;
const jobOf = (src, name, meta) => ({ k: key(src.id, name), id: src.id, name, path: src.paths.get(name), dir: src.dir, meta });

function queueThumb(src, name, meta) {
  const job = jobOf(src, name, meta);
  if (jobs.thumb.failed[job.k] || jobs.thumb.queue.some((j) => j.k === job.k)) return;
  jobs.thumb.queue.push(job);
  pumpThumbs();
}
function pumpThumbs() {
  while (jobs.thumb.busy < 4 && jobs.thumb.queue.length) {
    const job = jobs.thumb.queue.shift();
    jobs.thumb.busy++;
    makeThumb(job.path, join(job.dir, ".grade/thumbs", `${stemOf(job.name)}.jpg`), { still: job.meta.still, at: Math.min(1, job.meta.duration / 2) })
      .catch((e) => {
        jobs.thumb.failed[job.k] = String(e.message || e);
      })
      .finally(() => {
        jobs.thumb.busy--;
        pumpThumbs();
      });
  }
}

/** Ask for previews: they're made one at a time, the latest request first, so the clip you just picked comes next. */
function queueProxies(src, names, meta) {
  for (const name of [...names].reverse()) {
    const job = jobOf(src, name, meta[name]);
    if (jobs.proxy.current?.k === job.k) continue;
    delete jobs.proxy.failed[job.k];
    jobs.proxy.queue = jobs.proxy.queue.filter((j) => j.k !== job.k);
    jobs.proxy.queue.unshift(job);
  }
  pumpProxies();
}
let proxyBusy = false;
async function pumpProxies() {
  if (proxyBusy) return;
  proxyBusy = true;
  while (jobs.proxy.queue.length) {
    const job = jobs.proxy.queue.shift();
    jobs.proxy.current = job;
    const dst = join(job.dir, ".grade/proxies", `${stemOf(job.name)}.mp4`);
    try {
      if (!(await exists(dst))) await makeProxy(job.path, dst, job.meta);
    } catch (e) {
      jobs.proxy.failed[job.k] = String(e.message || e);
    }
    jobs.proxy.current = null;
  }
  proxyBusy = false;
}

let exportBusy = false;
let exportAbort = null;
async function pumpExports() {
  if (exportBusy) return;
  exportBusy = true;
  while (jobs.export.queue.length) {
    const job = jobs.export.queue.shift();
    jobs.export.current = { ...job, progress: 0 };
    exportAbort = new AbortController();
    try {
      await exportOne(
        job.id,
        job.name,
        job.quality,
        (p) => {
          jobs.export.current.progress = p;
        },
        exportAbort.signal,
      );
      jobs.export.done.unshift({ ...job, at: new Date().toISOString() });
      jobs.export.done.length = Math.min(jobs.export.done.length, 100);
    } catch (e) {
      if (!exportAbort.signal.aborted) jobs.export.failed.unshift({ ...job, error: String(e.message || e) });
    }
    exportAbort = null;
    jobs.export.current = null;
  }
  exportBusy = false;
}

/** Stop exporting: drop the queue and stop the clip in progress (its half-written file is removed). */
function stopExports() {
  const count = jobs.export.queue.length + (jobs.export.current ? 1 : 0);
  jobs.export.queue = [];
  exportAbort?.abort();
  jobs.export.stopped = { at: new Date().toISOString(), count };
  return count;
}

// ---- moving clips to the Trash (⌘⌫) -------------------------------------------------------------------------------

/** Where trashed clips go instead of the system Trash: a folder, for the tests. */
const TRASH_DIR = process.env.GRADE_TRASH;

async function moveToTrash(files) {
  if (TRASH_DIR) {
    await mkdir(TRASH_DIR, { recursive: true });
    for (const f of files) await rename(f, join(TRASH_DIR, basename(f)));
    return;
  }
  // macOS 15's trash(8): -s fails instead of skipping a file it can't move. A card's Trash is its own .Trashes.
  await new Promise((resolve, reject) => {
    execFile("/usr/bin/trash", ["-s", ...files], (err, _out, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve();
    });
  });
  const left = [];
  for (const f of files) if (await exists(f)) left.push(basename(f));
  if (left.length) throw new Error(`couldn't move ${left.join(", ")} to the Trash`);
}

/** The trash request in progress: requests run one after another. */
let trashing = Promise.resolve();

/**
 * Move clips to the Trash with the files the camera wrote beside them under the same name (DJI's low-res .LRF), and
 * drop the app's preview and thumbnail for them. Their grades and graded copies stay: the edit uses those.
 * One request at a time, and a file already gone is skipped: a second ⌘⌫ on a clip can arrive with a card listing
 * (cached for a few seconds) that still has it.
 */
function trashClips(src, names) {
  const run = trashing.then(() => trashNow(src, names));
  trashing = run.catch(() => {});
  return run;
}

async function trashNow(src, names) {
  for (const name of names) {
    if (!src.paths.has(name)) throw httpError(400, `unknown clip ${name}`);
    const exporting = (j) => j?.id === src.id && j?.name === name;
    if (exporting(jobs.export.current) || jobs.export.queue.some(exporting)) throw httpError(409, `${name} is exporting: stop exporting first`);
  }
  const trashed = [];
  for (const name of names) {
    const path = src.paths.get(name);
    const siblings = (await readdir(dirname(path))).filter((f) => f !== name && !f.startsWith(".") && stemOf(f) === stemOf(name));
    const files = siblings.map((f) => join(dirname(path), f));
    if (await exists(path)) files.unshift(path);
    if (files.length) await moveToTrash(files);
    trashed.push(...files.map((f) => basename(f)));
    const k = key(src.id, name);
    jobs.thumb.queue = jobs.thumb.queue.filter((j) => j.k !== k);
    jobs.proxy.queue = jobs.proxy.queue.filter((j) => j.k !== k);
    await rm(proxyFile(src, name), { force: true });
    await rm(thumbFile(src, name), { force: true });
  }
  cardCache = null;
  return trashed;
}

/**
 * Bake one clip's grade from its original, wherever that is, and write only the graded copy and its record. The LUT
 * is written beside its final name and moved into place only once the export has worked, so a failed or stopped
 * re-export leaves the previous export, its LUT and its record as they were.
 */
/** A clip's saved grade as it will be applied, and the one LUT that bakes it (what the preview shows). */
async function clipLut(src, name) {
  const meta = (await metas(src, [name]))[name];
  const available = (await bases())[meta.profile];
  const grade = resolveGrade((await readJson(gradesFile(src), { clips: {} })).clips?.[name], available.map((b) => b.id));
  const base = available.find((b) => b.id === grade.base);
  const lut = composeLut({ profile: meta.profile, grade, shotK: meta.cameraKelvin, base: base.file ? await loadCube(base.file) : null, size: EXPORT_LUT_SIZE });
  return { meta, grade, base, cube: writeCube(EXPORT_LUT_SIZE, lut, `${stemOf(name)} · ${base.name} · grade app`) };
}

/** Export quality, a whole percent from 10 to 100 (full, near lossless). */
const exportQuality = (q) => Math.min(100, Math.max(10, Math.round(Number(q) || 100)));

async function exportOne(id, name, quality, onProgress, signal) {
  const src = await source(id);
  if (!src.paths.has(name)) throw new Error(`${name} isn't in ${src.label} anymore`);
  const { meta, grade, base, cube: lut } = await clipLut(src, name);
  const stem = stemOf(name);
  const cube = join(src.dir, "graded/luts", `${stem}.cube`);
  const pending = join(src.dir, "graded/luts", `.${stem}.part.cube`);
  await mkdir(dirname(cube), { recursive: true });
  await writeFile(pending, lut);
  try {
    await exportClip({
      src: src.paths.get(name),
      dst: gradedFile(src, name),
      cube: pending,
      matrix: meta.matrix,
      duration: meta.duration,
      quality,
      videoBitrate: meta.videoBitrate,
      onProgress,
      signal,
    });
  } catch (e) {
    await rm(pending, { force: true });
    throw e;
  }
  await rename(pending, cube);
  await writeJson(sidecarFile(src, name), {
    source: src.kind === "camera" ? `${CAMERA_NAME}: ${relative(dirname(CAMERA), src.paths.get(name))}` : `originals/${name}`,
    graded: `graded/${stem}.mp4`,
    lut: `graded/luts/${stem}.cube`,
    profile: meta.profile,
    cameraKelvin: meta.cameraKelvin,
    base: { id: base.id, name: base.name, file: base.file },
    grade,
    key: gradeKey(grade),
    quality,
    exportedAt: new Date().toISOString(),
    tool: "scripts/grade",
  });
}

/**
 * One frame of a clip, graded with its saved grade, as graded/frames/<clip>_f<frame>.png at full size. `frame` counts
 * from 0; the seek lands a quarter frame early so ffmpeg keeps exactly that frame.
 */
async function frameOne(src, name, frame) {
  const { meta, cube } = await clipLut(src, name);
  const stem = stemOf(name);
  const lut = join(src.dir, ".grade", `${stem}.frame.cube`);
  const file = `graded/frames/${stem}_f${String(frame).padStart(4, "0")}.png`;
  await mkdir(dirname(lut), { recursive: true });
  await writeFile(lut, cube);
  try {
    const time = Math.max(0, (frame - 0.25) / (meta.fps || 24));
    await exportFrame({ src: src.paths.get(name), dst: join(src.dir, file), cube: lut, matrix: meta.matrix, time });
  } finally {
    await rm(lut, { force: true });
  }
  return file;
}

// The decoder calibration clip and what ffmpeg reads from it, made once per library (version bumps remake it).
const CALIBRATION_VERSION = 2;
const calibrationVideo = join(ROOT, ".grade/calibration.mp4");
let calibration = null;
function calibrationData() {
  calibration ??= (async () => {
    const file = join(ROOT, ".grade/calibration.json");
    const cached = await readJson(file, null);
    if (cached?.version === CALIBRATION_VERSION && (await exists(calibrationVideo))) return cached;
    const expected = await makeCalibration(calibrationVideo);
    const data = { version: CALIBRATION_VERSION, expected };
    await writeJson(file, data);
    return data;
  })().catch((e) => {
    calibration = null;
    throw e;
  });
  return calibration;
}

// ---- HTTP -----------------------------------------------------------------------------------------------------------

function send(res, status, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(data);
}
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw httpError(413, "request too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const TYPES = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".mp4": "video/mp4", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

/** A file, with single-range support so the browser can seek video. */
async function serveFile(req, res, path, cache = "no-cache") {
  const s = await stat(path).catch(() => null);
  if (!s?.isFile()) throw httpError(404, "not found");
  const type = TYPES[extname(path).toLowerCase()] || "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range) {
    let start = range[1] === "" ? s.size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== "" && range[2] !== "" ? Number(range[2]) : s.size - 1;
    start = Math.max(0, start);
    end = Math.min(s.size - 1, end);
    if (start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${s.size}` });
      return res.end();
    }
    res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${s.size}`, "Accept-Ranges": "bytes", "Cache-Control": cache });
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": s.size, "Accept-Ranges": "bytes", "Cache-Control": cache });
  if (req.method === "HEAD") return res.end();
  createReadStream(path).pipe(res);
}

/** A clip's preview: ready, being made, waiting, failed, or not asked for yet. */
function proxyState(k, ready) {
  if (ready) return "ready";
  if (jobs.proxy.failed[k]) return "failed";
  if (jobs.proxy.current?.k === k) return "working";
  if (jobs.proxy.queue.some((j) => j.k === k)) return "queued";
  return "none";
}

async function sourcePayload(id) {
  const src = await source(id);
  const names = [...src.paths.keys()];
  const meta = await metas(src, names);
  const grades = (await readJson(gradesFile(src), { clips: {} })).clips ?? {};
  const graded = await gradedStems(src.dir);
  const clips = [];
  for (const name of names) {
    const k = key(id, name);
    const thumb = await exists(thumbFile(src, name));
    if (!thumb) queueThumb(src, name, meta[name]);
    let exported = null;
    if (graded.has(stemOf(name))) {
      // A graded file without the app's record (made by hand) counts as graded; its grade just isn't known.
      const sidecar = await readJson(sidecarFile(src, name), null);
      exported = sidecar ? { key: sidecar.key, at: sidecar.exportedAt } : { key: null, at: (await stat(gradedFile(src, name))).mtime.toISOString() };
    }
    clips.push({
      name,
      stem: stemOf(name),
      ...meta[name],
      thumb,
      proxy: proxyState(k, await exists(proxyFile(src, name))),
      proxyError: jobs.proxy.failed[k] ?? null,
      exported,
    });
  }
  return { id, kind: src.kind, label: src.label, clips, grades };
}

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(url.pathname);
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  // A page on another origin cannot send this header without a preflight this server never grants.
  if (mutating && req.headers["x-grade"] !== "1") throw httpError(403, "missing X-Grade header");

  if (p === "/" || p === "/index.html") return serveFile(req, res, join(here, "ui/index.html"));
  if (p === "/color.mjs") return serveFile(req, res, join(here, "color.mjs"));
  if (/^\/ui\/\w[\w.-]*$/.test(p)) return serveFile(req, res, join(here, p));

  if (p === "/api/library" && req.method === "GET") return send(res, 200, await library());
  if (p === "/api/bases" && req.method === "GET") return send(res, 200, await bases());
  if (p === "/api/calibration" && req.method === "GET") {
    const { expected } = await calibrationData();
    return send(res, 200, { video: `/media/calibration.mp4?v=${CALIBRATION_VERSION}`, expected });
  }
  if (p === "/media/calibration.mp4") {
    await calibrationData();
    return serveFile(req, res, calibrationVideo);
  }

  let m = /^\/api\/sources\/([^/]+)$/.exec(p);
  if (m && req.method === "GET") return send(res, 200, await sourcePayload(m[1]));

  m = /^\/api\/sources\/([^/]+)\/grades$/.exec(p);
  if (m && req.method === "PUT") {
    const src = await source(m[1]);
    const incoming = (await body(req)).clips ?? {};
    const file = await readJson(gradesFile(src), { version: 1, clips: {} });
    file.version = 1;
    file.clips ??= {};
    for (const [name, grade] of Object.entries(incoming)) {
      if (!src.paths.has(name)) throw httpError(400, `unknown clip ${name}`);
      file.clips[name] = grade;
    }
    file.updatedAt = new Date().toISOString();
    await writeJson(gradesFile(src), file);
    return send(res, 200, { ok: true });
  }

  m = /^\/api\/sources\/([^/]+)\/prepare$/.exec(p);
  if (m && req.method === "POST") {
    const src = await source(m[1]);
    const names = ((await body(req)).names ?? []).filter((n) => src.paths.has(n)).slice(0, 50);
    queueProxies(src, names, await metas(src, names));
    return send(res, 200, { queued: names.length });
  }

  m = /^\/api\/sources\/([^/]+)\/trash$/.exec(p);
  if (m && req.method === "POST") {
    const src = await source(m[1]);
    const names = (await body(req)).clips ?? [];
    if (!Array.isArray(names) || !names.length) throw httpError(400, "no clips to move to the Trash");
    return send(res, 200, { trashed: await trashClips(src, names) });
  }

  m = /^\/api\/lut\/(\w+)\/([^/]+)$/.exec(p);
  if (m && req.method === "GET") {
    const base = (await bases())[m[1]]?.find((b) => b.id === m[2]);
    if (!base?.file) throw httpError(404, "no such base");
    const lut = await loadCube(base.file);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "X-Lut-Size": String(lut.size), "Cache-Control": "no-cache" });
    return res.end(Buffer.from(lut.data.buffer, lut.data.byteOffset, lut.data.byteLength));
  }

  // A clip's preview proxy, its thumbnail, or the original itself (the preview, streamed off the card).
  m = /^\/media\/([^/]+)\/(proxy|thumb|original)\/([^/]+)$/.exec(p);
  if (m) {
    const [, id, kind, file] = m;
    const src = await source(id);
    const name = [...src.paths.keys()].find((n) => stemOf(n) === stemOf(file));
    if (!name) throw httpError(404, "no such clip");
    const path = { proxy: () => proxyFile(src, name), thumb: () => thumbFile(src, name), original: () => src.paths.get(name) }[kind]();
    return serveFile(req, res, path);
  }

  if (p === "/api/export" && req.method === "POST") {
    const { source: id, names, quality: q } = await body(req);
    const src = await source(String(id));
    const quality = exportQuality(q);
    for (const name of names ?? []) {
      if (!src.paths.has(name)) throw httpError(400, `unknown clip ${name}`);
      if (jobs.export.current?.id === src.id && jobs.export.current?.name === name) continue;
      const queued = jobs.export.queue.find((j) => j.id === src.id && j.name === name);
      if (queued) queued.quality = quality;
      else jobs.export.queue.push({ id: src.id, name, quality });
    }
    jobs.export.failed = jobs.export.failed.filter((f) => !(f.id === src.id && (names ?? []).includes(f.name)));
    pumpExports();
    return send(res, 200, { queued: jobs.export.queue.length });
  }

  if (p === "/api/export/stop" && req.method === "POST") return send(res, 200, { stopped: stopExports() });

  if (p === "/api/export-frame" && req.method === "POST") {
    const { source: id, name, frame } = await body(req);
    const src = await source(String(id));
    if (!src.paths.has(name)) throw httpError(400, `unknown clip ${name}`);
    if (!Number.isInteger(frame) || frame < 0) throw httpError(400, "frame must be a whole number from 0");
    return send(res, 200, { file: await frameOne(src, name, frame) });
  }

  if (p === "/api/jobs" && req.method === "GET")
    return send(res, 200, {
      thumbs: jobs.thumb.queue.length + jobs.thumb.busy,
      proxy: { queued: jobs.proxy.queue.length, current: jobs.proxy.current && { id: jobs.proxy.current.id, name: jobs.proxy.current.name } },
      export: jobs.export,
    });

  throw httpError(404, "not found");
}

const server = createServer(async (req, res) => {
  // Only this machine's names: a page that rebinds its own domain to 127.0.0.1 still sends its own Host.
  const host = String(req.headers.host || "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return send(res, 421, { error: "wrong host" });
  try {
    await route(req, res);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: String(e.message || e) });
    if (!e.status) console.error(e);
  }
});

await mkdir(ROOT, { recursive: true });
server.listen(PORT, "127.0.0.1", () => {
  const address = `http://127.0.0.1:${PORT}`;
  console.log(`grade: ${address}  (library ${ROOT}, camera ${CAMERA}, LUTs ${LUTS})`);
  if (process.argv.includes("--open")) execFile("open", [address], () => {});
});
