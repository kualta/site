#!/usr/bin/env node
// The grade app's local server. Clips come from sources, each a shoot day: the camera's card ("camera:2026-11-08",
// read only, nothing is copied off it; ⌘⌫ only moves clips to the card's Trash) and ~/Movies/Original on this Mac
// ("mac:2026-11-08"). Exports go to ~/Movies/Exported, which holds nothing else. The app's own files live apart: each
// clip's grade in one grades.json and what each export was made with in one exports.json (Application Support), the
// metadata, thumbnails and previews it can remake in Caches. Clips are known by file name, so a clip graded off the
// card and the same clip copied into Original share one grade and one export. Listens on 127.0.0.1 only.
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveDays, bringer, clearParts, cloudId, dayClips, pickClips, summarise, withHere } from "./bring.mjs";
import { composeLut, DEFAULT_LOOKS, gradeKey, normalizeGrade, parseCube, PROFILES, resolveGrade, writeCube } from "./color.mjs";
import { filmAssets } from "./film.mjs";
import { dayManifests, LANES, startOffload, wakeLock } from "./offload.mjs";
import { keepList } from "./keep.mjs";
import { RETRY } from "./lane.mjs";
import { pauseFlag } from "./pause.mjs";
import { macReporter, pairedSite, REPORT_EVERY } from "./report.mjs";
import {
  archivedFootage,
  comparable,
  goingToYoutube,
  ledgerCloud,
  mergeLedger,
  unionLedgers,
  youtubeUploads,
} from "./ledger.mjs";
import { cameraDays, ENCODERS, exportClip, exportFrame, makeCalibration, makeProxy, makeThumb, probe, VIDEO } from "./media.mjs";
import { lookFiles } from "./looks.mjs";
import { saveSettings } from "./settings.mjs";
import { thumbSender } from "./thumbs.mjs";
import { transcriber } from "./transcripts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MOVIES = process.env.GRADE_ROOT || join(homedir(), "Movies");
const ORIGINAL = join(MOVIES, "Original");
/** Clips moved off the camera by hand, waiting to be offloaded like Original's: theirs go with their .LRF. */
const PREEXP = process.env.GRADE_PREEXP || join(MOVIES, "Preexp");
const EXPORTED = join(MOVIES, "Exported");
const DATA = process.env.GRADE_DATA || join(homedir(), "Library/Application Support/Grade");
const CACHE = process.env.GRADE_CACHE || join(homedir(), "Library/Caches/Grade");
const LUTS = process.env.GRADE_LUTS || join(DATA, "luts");
const GRADES = join(DATA, "grades.json");
const EXPORTS = join(DATA, "exports.json");
/** What has been chosen to encode exports on. */
const ENCODER = join(DATA, "encoder.json");
const CAMERA = process.env.GRADE_CAMERA || "/Volumes/Pocket4P/DCIM";
const CAMERA_NAME = process.env.GRADE_CAMERA_NAME || "Pocket 4P";
const PORT = Number(process.env.GRADE_PORT || 4777);
const EXPORT_LUT_SIZE = 65;
// The crossposter helper's folder in this checkout: its pairing reaches the site's archive, and its footage.json says
// what went up to YouTube.
const PUBLISHER = process.env.GRADE_PUBLISHER || join(here, "../../.publisher");
/** OpenFilm's projects: the films, whose clips the ledger says. */
const PROJECTS = process.env.GRADE_PROJECTS || join(MOVIES, "OpenFilm/Projects");
const LEDGER = join(DATA, "ledger.json");
/** How often the ledger looks again; the archive's projects are asked every 10 minutes of that. */
const LEDGER_EVERY = Number(process.env.GRADE_LEDGER_EVERY || 30_000);
const ARCHIVE_EVERY = 10 * 60_000;
/** Which settings (settings.mjs) the archive has, and when they were last sent: they go along with the ledger. */
const BACKUP = join(DATA, "backup.json");
const BACKUP_EVERY = Number(process.env.GRADE_BACKUP_EVERY || 10 * 60_000);
/** The pages that may frame the app: the composer's Grade tab, and the site run locally. Kept in step with app.mjs. */
const FRAMED_BY = ["https://post.kualta.dev", "http://localhost:4321", "http://127.0.0.1:4321"];
/** What each clip offloaded to the archive was, by file name: its SHA-256, size and shoot day. */
const OFFLOADED = join(DATA, "offloaded.json");
/** What's kept out of offload (keep.mjs), and what's been chosen for it: when the card's copies go. */
const KEEP = join(DATA, "keep.json");
const OFFLOAD = join(DATA, "offload.json");
/** Uploads go on while a page has asked how things are going within this long. */
const WATCHED_FOR = Number(process.env.GRADE_WATCHED_FOR || 60_000);
/** A file changed within this long may still be being written. */
const SETTLE = Number(process.env.GRADE_SETTLE ?? 2 * 60_000);
/** How long an offload waits before its first try again. */
const RETRY_FIRST = Number(process.env.GRADE_RETRY_FIRST || 30_000);
/** What's known of each offloaded clip's transcript (transcripts.mjs); the transcripts themselves are in transcripts/. */
const TRANSCRIPTS = join(DATA, "transcripts.json");
/** The look an offloaded log clip without a grade gets, as settings, until it's graded by hand. */
const DEFAULT_LOOK = process.env.GRADE_DEFAULT_LOOK || DEFAULT_LOOKS[0];
/** Clips come off the card only while this much stays free on the Mac, for exports and the system. */
const KEEP_FREE = Number(process.env.GRADE_KEEP_FREE || 5e9);
/** What each preview copy and trim for a film was made from (film.mjs); the files themselves are in the cache. */
const PREVIEWS = join(DATA, "previews.json");
const TRIMS = join(DATA, "trims.json");
/** How long a clip's grade stays still before its preview copy is made again by itself, when that's on. */
const REMAKE_AFTER = Number(process.env.GRADE_REMAKE_AFTER || 5000);

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

/** Changes to one of the app's { version, clips } files, made one after another so no save drops another's. */
const updating = new Map();
function updateClips(path, change) {
  const run = (updating.get(path) ?? Promise.resolve()).then(async () => {
    const data = await readJson(path, { version: 1, clips: {} });
    data.version = 1;
    data.clips ??= {};
    change(data.clips);
    await writeJson(path, data);
  });
  updating.set(path, run.catch(() => {}));
  return run;
}
const readClips = async (path) => (await readJson(path, { clips: {} })).clips ?? {};

const stemOf = (name) => name.slice(0, name.length - extname(name).length);
const isVideo = (f) => VIDEO.test(f) && !f.startsWith(".");
const CAMERA_ID = /^camera:(\d{4}-\d{2}-\d{2})$/;
const MAC_ID = /^mac:(\d{4}-\d{2}-\d{2})$/;
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** The recording date in a DJI name, or null. */
const djiDay = (name) => /^DJI_(\d{4})(\d{2})(\d{2})\d{6}_/.exec(name)?.slice(1, 4).join("-") ?? null;

/**
 * The clips in Movies/Original and Movies/Preexp by shoot day: the recording date in a DJI name, or else the file's own
 * date. A name in both is Original's.
 */
async function originalDays() {
  const days = new Map();
  const seen = new Set();
  for (const dir of [ORIGINAL, PREEXP])
    for (const name of (await readdir(dir).catch(() => [])).filter(isVideo).sort()) {
      if (seen.has(name)) continue;
      seen.add(name);
      const path = join(dir, name);
      const day = djiDay(name) ?? (await stat(path).then((s) => localDay(s.mtime), () => null));
      if (!day) continue;
      if (!days.has(day)) days.set(day, []);
      days.get(day).push({ name, path });
    }
  return days;
}

