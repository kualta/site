#!/usr/bin/env node
// The grade app's local server: a library of shoots (<root>/<shoot>/originals/*.MP4), a preview proxy per clip, each
// shoot's grades in <shoot>/grades.json, and exports baked from the originals into <shoot>/graded/ with a
// .grade.json beside each file saying exactly what was applied. Listens on 127.0.0.1 only.
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { composeLut, gradeKey, parseCube, PROFILES, resolveGrade, writeCube } from "./color.mjs";
import { cameraClips, exportClip, importClip, makeCalibration, makeProxy, makeThumb, probe, VIDEO } from "./media.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.GRADE_ROOT || join(homedir(), "Movies/Pocket4P");
const LUTS = process.env.GRADE_LUTS || join(ROOT, "luts");
const CAMERA = process.env.GRADE_CAMERA || "/Volumes/Pocket4P/DCIM";
const PORT = Number(process.env.GRADE_PORT || 4777);
const EXPORT_LUT_SIZE = 65;

// ---- base looks: a .cube per profile that takes that profile's code values ------------------------------------

const P4P = [
  ["01", "Neutral", "Start here"], ["02", "FlatBase", "Start here"], ["03", "Natural", "Everyday"], ["12", "Punch", "Everyday"],
  ["04", "PrintFilm", "Film"], ["06", "Bleach", "Film"], ["11", "RetroFade", "Film"], ["10", "Mono", "Film"],
  ["05", "TealAmber", "Situational"], ["07", "NightNeon", "Situational"], ["08", "Golden", "Situational"], ["09", "Nordic", "Situational"],
];
const REGISTRY = [
  { id: "none", name: "As shot", group: "Camera", files: { dlog2: null, dlog: null, hlg: null, rec709: null } },
  { id: "aces", name: "ACES conversion", group: "ACES", files: { dlog2: "dlog2-to-rec709-aces2.cube", dlog: "dlog-to-rec709-aces2.cube", hlg: "hlg-to-rec709-aces2.cube" } },
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

// ---- library ------------------------------------------------------------------------------------------------------

const stemOf = (name) => name.slice(0, name.length - extname(name).length);
function shootDir(id) {
  if (!/^[A-Za-z0-9_-][\w.-]*$/.test(id) || id.includes("..")) throw httpError(400, "bad shoot name");
  return join(ROOT, id);
}

async function shoots() {
  const dirs = (await readdir(ROOT, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && !d.name.startsWith("."));
  const out = [];
  for (const d of dirs) {
    const files = await readdir(join(ROOT, d.name, "originals")).catch(() => null);
    if (files) out.push({ id: d.name, clips: files.filter((f) => VIDEO.test(f) && !f.startsWith(".")).length });
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
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

async function clipNames(id) {
  const files = await readdir(join(shootDir(id), "originals")).catch(() => {
    throw httpError(404, "no such shoot");
  });
  return files.filter((f) => VIDEO.test(f) && !f.startsWith(".")).sort();
}

/** Camera metadata per clip, probed once and kept in <shoot>/.grade/meta.json by size and modification time. */
async function metas(id, names) {
  const file = join(shootDir(id), ".grade/meta.json");
  const cache = await readJson(file, {});
  let changed = false;
  const out = {};
  for (const name of names) {
    const s = await stat(join(shootDir(id), "originals", name));
    const hit = cache[name];
    if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs) out[name] = hit.meta;
    else {
      const meta = await probe(join(shootDir(id), "originals", name));
      cache[name] = { size: s.size, mtimeMs: s.mtimeMs, meta };
      out[name] = meta;
      changed = true;
    }
  }
  if (changed) await writeJson(file, cache);
  return out;
}

const gradesFile = (id) => join(shootDir(id), "grades.json");
const proxyFile = (id, name) => join(shootDir(id), ".grade/proxies", `${stemOf(name)}.mp4`);
const thumbFile = (id, name) => join(shootDir(id), ".grade/thumbs", `${stemOf(name)}.jpg`);
const gradedFile = (id, name) => join(shootDir(id), "graded", `${stemOf(name)}.mp4`);
const sidecarFile = (id, name) => join(shootDir(id), "graded", `${stemOf(name)}.grade.json`);

// ---- background jobs: proxies, exports, imports --------------------------------------------------------------------

const jobs = {
  proxy: { queue: [], current: null, failed: {} },
  export: { queue: [], current: null, done: [], failed: [] },
  import: { running: false, total: 0, done: 0, current: null, failed: [] },
};
const key = (id, name) => `${id}/${name}`;

function queueProxy(id, name, meta) {
  const k = key(id, name);
  if (jobs.proxy.current?.k === k || jobs.proxy.queue.some((j) => j.k === k) || jobs.proxy.failed[k]) return;
  jobs.proxy.queue.push({ k, id, name, meta });
  pumpProxies();
}
let proxyBusy = false;
async function pumpProxies() {
  if (proxyBusy) return;
  proxyBusy = true;
  while (jobs.proxy.queue.length) {
    const job = jobs.proxy.queue.shift();
    jobs.proxy.current = job;
    try {
      const proxy = proxyFile(job.id, job.name);
      await makeProxy(join(shootDir(job.id), "originals", job.name), proxy, job.meta);
      await makeThumb(proxy, thumbFile(job.id, job.name), Math.min(1, job.meta.duration / 2));
    } catch (e) {
      jobs.proxy.failed[job.k] = String(e.message || e);
    }
    jobs.proxy.current = null;
  }
  proxyBusy = false;
}

let exportBusy = false;
async function pumpExports() {
  if (exportBusy) return;
  exportBusy = true;
  while (jobs.export.queue.length) {
    const job = jobs.export.queue.shift();
    jobs.export.current = { ...job, progress: 0 };
    try {
      await exportOne(job.id, job.name, (p) => {
        jobs.export.current.progress = p;
      });
      jobs.export.done.unshift({ ...job, at: new Date().toISOString() });
      jobs.export.done.length = Math.min(jobs.export.done.length, 100);
    } catch (e) {
      jobs.export.failed.unshift({ ...job, error: String(e.message || e) });
    }
    jobs.export.current = null;
  }
  exportBusy = false;
}

async function exportOne(id, name, onProgress) {
  const meta = (await metas(id, [name]))[name];
  const available = (await bases())[meta.profile];
  const grade = resolveGrade((await readJson(gradesFile(id), { clips: {} })).clips?.[name], available.map((b) => b.id));
  const base = available.find((b) => b.id === grade.base);
  const lut = composeLut({
    profile: meta.profile,
    grade,
    shotK: meta.cameraKelvin,
    base: base.file ? await loadCube(base.file) : null,
    size: EXPORT_LUT_SIZE,
  });
  const stem = stemOf(name);
  const cube = join(shootDir(id), "graded/luts", `${stem}.cube`);
  await mkdir(dirname(cube), { recursive: true });
  await writeFile(cube, writeCube(EXPORT_LUT_SIZE, lut, `${stem} · ${base.name} · grade app`));
  await exportClip({ src: join(shootDir(id), "originals", name), dst: gradedFile(id, name), cube, matrix: meta.matrix, duration: meta.duration, onProgress });
  await writeJson(sidecarFile(id, name), {
    source: `originals/${name}`,
    graded: `graded/${stem}.mp4`,
    lut: `graded/luts/${stem}.cube`,
    profile: meta.profile,
    cameraKelvin: meta.cameraKelvin,
    base: { id: base.id, name: base.name, file: base.file },
    grade,
    key: gradeKey(grade),
    exportedAt: new Date().toISOString(),
    tool: "scripts/grade",
  });
}

/** Import one shoot day's new clips off the camera. Marked running at once, so a poll right after sees it. */
async function runImport(shoot) {
  const j = jobs.import;
  if (j.running) return;
  Object.assign(j, { running: true, shoot, total: 0, done: 0, current: null, failed: [] });
  try {
    const list = ((await cameraClips(CAMERA, ROOT)) ?? []).filter((c) => c.shoot === shoot);
    j.total = list.length;
    for (const clip of list) {
      j.current = clip.name;
      try {
        await importClip(clip);
      } catch (e) {
        j.failed.push({ name: clip.name, error: String(e.message || e) });
      }
      j.done++;
    }
  } catch (e) {
    j.failed.push({ name: shoot, error: String(e.message || e) });
  } finally {
    Object.assign(j, { running: false, current: null });
    cameraCache = null;
  }
}

let cameraCache = null;
async function cameraStatus() {
  if (cameraCache && Date.now() - cameraCache.at < 5000) return cameraCache.value;
  const list = await cameraClips(CAMERA, ROOT).catch(() => null);
  const byShoot = {};
  for (const c of list ?? []) {
    byShoot[c.shoot] ??= { shoot: c.shoot, clips: 0, bytes: 0 };
    byShoot[c.shoot].clips++;
    byShoot[c.shoot].bytes += c.size;
  }
  const value = list
    ? { mounted: true, newClips: list.length, shoots: Object.values(byShoot).sort((a, b) => b.shoot.localeCompare(a.shoot)) }
    : { mounted: false, newClips: 0, shoots: [] };
  cameraCache = { at: Date.now(), value };
  return value;
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

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
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

const TYPES = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".mp4": "video/mp4", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

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

function proxyState(k, ready) {
  if (ready) return "ready";
  if (jobs.proxy.failed[k]) return "failed";
  if (jobs.proxy.current?.k === k) return "working";
  return "queued";
}

async function shootPayload(id) {
  const names = await clipNames(id);
  const meta = await metas(id, names);
  const grades = (await readJson(gradesFile(id), { clips: {} })).clips ?? {};
  const clips = [];
  for (const name of names) {
    const k = key(id, name);
    const ready = await exists(thumbFile(id, name));
    if (!ready) queueProxy(id, name, meta[name]);
    const sidecar = await readJson(sidecarFile(id, name), null);
    clips.push({
      name,
      stem: stemOf(name),
      ...meta[name],
      proxy: proxyState(k, ready),
      proxyError: jobs.proxy.failed[k] ?? null,
      exported: sidecar && (await exists(gradedFile(id, name))) ? { key: sidecar.key, at: sidecar.exportedAt } : null,
    });
  }
  return { id, clips, grades };
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

  if (p === "/api/library" && req.method === "GET") return send(res, 200, { root: ROOT, luts: LUTS, shoots: await shoots(), camera: await cameraStatus() });
  if (p === "/api/bases" && req.method === "GET") return send(res, 200, await bases());
  if (p === "/api/calibration" && req.method === "GET") {
    const { expected } = await calibrationData();
    return send(res, 200, { video: `/media/calibration.mp4?v=${CALIBRATION_VERSION}`, expected });
  }
  if (p === "/media/calibration.mp4") {
    await calibrationData();
    return serveFile(req, res, calibrationVideo);
  }

  let m = /^\/api\/shoots\/([^/]+)$/.exec(p);
  if (m && req.method === "GET") return send(res, 200, await shootPayload(m[1]));

  m = /^\/api\/shoots\/([^/]+)\/grades$/.exec(p);
  if (m && req.method === "PUT") {
    const id = m[1];
    const names = await clipNames(id);
    const incoming = (await body(req)).clips ?? {};
    const file = await readJson(gradesFile(id), { version: 1, clips: {} });
    file.version = 1;
    file.clips ??= {};
    for (const [name, grade] of Object.entries(incoming)) {
      if (!names.includes(name)) throw httpError(400, `unknown clip ${name}`);
      file.clips[name] = grade;
    }
    file.updatedAt = new Date().toISOString();
    await writeJson(gradesFile(id), file);
    return send(res, 200, { ok: true });
  }

  m = /^\/api\/lut\/(\w+)\/([^/]+)$/.exec(p);
  if (m && req.method === "GET") {
    const base = (await bases())[m[1]]?.find((b) => b.id === m[2]);
    if (!base?.file) throw httpError(404, "no such base");
    const lut = await loadCube(base.file);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "X-Lut-Size": String(lut.size), "Cache-Control": "no-cache" });
    return res.end(Buffer.from(lut.data.buffer, lut.data.byteOffset, lut.data.byteLength));
  }

  m = /^\/media\/([^/]+)\/(proxy|thumb)\/([^/]+)$/.exec(p);
  if (m) {
    const [, id, kind, file] = m;
    const name = (await clipNames(id)).find((n) => stemOf(n) === stemOf(file));
    if (!name) throw httpError(404, "no such clip");
    return serveFile(req, res, kind === "proxy" ? proxyFile(id, name) : thumbFile(id, name));
  }

  if (p === "/api/export" && req.method === "POST") {
    const { shoot, names } = await body(req);
    const all = await clipNames(shoot);
    for (const name of names ?? []) {
      if (!all.includes(name)) throw httpError(400, `unknown clip ${name}`);
      if (jobs.export.current?.id === shoot && jobs.export.current?.name === name) continue;
      if (!jobs.export.queue.some((j) => j.id === shoot && j.name === name)) jobs.export.queue.push({ id: shoot, name });
    }
    jobs.export.failed = jobs.export.failed.filter((f) => !(f.id === shoot && (names ?? []).includes(f.name)));
    pumpExports();
    return send(res, 200, { queued: jobs.export.queue.length });
  }

  if (p === "/api/import" && req.method === "POST") {
    const { shoot } = await body(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(shoot))) throw httpError(400, "pick a shoot day to import");
    if (jobs.import.running) throw httpError(409, "an import is already running");
    runImport(shoot);
    return send(res, 200, { started: true });
  }

  if (p === "/api/jobs" && req.method === "GET")
    return send(res, 200, {
      proxy: { queued: jobs.proxy.queue.length, current: jobs.proxy.current && { id: jobs.proxy.current.id, name: jobs.proxy.current.name } },
      export: jobs.export,
      import: jobs.import,
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
  console.log(`grade: ${address}  (library ${ROOT}, LUTs ${LUTS})`);
  if (process.argv.includes("--open")) execFile("open", [address], () => {});
});