// The card's listing, read at most every few seconds so polling stays cheap and a plugged-in camera shows up quickly.
let cardCache = null;
async function card() {
  if (cardCache && Date.now() - cardCache.at < 3000) return cardCache.days;
  const days = await cameraDays(CAMERA);
  cardCache = { at: Date.now(), days };
  return days;
}

/**
 * A source by id: a shoot day on the card or in Movies/Original, and where its clips are (`paths`, name → file).
 * A camera day that isn't on the card (unplugged) is a 404.
 */
async function source(id) {
  const cam = CAMERA_ID.exec(id);
  if (cam) {
    const list = (await card())?.get(cam[1]);
    if (!list) throw httpError(404, `${CAMERA_NAME} isn't connected, or has no clips from ${cam[1]}`);
    return { id, kind: "camera", label: cam[1], paths: new Map(list.map((c) => [c.name, c.path])) };
  }
  const mac = MAC_ID.exec(id);
  if (!mac) throw httpError(400, "bad source");
  const list = (await originalDays()).get(mac[1]);
  if (!list) throw httpError(404, `no clips from ${mac[1]} in ${ORIGINAL}`);
  return { id, kind: "mac", label: mac[1], paths: new Map(list.map((c) => [c.name, c.path])) };
}

const proxyFile = (name) => join(CACHE, "proxies", `${stemOf(name)}.mp4`);
const thumbFile = (name) => join(CACHE, "thumbs", `${stemOf(name)}.jpg`);
const exportedFile = (name) => join(EXPORTED, `${stemOf(name)}.mp4`);

/** Clip names (without extension) that have an export in Movies/Exported, made here or put there by hand. */
async function exportedStems() {
  const files = await readdir(EXPORTED).catch(() => []);
  return new Set(files.filter((f) => f.endsWith(".mp4") && !f.startsWith(".")).map(stemOf));
}

/** Everything the picker lists: the camera's days, then the days in Movies/Original, each with how many are graded. */
async function library() {
  const exported = await exportedStems();
  const listed = (prefix, days) =>
    [...days]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([day, list]) => ({ id: `${prefix}:${day}`, label: day, clips: list.length, graded: list.filter((c) => exported.has(stemOf(c.name))).length }));
  const days = await card();
  const camera = { name: CAMERA_NAME, path: CAMERA, mounted: Boolean(days), days: listed("camera", days ?? new Map()) };
  return { original: ORIGINAL, exported: EXPORTED, luts: LUTS, camera, folders: listed("mac", await originalDays()) };
}

/**
 * Camera metadata per clip, probed once (eight at a time) and kept in the cache's meta.json by path, size and
 * modification time, plus the file's size (`bytes`).
 */
async function metas(src, names) {
  const file = join(CACHE, "meta.json");
  const cache = await readClips(file);
  const fresh = {};
  const out = {};
  const todo = [...names];
  async function worker() {
    for (let name = todo.shift(); name !== undefined; name = todo.shift()) {
      const path = src.paths.get(name);
      const s = await stat(path);
      const hit = cache[path];
      if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs && "videoBitrate" in hit.meta) out[name] = hit.meta;
      else {
        out[name] = await probe(path);
        fresh[path] = { size: s.size, mtimeMs: s.mtimeMs, meta: out[name] };
      }
      out[name] = { ...out[name], bytes: s.size };
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  if (Object.keys(fresh).length) await updateClips(file, (clips) => Object.assign(clips, fresh));
  return out;
}

// ---- background jobs: thumbnails (automatic), previews (on request), exports ---------------------------------------

const jobs = {
  thumb: { queue: [], busy: 0, failed: {} },
  proxy: { queue: [], current: null, failed: {} },
  export: { queue: [], current: null, done: [], failed: [], stopped: null },
};
const key = (id, name) => `${id}/${name}`;
const jobOf = (src, name, meta) => ({ k: key(src.id, name), id: src.id, name, path: src.paths.get(name), meta });

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
    makeThumb(job.path, thumbFile(job.name), { still: job.meta.still, at: Math.min(1, job.meta.duration / 2) })
      .then(() => madeFrom(job.name, Boolean(job.meta.copy)))
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
    const dst = proxyFile(job.name);
    try {
      if (!(await exists(dst))) await makeProxy(job.path, dst, job.meta);
    } catch (e) {
      jobs.proxy.failed[job.k] = String(e.message || e);
    }
    jobs.proxy.current = null;
  }
  proxyBusy = false;
}

/** What encodes exports, as last chosen in the Export menu. */
let exportEncoder = "gpu";
let exportBusy = false;
let exportAbort = null;
async function pumpExports() {
  if (exportBusy) return;
  exportBusy = true;
  // Paused from the Footage tab, the export being made is finished and the rest wait, to go once it's resumed.
  while (jobs.export.queue.length && !pause.held()) {
    const job = jobs.export.queue.shift();
    // Its own record: ffmpeg can still report progress after the export has ended, when there's no current one.
    const current = { ...job, progress: 0 };
    jobs.export.current = current;
    exportAbort = new AbortController();
    try {
      const made = await exportOne(job, {
        onProgress: (p) => {
          current.progress = p;
        },
        onFallback: (why) => {
          console.error(`grade: ${job.name}: encoding on the CPU, the GPU couldn't: ${why}`);
          Object.assign(current, { encoder: "cpu", fallback: why, progress: 0 });
        },
        signal: exportAbort.signal,
      });
      jobs.export.done.unshift({ ...job, ...made, at: new Date().toISOString() });
      jobs.export.done.length = Math.min(jobs.export.done.length, 100);
    } catch (e) {
      if (!exportAbort.signal.aborted) jobs.export.failed.unshift({ ...job, error: String(e.message || e) });
    }
    exportAbort = null;
    jobs.export.current = null;
  }
  exportBusy = false;
  scheduleLedger(2000);
  // A film's preview copies and trims waited for the exports.
  film.pump();
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
    await rm(proxyFile(name), { force: true });
    await rm(thumbFile(name), { force: true });
  }
  cardCache = null;
  scheduleLedger(2000);
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
  const grade = resolveGrade((await readClips(GRADES))[name], available.map((b) => b.id));
  const base = available.find((b) => b.id === grade.base);
  const lut = composeLut({ profile: meta.profile, grade, shotK: meta.cameraKelvin, base: base.file ? await loadCube(base.file) : null, size: EXPORT_LUT_SIZE });
  return { meta, grade, base, cube: writeCube(EXPORT_LUT_SIZE, lut, `${stemOf(name)} · ${base.name} · grade app`) };
}

/** Export quality, a whole percent from 10 to 100 (full, near lossless). */
const exportQuality = (q) => Math.min(100, Math.max(10, Math.round(Number(q) || 100)));
/** What to encode exports on, as asked for. */
function encoderAsked(encoder) {
  if (!ENCODERS.includes(encoder)) throw httpError(400, `encoder must be ${ENCODERS.join(" or ")}`);
  return encoder;
}

/** Run `use` with a clip's LUT written to a file of its own in the cache, gone again afterwards. */
async function withLutFile(name, cube, use) {
  const file = join(CACHE, "luts", `${stemOf(name)}.${process.hrtime.bigint()}.cube`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, cube);
  try {
    return await use(file);
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * Bake one clip's grade from its original, wherever that is, into Movies/Exported/<clip>.mp4, and record what it was
 * made with in exports.json. The file is written under a temporary name and moved into place only once the export
 * has worked, so a failed or stopped re-export leaves the previous export and its record as they were.
 */
async function exportOne({ id, name, quality, encoder }, { onProgress, onFallback, signal }) {
  const src = await source(id);
  if (!src.paths.has(name)) throw new Error(`${name} isn't in ${src.label} anymore`);
  const { meta, grade, base, cube } = await clipLut(src, name);
  const path = src.paths.get(name);
  const made = await withLutFile(name, cube, (lut) =>
    exportClip({
      src: path,
      dst: exportedFile(name),
      cube: lut,
      matrix: meta.matrix,
      deflicker: grade.deflicker,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      quality,
      videoBitrate: meta.videoBitrate,
      encoder,
      onProgress,
      onFallback,
      signal,
    }),
  );
  await updateClips(EXPORTS, (clips) => {
    clips[name] = {
      source: src.kind === "camera" ? `${CAMERA_NAME}: ${relative(dirname(CAMERA), path)}` : relative(MOVIES, path),
      file: relative(MOVIES, exportedFile(name)),
      profile: meta.profile,
      cameraKelvin: meta.cameraKelvin,
      base: { id: base.id, name: base.name, file: base.file },
      grade,
      key: gradeKey(grade),
      quality,
      ...made,
      exportedAt: new Date().toISOString(),
      tool: "scripts/grade",
    };
  });
  return made;
}

/**
 * One frame of a clip, graded with its saved grade, as Movies/Exported/<clip>_f<frame>.png at full size. `frame`
 * counts from 0; the seek lands a quarter frame early so ffmpeg keeps exactly that frame.
 */
async function frameOne(src, name, frame) {
  const { meta, grade, cube } = await clipLut(src, name);
  const dst = join(EXPORTED, `${stemOf(name)}_f${String(frame).padStart(4, "0")}.png`);
  const time = Math.max(0, (frame - 0.25) / (meta.fps || 24));
  await withLutFile(name, cube, (lut) =>
    exportFrame({ src: src.paths.get(name), dst, cube: lut, matrix: meta.matrix, deflicker: grade.deflicker, time }),
  );
  return relative(MOVIES, dst);
}

// The decoder calibration clip and what ffmpeg reads from it, made once per library (version bumps remake it).
const CALIBRATION_VERSION = 2;
const calibrationVideo = join(CACHE, "calibration.mp4");
let calibration = null;
function calibrationData() {
  calibration ??= (async () => {
    const file = join(CACHE, "calibration.json");
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

// ---- the footage ledger (ledger.mjs) ----------------------------------------------------------------------------------

const ledger = {
  /** The ledger as last merged; null until the first look. */
  current: null,
  /** Whether the archive's copy has been read back, so sending this Mac's can't drop clips only it knows. */
  restored: false,
  /** What the archive holds, as comparable(): the ledger is sent when it differs. */
  sent: null,
  savedAt: null,
  error: null,
  archiveError: null,
  cloud: false,
  archiveAt: 0,
  manifests: new Map(),
  /** Clips whose metadata couldn't be read: not tried again every look. */
  unreadable: new Set(),
  running: false,
  timer: null,
};

/** The clips with a thumbnail in the cache, by name without extension, lowercase. */
/** The OpenFilm projects on this Mac (folders holding a film.html), each with the video files in its assets. */
async function localProjects() {
  const found = [];
  for (const entry of await readdir(PROJECTS, { withFileTypes: true }).catch(() => [])) {
    const dir = join(PROJECTS, entry.name);
    if (!entry.isDirectory() || !(await exists(join(dir, "film.html")))) continue;
    const files = [];
    for (const assets of ["assets", "zh/assets"]) files.push(...(await readdir(join(dir, assets)).catch(() => [])).filter(isVideo));
    found.push({ name: entry.name, files });
  }
  return found;
}

async function thumbStems() {
  return new Set((await thumbFiles()).keys());
}
/** The cache's thumbnails: clip, lowercase, → file name. */
async function thumbFiles() {
  const files = await readdir(join(CACHE, "thumbs")).catch(() => []);
  return new Map(files.filter((f) => f.endsWith(".jpg")).map((f) => [stemOf(f).toLowerCase(), f]));
}

/** The clips (lowercase) whose picture in the cache was made from the graded copy, not the log original. */
const COPIES = join(CACHE, "thumb-copies.json");
/** Notes what a clip's picture was just made from: the ledger sends one made from the graded copy as it is. */
async function madeFrom(name, copy) {
  const clip = stemOf(name).toLowerCase();
  if (copy === Boolean((await readClips(COPIES))[clip])) return;
  await updateClips(COPIES, (clips) => {
    if (copy) clips[clip] = true;
    else delete clips[clip];
  });
}

const thumbs = thumbSender({ lutSize: EXPORT_LUT_SIZE });
/**
 * Sends the archive a few clips' pictures as they now are, graded as each would export (thumbs.mjs), for the composer's
 * Footage and Archive tabs; says whether more are waiting.
 */
async function sendThumbs(cloud) {
  const files = await thumbFiles();
  const { more, error } = await thumbs.send({
    clips: ledger.current.clips,
    files: new Map([...files].map(([clip, file]) => [clip, join(CACHE, "thumbs", file)])),
    copies: new Set(Object.keys(await readClips(COPIES))),
    probed: await readClips(join(CACHE, "meta.json")),
    grades: await readClips(GRADES),
    bases: await bases(),
    loadCube,
    put: cloud.putThumb,
  });
  if (error) ledger.error = `Couldn't send a picture to Cloudflare: ${error}`;
  return more;
}

/** A file's size and modification time, or null once it's gone. */
const sizeOf = async (path) => {
  const s = await stat(path).catch(() => null);
  return s ? { size: s.size, mtime: s.mtimeMs } : null;
};

/**
 * What the ledger is made from, as mergeLedger takes it. Clips whose profile isn't known yet are probed a few at a time
 * (none while an export reads the card); `more` says some are left.
 */
async function observe(cloud) {
  const at = new Date().toISOString();
  const days = await card();
  const listed = async (list) =>
    (await Promise.all(list.map(async (c) => ({ name: c.name, path: c.path, ...(await sizeOf(c.path)) })))).filter((c) => c.size !== undefined);
  const cameraClips = await listed([...(days?.values() ?? [])].flat());
  const macClips = await listed([...(await originalDays()).values()].flat());

  const known = await readClips(join(CACHE, "meta.json"));
  const metasByClip = new Map();
  const unknown = [];
  for (const c of [...cameraClips, ...macClips]) {
    const meta = known[c.path]?.meta;
    if (meta) metasByClip.set(stemOf(c.name).toLowerCase(), { profile: meta.profile, duration: meta.duration });
    else if (!ledger.unreadable.has(c.path)) unknown.push(c);
  }
  const batch = jobs.export.current ? [] : unknown.slice(0, 8);
  for (const c of batch) {
    try {
      const meta = (await metas({ id: "ledger", paths: new Map([[c.name, c.path]]) }, [c.name]))[c.name];
      metasByClip.set(stemOf(c.name).toLowerCase(), { profile: meta.profile, duration: meta.duration });
    } catch {
      ledger.unreadable.add(c.path);
    }
  }

  const exportedFiles = (await readdir(EXPORTED).catch(() => [])).filter((f) => f.endsWith(".mp4") && !f.startsWith("."));
  const exported = await listed(exportedFiles.map((name) => ({ name, path: join(EXPORTED, name) })));

  // The ledger's small pictures, made like the clip list's: from the original (its still, or a frame), or from the
  // graded copy once the original is gone. A dozen each look, none while an export reads the card.
  const pictured = await thumbStems();
  const unpictured = [];
  for (const c of [...cameraClips, ...macClips, ...exported]) {
    const lower = stemOf(c.name).toLowerCase();
    if (pictured.has(lower)) continue;
    const meta = known[c.path]?.meta ?? (c.path.startsWith(EXPORTED) ? { still: null, duration: 1, copy: true } : null);
    if (!meta) continue;
    // One picture a clip: from the first copy that can make it.
    pictured.add(lower);
    unpictured.push({ ...c, meta });
  }
  const pictures = jobs.export.current ? [] : unpictured.slice(0, 12);
  for (const c of pictures) queueThumb({ id: "ledger", paths: new Map([[c.name, c.path]]) }, c.name, c.meta);

  let archive = null;
  const landed = await offloadedSince(ledger.archiveAt);
  if (cloud && Date.now() - ledger.archiveAt > ARCHIVE_EVERY) {
    const asked = Date.now();
    try {
      archive = await archivedFootage(cloud.request, ledger.manifests);
      ledger.archiveAt = asked;
      ledger.archiveError = null;
    } catch (e) {
      // Asked again in two minutes rather than ten.
      ledger.archiveAt = Date.now() - ARCHIVE_EVERY + 2 * 60_000;
      ledger.archiveError = `Couldn't read the Cloudflare archive: ${e.message}`;
    }
  }
  const seen = {
    at,
    camera: { name: CAMERA_NAME, mounted: Boolean(days), clips: cameraClips },
    mac: macClips,
    metas: metasByClip,
    exports: await readClips(EXPORTS),
    exported,
    grades: Object.keys(await readClips(GRADES)),
    youtube: await youtubeUploads(PUBLISHER),
    archive,
    landed: archive ? [] : landed,
    projects: await localProjects(),
    transcripts: await transcripts.filed(),
  };
  const moreToProbe = unknown.length > batch.length && batch.length > 0;
  const moreToPicture = unpictured.length > pictures.length && pictures.length > 0;
  return { seen, more: moreToProbe || moreToPicture };
}

/**
 * What's been offloaded to the archive since a time, so a clip gone from here shows as there before the archive is asked
 * again.
 */
async function offloadedSince(ms) {
  const all = Object.entries(await readClips(OFFLOADED));
  return all.filter(([, { at }]) => Date.parse(at) > ms).map(([name, { size }]) => ({ name, size }));
}

/** Sends the archive the settings, along with a ledger that's being sent: if they changed, and not often. */
async function backUpSettings(cloud) {
  const backup = await readJson(BACKUP, null).catch(() => null) ?? { saved: null, at: 0 };
  if (Date.now() - backup.at < BACKUP_EVERY) return;
  try {
    // The looks the grades use go along, small, for the composer's Archive tab to grade with.
    const read = async (file) => ({ lut: await loadCube(file), mtime: (await stat(join(LUTS, file))).mtimeMs });
    const looks = await lookFiles({ grades: await readClips(GRADES), bases: await bases(), read });
    const saved = await saveSettings(cloud.request, [GRADES, EXPORTS], backup.saved, looks);
    if (saved !== backup.saved) await writeJson(BACKUP, { saved, at: Date.now() });
  } catch (e) {
    ledger.error = `Couldn't save the settings to Cloudflare: ${e.message}`;
    await writeJson(BACKUP, { ...backup, at: Date.now() });
  }
}

/**
 * One look: read back the ledger kept here, and the archive's copy once it can be reached, then merge in what's seen
 * now, keep it here and send it to the archive if anything in it changed.
 */
async function ledgerLook() {
  const cloud = await ledgerCloud(PUBLISHER);
  ledger.cloud = Boolean(cloud);
  ledger.error = null;
  if (!ledger.current) ledger.current = await readJson(LEDGER, null);
  if (cloud && !ledger.restored) {
    try {
      const remote = await cloud.read();
      ledger.current = unionLedgers(ledger.current, remote);
      ledger.sent = comparable(remote);
      // When the archive's copy was made: unchanged since, there's nothing to send, and it's still the time it was saved.
      ledger.savedAt = remote?.updatedAt ?? null;
      ledger.restored = true;
    } catch (e) {
      ledger.error = `Couldn't read the ledger in Cloudflare: ${e.message}`;
    }
  }
  const { seen, more } = await observe(cloud);
  const before = comparable(ledger.current);
  ledger.current = mergeLedger(ledger.current, seen);
  const morePictures = cloud && ledger.restored ? await sendThumbs(cloud) : false;
  const now = comparable(ledger.current);
  if (now !== before || !(await exists(LEDGER))) await writeJson(LEDGER, ledger.current);
  if (cloud && ledger.restored && now !== ledger.sent) {
    try {
      await cloud.write(ledger.current);
      ledger.sent = now;
      ledger.savedAt = ledger.current.updatedAt;
      await backUpSettings(cloud);
    } catch (e) {
      ledger.error = `Couldn't save the ledger to Cloudflare: ${e.message}`;
    }
  }
  return more || morePictures;
}

/** Looks again in `ms`; sooner after an export or a trash, and every few seconds while clips wait to be probed. */
function scheduleLedger(ms = LEDGER_EVERY) {
  clearTimeout(ledger.timer);
  ledger.timer = setTimeout(async () => {
    if (ledger.running) return scheduleLedger(1000);
    ledger.running = true;
    let more = false;
    try {
      more = await ledgerLook();
    } catch (e) {
      ledger.error = String(e.message || e);
      console.error(e);
    } finally {
      ledger.running = false;
    }
    scheduleLedger(more ? Math.min(5000, LEDGER_EVERY) : LEDGER_EVERY);
  }, ms);
}

// ---- offloading: the camera to this Mac, this Mac to the archive (offload.mjs) ---------------------------------------

/** The run going, or the last one: offload.mjs's `{ state, start, stop, poke, done }`. */
let offloading = null;
/** Set while a run is being started: the clips' profiles are read first. */
let starting = false;
/**
 * How the run was asked to go: on with no page open, with graded clips going up to YouTube meanwhile, and keeping this
 * Mac awake while it works.
 */
let runOptions = { unattended: false, youtube: true, keepAwake: true };
/** Keeps this Mac from sleeping when idle while the offload works, if it's to. */
const awake = wakeLock({ log: (line) => console.error(`grade: offload: ${line}`) });
/** When a clip goes from the card, "copied" to this Mac or "sent" to the archive: as last chosen, from run to run. */
let clearCardAfter = "copied";
/** When a page last asked how things are going. */
let polledAt = 0;
/** What the owner keeps out of it all. */
const keep = keepList(KEEP);
/** The shoot days' manifests: every run's saves go through the one. */
const fileInDay = dayManifests();
/** The site, on the crossposter helper's pairing. */
const site = pairedSite(PUBLISHER);
/** Pause all, from the composer's Footage tab (pause.mjs): every job here holds while `pause.held()` says why. */
const pause = pauseFlag({
  ask: () => site("footage"),
  every: Number(process.env.GRADE_PAUSE_EVERY || 30_000),
  changed: (held) => {
    offloading?.poke();
    if (held) return;
    void pumpExports();
    film.pump();
  },
});
/** Makes the transcripts. An export has the GPU first, and nothing starts while everything's paused. */
const transcripts = transcriber({
  audio: join(CACHE, "audio"),
  dir: join(DATA, "transcripts"),
  scratch: join(CACHE, "transcribing"),
  records: { read: () => readClips(TRANSCRIPTS), update: (change) => updateClips(TRANSCRIPTS, change) },
  uvx: process.env.GRADE_UVX,
  busy: () => Boolean(jobs.export.current || jobs.export.queue.length || pause.held()),
  skip: async (clip) => (await keep.keeping())(clip),
  made: () => offloading?.poke(),
});
/** The transcripts waiting to be sent: made, and their clips in the archive and not kept out of it since. */
async function transcriptsToSend() {
  await updating.get(OFFLOADED);
  const keeps = await keep.keeping();
  return (await transcripts.ready(await readClips(OFFLOADED))).filter((transcript) => !keeps(transcript));
}
const sizeOfAll = (clips) => clips.reduce((sum, clip) => sum + clip.size, 0);
async function roomOnMac() {
  const { bavail, bsize } = await statfs(MOVIES);
  return bavail * bsize;
}

/** A file's size and time, and until when it may still be being written: by `changed`, when that's later. */
function fileFacts({ size, mtimeMs }, changed = 0) {
  const written = Math.max(mtimeMs, changed);
  return { size, mtime: Math.round(mtimeMs), settles: written <= Date.now() ? written + SETTLE : 0 };
}
/** A place's clips, oldest first, by shoot day as it's listed: each with its size, time and day. Gone ones are left out. */
async function clipsOf(days, { byChange = false } = {}) {
  const clips = [];
  for (const [day, list] of days)
    for (const clip of list) {
      const s = await stat(clip.path).catch(() => null);
      // A file moved in by hand keeps its old time: what changed it last says if it's still being written.
      if (s) clips.push({ name: clip.name, path: clip.path, ...fileFacts(s, byChange ? s.ctimeMs : 0), day });
    }
  return clips.sort((a, b) => a.name.localeCompare(b.name));
}
async function macClips() {
  const clips = await clipsOf(await originalDays(), { byChange: true });
  // Preexp holds what the camera gave: its low-res copies go with the clips.
  for (const clip of clips)
    if (dirname(clip.path) === PREEXP) clip.sidecar = clip.path.replace(/\.mp4$/i, ".LRF");
  return clips;
}
/** The card's clips; null while it's unplugged, or as it is: what it lists can't all be found. */
async function cardClips({ fresh = false } = {}) {
  if (fresh) cardCache = null;
  const days = await card();
  if (!days) return null;
  const clips = await clipsOf(days);
  return clips.length === [...days.values()].flat().length ? clips : null;
}

const sameClip = (a, b) => stemOf(a).toLowerCase() === stemOf(b).toLowerCase();
/** A clip an export is making, or is queued to make: it stays where it is. */
const exporting = ({ name }) =>
  [jobs.export.current, ...jobs.export.queue].some((job) => job && sameClip(job.name, name));

function offloadState() {
  if (!offloading) return null;
  const { samples, ...state } = offloading.state;
  const [first, last] = [samples[0], samples.at(-1)];
  const speed = first && last && last[0] > first[0] ? ((last[1] - first[1]) / (last[0] - first[0])) * 1000 : null;
  return {
    ...state,
    ...runOptions,
    clearCardAfter,
    keepingAwake: awake.held,
    copy: { ...state.copy, ended: !state.copy.on },
    sentBytes: state.send.doneBytes + state.send.current.reduce((sum, clip) => sum + clip.sent, 0),
    speed,
  };
}

/**
 * The shoot days of the clips here and of those kept, newest first: how many clips each has here, whether all of it is
 * kept, and which of its clips are by name. A kept clip of no known day comes last, under none.
 */
function shootDays(clips, kept) {
  const days = new Map();
  const of = (day) => {
    if (!days.has(day)) days.set(day, { here: new Map(), keptClips: [] });
    return days.get(day);
  };
  for (const day of kept.days) of(day);
  for (const clip of clips) of(clip.day).here.set(clip.name, clip);
  for (const name of kept.clips) {
    const day = clips.find((clip) => sameClip(clip.name, name))?.day ?? djiDay(name);
    of(day ?? "").keptClips.push(name);
  }
  return [...days]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, { here, keptClips }]) => ({
      day,
      clips: here.size,
      bytes: sizeOfAll([...here.values()]),
      kept: kept.days.includes(day),
      keptClips,
    }));
}

/**
 * What an offload would take: the card's clips, the Mac's not in the archive yet, the transcripts made since; what's kept
 * out of it; the room on the Mac; and the run.
 */
async function offloadSummary() {
  const [record, kept, keeps] = await Promise.all([readClips(OFFLOADED), keep.read(), keep.keeping()]);
  const mounted = Boolean(await card());
  const [onCard, onMac] = await Promise.all([cardClips(), macClips()]);
  const here = [...(onCard ?? []), ...onMac];
  const counted = new Set(here.filter(keeps).map((clip) => stemOf(clip.name).toLowerCase()));
  const camera = (onCard ?? []).filter((clip) => !keeps(clip));
  /** The clips of a place to send, and how many are only there still to be deleted. */
  const toSend = (clips, sent) => {
    const left = clips.filter((clip) => sent[clip.name]?.size !== clip.size);
    return { clips: left.length, bytes: sizeOfAll(left), sent: clips.length - left.length };
  };
  return {
    camera: { mounted, clips: camera.length, bytes: sizeOfAll(camera) },
    mac: toSend(onMac.filter((clip) => !keeps(clip)), record),
    transcripts: { ...transcripts.summary(), toSend: (await transcriptsToSend()).length },
    kept: { ...kept, count: counted.size },
    days: shootDays(here, kept),
    room: { free: await roomOnMac(), keepFree: KEEP_FREE },
    clearCardAfter,
    keepingAwake: awake.held,
    run: offloadState(),
  };
}

/** Tells the composer's Footage tab how the offload stands, when it changes (report.mjs); the answer says if it's paused. */
const REPORT_PACE = Number(process.env.GRADE_REPORT_EVERY || REPORT_EVERY.running);
const reporting = macReporter({
  summary: offloadSummary,
  running: () => Boolean(offloading?.state.running),
  post: async (report) => {
    const answer = await site("footage/mac", report);
    if (answer) pause.learn(answer.paused ?? null);
    return answer;
  },
  every: { ...REPORT_EVERY, running: REPORT_PACE, alive: 4 * REPORT_PACE },
});

/**
 * Gives ungraded log clips the default look, as settings: they can be changed before any export. A clip nobody has
 * opened yet is probed for its profile, eight at a time.
 */
async function applyDefaultLook(clips) {
  const [grades, looks, known] = await Promise.all([readClips(GRADES), bases(), readClips(join(CACHE, "meta.json"))]);
  const todo = clips.filter((clip) => !grades[clip.name]);
  const added = {};
  async function worker() {
    for (let clip = todo.shift(); clip; clip = todo.shift()) {
      const profile = known[clip.path]?.meta?.profile ?? (await probe(clip.path).then((meta) => meta.profile, () => null));
      if (looks[profile]?.some((look) => look.id === DEFAULT_LOOK)) added[clip.name] = normalizeGrade({ base: DEFAULT_LOOK });
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  // A grade made meanwhile stays.
  if (Object.keys(added).length)
    await updateClips(GRADES, (all) => {
      for (const [name, grade] of Object.entries(added)) all[name] ??= grade;
    });
}
const withDefaultLook = (clips) => applyDefaultLook(clips).catch((e) => console.error("grade: default look:", e.message));

/** Why uploads wait, if they do: nobody is looking, and the run wasn't told to go on without. */
const uploadsPaused = () => (runOptions.unattended || Date.now() - polledAt <= WATCHED_FOR ? null : "No Grade page is open");

/** What went to the archive, kept in one of the app's files. `added` hears each clip once it's on disk. */
const recordsIn = (path, added) => ({
  read: async () => {
    await updating.get(path);
    return readClips(path);
  },
  add: async (clip, sha256, proof) => {
    await updateClips(path, (all) => {
      all[clip.name] = { sha256, size: clip.size, day: clip.day, at: new Date().toISOString(), ...proof };
    });
    added();
  },
  drop: async (sha256) => {
    await updating.get(path);
    const held = Object.values(await readClips(path)).some((record) => record.sha256 === sha256);
    if (!held) return;
    await updateClips(path, (all) => {
      for (const [name, record] of Object.entries(all)) if (record.sha256 === sha256) delete all[name];
    });
  },
});

/** What a request to offload asks for. */
function offloadAsked({ lanes, unattended, youtube, keepAwake, clearCardAfter: after }) {
  const some = Array.isArray(lanes) && lanes.every((lane) => LANES.includes(lane));
  if (lanes !== undefined && !some) throw httpError(400, `lanes must be some of ${LANES.join(", ")}`);
  const flags = Object.entries({ unattended, youtube, keepAwake }).filter(([, value]) => value !== undefined);
  for (const [name, value] of flags) if (typeof value !== "boolean") throw httpError(400, `${name} must be true or false`);
  if (after !== undefined && !["copied", "sent"].includes(after)) throw httpError(400, "clearCardAfter must be copied or sent");
  return { lanes: lanes && [...new Set(lanes)], flags: Object.fromEntries(flags), after };
}

/**
 * Turns switches on: the ones asked for, or the card (if it's plugged in) and Movies/Original, whichever are off. It goes
 * on in the background until each is done or stopped. Asked for none, it only changes how the run goes.
 */
async function startOffloading(asked) {
  if (starting) throw httpError(409, "Already starting");
  starting = true;
  try {
    await beginOffload(asked);
  } finally {
    starting = false;
  }
}
async function beginOffload({ lanes, flags, after }) {
  const isOn = (lane) => Boolean(offloading?.state[lane].on);
  const wanted = lanes ?? ((await card()) ? ["copy", "send"] : ["send"]).filter((lane) => !isOn(lane));
  if (wanted.some(isOn) || !(lanes || wanted.length)) throw httpError(409, "Already offloading");
  // A list of kept clips that can't be read stops it here.
  const keeps = await keep.keeping();
  const cloud = wanted.length ? await ledgerCloud(PUBLISHER) : null;
  if (wanted.length && !cloud) throw httpError(409, "Pair the crossposter helper first: the offload goes through it");
  if (after) {
    clearCardAfter = after;
    await writeJson(OFFLOAD, { clearCardAfter });
  }
  if (offloading?.state.running) Object.assign(runOptions, flags);
  if (!wanted.length) return;

  await mkdir(ORIGINAL, { recursive: true });
  // Before any clip moves: the look goes by name, the probing by where each clip is now.
  const taking = [];
  if (wanted.includes("copy")) taking.push(...((await cardClips()) ?? []));
  if (wanted.includes("send")) taking.push(...(await macClips()));
  await withDefaultLook(taking.filter((clip) => !keeps(clip)));
  if (wanted.includes("send")) transcripts.retry();
  if (offloading?.state.running) for (const lane of wanted) offloading.start(lane);
  else runOffload(wanted, cloud, flags);
}
function runOffload(lanes, cloud, flags) {
  runOptions = { unattended: false, youtube: true, keepAwake: true, ...flags };
  let added = 0;
  const landed = () => {
    added++;
    scheduleLedger(Math.min(2000, LEDGER_EVERY));
  };
  const run = startOffload({
    lanes,
    camera: cardClips,
    mac: macClips,
    records: recordsIn(OFFLOADED, landed),
    dir: ORIGINAL,
    request: cloud.request,
    room: roomOnMac,
    keepFree: KEEP_FREE,
    removable: async (clip) => !exporting(clip) && !film.reading(clip.name) && clip.name !== (await goingToYoutube(PUBLISHER)),
    keeping: keep.keeping,
    paused: uploadsPaused,
    pausedAll: pause.held,
    clearCardAfter: () => clearCardAfter,
    // A clip that turned up on the card since the run started has no look yet.
    copied: (clip) => void withDefaultLook([clip]),
    removed: () => {
      cardCache = null;
    },
    fileInDay,
    transcripts: {
      take: transcripts.take,
      ready: transcriptsToSend,
      sent: async (keys) => {
        await transcripts.sent(keys);
        scheduleLedger(2000);
      },
    },
    retry: { ...RETRY, first: RETRY_FIRST },
    log: (line) => console.error(`grade: offload: ${line}`),
    stayAwake: () => runOptions.keepAwake,
    awake: (on) => awake.hold(on),
  });
  offloading = run;

  // While it sends anything, and wasn't told not to, the composer counts as watching, so graded clips go up to YouTube
  // meanwhile (the helper's job).
  let watchFailed = null;
  async function watch() {
    if (!runOptions.youtube || !run.state.send.on || uploadsPaused()) return;
    const failed = await cloud.watchFootage().then(() => null, (e) => e.message);
    if (failed && failed !== watchFailed) console.error("grade: footage uploads:", failed);
    watchFailed = failed;
  }
  void watch();
  const watching = setInterval(watch, 60_000);
  void run.done.then(() => {
    clearInterval(watching);
    cardCache = null;
    // What went up meanwhile shows in the ledger without it; now the archive says so itself.
    if (added) ledger.archiveAt = 0;
    scheduleLedger(2000);
  });
}

// ---- bringing clips back from the archive (bring.mjs) -----------------------------------------------------------------

const cloudDays = archiveDays({ every: 60 * 60_000 });
const bringing = bringer({
  dir: ORIGINAL,
  room: roomOnMac,
  keepFree: KEEP_FREE,
  claims: stillToWrite,
  // Kept out of offload, or the next one would find it in the archive and take it off again.
  placing: (clip) => keep.add(clip.name),
  landed: () => scheduleLedger(2000),
  pausedAll: pause.held,
});

/** What's still to come onto this Mac from the exports, going by their originals' sizes, and from the card. */
async function stillToWrite() {
  const claims = [];
  const exports = [jobs.export.current, ...jobs.export.queue].filter(Boolean);
  let bytes = 0;
  for (const { id, name, quality, progress = 0 } of exports) {
    const path = (await source(id).catch(() => null))?.paths.get(name);
    const size = path ? (await sizeOf(path))?.size ?? 0 : 0;
    bytes += size * (quality / 100) * (1 - progress);
  }
  if (bytes) claims.push({ by: exports.length === 1 ? "the export" : `the ${exports.length} exports`, bytes });
  const copy = offloading?.state.copy;
  if (copy?.on)
    claims.push({ by: "the camera", bytes: copy.bytes - copy.doneBytes - (copy.current?.sent ?? 0) });
  const asset = film.claim();
  if (asset) claims.push(asset);
  return claims;
}

/** The offload that had ended when the archive was last read: the days it filed clips in show once it has. */
let filedBy = null;
/** Every clip in the archive's shoot days, and whether it's on this Mac; null while the helper isn't paired. */
async function cloudClips({ refresh = false } = {}) {
  const cloud = await ledgerCloud(PUBLISHER);
  if (!cloud) return null;
  const ended = offloading && !offloading.state.running ? offloading : null;
  const held = await cloudDays.read(cloud.request, { refresh: refresh || ended !== filedBy });
  filedBy = ended;
  return { ...held, request: cloud.request, clips: await withHere(held.clips, ORIGINAL) };
}

/** The archive's shoot days, each with how much of it isn't on this Mac; with `day`, that day's clips too. */
async function cloudSummary({ refresh, day }) {
  const held = await cloudClips({ refresh });
  const room = { free: await roomOnMac(), keepFree: KEEP_FREE };
  if (!held) return { paired: false, readAt: null, error: null, room, days: [] };
  const { clips, readAt, error } = held;
  const summary = { paired: true, readAt, error, room, days: summarise(clips) };
  if (!day) return summary;
  const pictured = await thumbStems();
  const rows = dayClips(clips, day).map((row) => ({ ...row, thumb: pictured.has(row.stem.toLowerCase()) }));
  return { ...summary, day, clips: rows };
}

/** Starts bringing a day's clips that aren't here, or the named ones. Says how many. */
async function startBringing(asked) {
  const held = await cloudClips();
  if (!held) throw httpError(409, "Pair the crossposter helper first: clips come back through it");
  if (!held.readAt) throw httpError(502, held.error);
  return bringing.add(held.request, pickClips(held.clips, asked));
}

/** Where a clip that's on neither the card nor this Mac is in the archive: its day there. */
async function findInCloud(stem) {
  const held = await cloudClips();
  const hit = (held?.clips ?? []).find((clip) => stemOf(clip.name).toLowerCase() === stem);
  if (hit) return { source: cloudId(hit.day), name: hit.name };
  if (held?.error) throw httpError(404, `That clip isn't on the camera or this Mac. ${held.error}`);
  throw httpError(404, "That clip isn't on the camera, this Mac or in Cloudflare");
}

/** Answers the requests about the archive's clips; says whether this was one. */
async function cloudRoute(req, res, p, url) {
  if (p === "/api/cloud" && req.method === "GET") {
    const asked = { refresh: url.searchParams.has("refresh"), day: url.searchParams.get("day") };
    send(res, 200, await cloudSummary(asked));
  } else if (p === "/api/bring" && req.method === "POST") {
    const { what, names, day } = await body(req);
    send(res, 200, { queued: await startBringing({ what, names, day }), bring: bringing.state() });
  } else if (p === "/api/bring/stop" && req.method === "POST") send(res, 200, { stopping: bringing.stop() });
  else if (p.startsWith("/media/cloud/")) {
    // The thumbnail its clip left in the cache.
    const file = (await thumbFiles()).get(stemOf(p.slice("/media/cloud/".length)).toLowerCase());
    if (!file) throw httpError(404, "not found");
    await serveFile(req, res, join(CACHE, "thumbs", file));
  } else return false;
  return true;
}

// ---- a film's assets: preview copies while it's made, trims when it's rendered (film.mjs) -----------------------------

/**
 * A clip by its name (any case, with or without its extension) wherever it is: in Original or Preexp, quicker to read,
 * else on the card. The very name before another with only its stem in common.
 */
async function locate(asked) {
  const wanted = String(asked).toLowerCase();
  let found = null;
  for (const [kind, days] of [["mac", await originalDays()], ["camera", (await card()) ?? new Map()]])
    for (const [day, list] of days)
      for (const clip of list) {
        const same = clip.name.toLowerCase() === wanted;
        if (!same && (found || stemOf(clip.name).toLowerCase() !== stemOf(wanted))) continue;
        const src = { id: `${kind}:${day}`, kind, label: day, paths: new Map([[clip.name, clip.path]]) };
        found = { name: clip.name, path: clip.path, src };
        if (same) return found;
      }
  return found;
}

/** Why a clip isn't on this Mac or the card, and where it is: Bring to Mac fetches it, nothing here does by itself. */
async function elsewhere(name) {
  const stem = stemOf(name).toLowerCase();
  const held = await cloudClips().catch(() => null);
  // Only originals come back from Cloudflare (#352), so any clip there is one.
  const hit = held?.clips.find((clip) => stemOf(clip.name).toLowerCase() === stem);
  if (hit) return `${name} isn't on this Mac: it's in Cloudflare (${hit.day}). Bring it back with Bring to Mac first`;
  if (!(await card())) return `${name} isn't on this Mac or in Cloudflare, and ${CAMERA_NAME} isn't connected`;
  return `${name} isn't on the camera, this Mac or in Cloudflare`;
}

/** A clip's grade key as things stand, by its name and profile: what decides whether a preview copy is current. */
async function gradeKeys() {
  const [grades, looks] = await Promise.all([readClips(GRADES), bases()]);
  return (name, profile) => gradeKey(resolveGrade(grades[name], (looks[profile] ?? []).map((b) => b.id)));
}

const film = filmAssets({
  cache: CACHE,
  records: { previews: PREVIEWS, trims: TRIMS },
  locate,
  meta: async (clip) => (await metas(clip.src, [clip.name]))[clip.name],
  elsewhere,
  graded: async (clip, use) => {
    const { meta, grade, cube } = await clipLut(clip.src, clip.name);
    return withLutFile(clip.name, cube, (lut) => use({ lut, meta, grade, key: gradeKey(grade) }));
  },
  keys: gradeKeys,
  // None is begun while an export goes, or while everything's paused from the Footage tab: the one being made finishes.
  exporting: () => Boolean(jobs.export.current || jobs.export.queue.length || pause.held()),
  encoder: () => exportEncoder,
  room: roomOnMac,
  keepFree: KEEP_FREE,
  // What exports, the card and Bring to Mac still have to write.
  claims: async () => {
    const bring = bringing.state();
    const coming = bring.running ? [{ by: "Bring to Mac", bytes: bring.bytes - bring.gotBytes }] : [];
    return [...(await stillToWrite()), ...coming];
  },
  remakeAfter: REMAKE_AFTER,
  log: (line) => console.error(`grade: film: ${line}`),
});

/** A list of clip names a request gives, up to 500. */
function clipNames(names) {
  const ok = Array.isArray(names) && names.length <= 500 && names.every((n) => typeof n === "string" && /^[^/\\,]{1,255}$/.test(n));
  if (!ok) throw httpError(400, "names must be a list of up to 500 clip names");
  return names;
}

/** Answers the requests about a film's assets; says whether this was one. */
async function filmRoute(req, res, p, url) {
  if (p === "/api/previews" && req.method === "GET") {
    const names = (url.searchParams.get("names") ?? "").split(",").filter(Boolean);
    send(res, 200, await film.previewStates(clipNames(names)));
  } else if (p === "/api/previews" && req.method === "POST")
    send(res, 200, await film.askPreviews(clipNames((await body(req)).names)));
  else if (p === "/api/previews/options" && req.method === "POST")
    send(res, 200, { autoRemake: await film.autoRemake((await body(req)).autoRemake) });
  else if (p === "/api/trims" && req.method === "POST") {
    const { trims, quality } = await body(req);
    send(res, 200, await film.askTrims(trims, { quality: quality === undefined ? 100 : exportQuality(quality) }));
  } else if (p === "/api/trims" && req.method === "GET") send(res, 200, await film.trimStates(url.searchParams.get("id")));
  else return false;
  return true;
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
  const [allGrades, records, graded] = await Promise.all([readClips(GRADES), readClips(EXPORTS), exportedStems()]);
  const grades = {};
  const clips = [];
  for (const name of names) {
    const k = key(id, name);
    if (allGrades[name]) grades[name] = allGrades[name];
    const thumb = await exists(thumbFile(name));
    if (!thumb) queueThumb(src, name, meta[name]);
    let exported = null;
    if (graded.has(stemOf(name))) {
      // An export without the app's record (put there by hand) counts as graded; its grade just isn't known.
      const r = records[name];
      const file = r ? null : await stat(exportedFile(name)).catch(() => null);
      if (r) exported = { key: r.key, at: r.exportedAt, fallback: r.fallback };
      else if (file) exported = { key: null, at: file.mtime.toISOString() };
    }
    clips.push({
      name,
      stem: stemOf(name),
      ...meta[name],
      thumb,
      proxy: proxyState(k, await exists(proxyFile(name))),
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

  if (p === "/" || p === "/index.html") {
    // Only the composer's Grade tab (post.kualta.dev/grade, or the site run locally) may show the app in a frame.
    res.setHeader("Content-Security-Policy", `frame-ancestors 'self' ${FRAMED_BY.join(" ")}`);
    return serveFile(req, res, join(here, "ui/index.html"));
  }
  if (p === "/color.mjs") return serveFile(req, res, join(here, "color.mjs"));
  if (/^\/ui\/\w[\w.-]*$/.test(p)) return serveFile(req, res, join(here, p));

  if (p === "/api/library" && req.method === "GET") return send(res, 200, await library());
  if (p === "/api/ledger" && req.method === "GET")
    return send(res, 200, {
      ledger: ledger.current,
      cloud: ledger.cloud,
      savedAt: ledger.savedAt,
      error: ledger.error ?? ledger.archiveError,
    });
  // Where a clip is, by its name, for the Footage tab's Grade: the card's day holding it, else Movies/Original's, else
  // the archive's.
  if (p === "/api/find" && req.method === "GET") {
    const wanted = stemOf(url.searchParams.get("clip") ?? "").toLowerCase();
    const places = [
      ["camera", (await card()) ?? new Map()],
      ["mac", await originalDays()],
    ];
    for (const [kind, days] of places)
      for (const [day, list] of days) {
        const hit = list.find((c) => stemOf(c.name).toLowerCase() === wanted);
        if (hit) return send(res, 200, { source: `${kind}:${day}`, name: hit.name });
      }
    return send(res, 200, await findInCloud(wanted));
  }
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
    const incoming = Object.entries((await body(req)).clips ?? {});
    for (const [name] of incoming) if (!src.paths.has(name)) throw httpError(400, `unknown clip ${name}`);
    await updateClips(GRADES, (clips) => Object.assign(clips, Object.fromEntries(incoming)));
    await film.regraded(incoming.map(([name]) => name));
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
    const path = { proxy: () => proxyFile(name), thumb: () => thumbFile(name), original: () => src.paths.get(name) }[kind]();
    return serveFile(req, res, path);
  }

  if (p === "/api/export" && req.method === "POST") {
    const { source: id, names, quality: q, encoder: on = exportEncoder } = await body(req);
    const src = await source(String(id));
    const quality = exportQuality(q);
    const encoder = encoderAsked(on);
    for (const name of names ?? []) {
      if (!src.paths.has(name)) throw httpError(400, `unknown clip ${name}`);
      if (jobs.export.current?.id === src.id && jobs.export.current?.name === name) continue;
      const queued = jobs.export.queue.find((j) => j.id === src.id && j.name === name);
      if (queued) Object.assign(queued, { quality, encoder });
      else jobs.export.queue.push({ id: src.id, name, quality, encoder });
    }
    jobs.export.failed = jobs.export.failed.filter((f) => !(f.id === src.id && (names ?? []).includes(f.name)));
    // An export never waits for a film's preview copy or trim: the one being made stops, and goes on afterwards.
    if (jobs.export.queue.length) film.giveWay();
    pumpExports();
    return send(res, 200, { queued: jobs.export.queue.length });
  }

  if (p === "/api/export/stop" && req.method === "POST") return send(res, 200, { stopped: stopExports() });

  // What encodes exports from now on, remembered.
  if (p === "/api/export/encoder" && req.method === "POST") {
    exportEncoder = encoderAsked((await body(req)).encoder);
    await writeJson(ENCODER, { exportEncoder });
    return send(res, 200, { exportEncoder });
  }

  if (p === "/api/export-frame" && req.method === "POST") {
    const { source: id, name, frame } = await body(req);
    const src = await source(String(id));
    if (!src.paths.has(name)) throw httpError(400, `unknown clip ${name}`);
    if (!Number.isInteger(frame) || frame < 0) throw httpError(400, "frame must be a whole number from 0");
    return send(res, 200, { file: await frameOne(src, name, frame) });
  }

  if (p === "/api/jobs" && req.method === "GET") {
    // Asked by an open page every few seconds: uploads go on while it is.
    polledAt = Date.now();
    return send(res, 200, {
      thumbs: jobs.thumb.queue.length + jobs.thumb.busy,
      proxy: { queued: jobs.proxy.queue.length, current: jobs.proxy.current && { id: jobs.proxy.current.id, name: jobs.proxy.current.name } },
      export: { ...jobs.export, encoder: exportEncoder },
      offload: offloadState(),
      transcripts: transcripts.summary(),
      bring: bringing.state(),
      ...film.state(),
      // Everything paused from the composer's Footage tab, since when; null while it isn't.
      paused: pause.since === null ? null : { since: pause.since },
    });
  }

  // Bringing clips back from the archive.
  if (await cloudRoute(req, res, p, url)) return;
  // A film's preview copies and trims.
  if (await filmRoute(req, res, p, url)) return;

  // Offloading: the card to this Mac, this Mac to the archive, each switched on and off by itself.
  if (p === "/api/offload" && req.method === "GET") return send(res, 200, await offloadSummary());
  if (p === "/api/offload" && req.method === "POST") {
    await startOffloading(offloadAsked(await body(req)));
    return send(res, 200, await offloadSummary());
  }
  if (p === "/api/offload/stop" && req.method === "POST") {
    const { now, ...asked } = await body(req);
    const { lanes } = offloadAsked(asked);
    offloading?.stop(lanes, { now: now === true });
    return send(res, 200, { stopping: Boolean(offloading?.state.running), run: offloadState() });
  }
  if (p === "/api/offload/keep" && req.method === "GET") return send(res, 200, await keep.read());
  if (p === "/api/offload/keep" && req.method === "POST") {
    const list = await keep.set(await body(req));
    offloading?.poke();
    return send(res, 200, list);
  }

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

for (const dir of [ORIGINAL, EXPORTED, DATA, CACHE]) await mkdir(dir, { recursive: true });
await clearParts([ORIGINAL]);
clearCardAfter = (await readJson(OFFLOAD, null).catch(() => null))?.clearCardAfter === "sent" ? "sent" : "copied";
const chosen = (await readJson(ENCODER, null).catch(() => null))?.exportEncoder;
if (ENCODERS.includes(chosen)) exportEncoder = chosen;
// Paused before a restart, it's still paused: asked before Whisper picks up where it was, unless the site is slow to say.
await Promise.race([pause.check(), new Promise((resolve) => setTimeout(resolve, 5000))]);
await transcripts.resume().catch((e) => console.error("grade: transcripts:", e.message));
await film.start().catch((e) => console.error("grade: film:", e.message));
server.listen(PORT, "127.0.0.1", () => {
  const address = `http://127.0.0.1:${PORT}`;
  console.log(`grade: ${address}  (movies ${MOVIES}, camera ${CAMERA}, data ${DATA}, LUTs ${LUTS})`);
  if (process.argv.includes("--open")) execFile("open", [address], () => {});
  scheduleLedger(Math.min(2000, LEDGER_EVERY));
  pause.start();
  reporting.start();
});
