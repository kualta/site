// A film's assets, made from the clips' grades. While a film is being made it uses small graded preview copies of
// whole clips; when it's rendered, only the seconds it uses are exported at full quality, as trims. Both live in the
// cache (never Movies/Exported), each recorded in the data folder with the grade it was made from, so a preview copy
// whose clip is graded again since is "stale" until it's made again, and an identical trim is the same file.
//
// One is made at a time, trims first, and none while an export is going or waiting: an export that comes stops the one
// being made, which goes back to the head of its queue. Nothing is fetched from the archive: a clip that isn't on this
// Mac or the card says where it is instead.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stemOf } from "./ledger.mjs";
import { exportTrim, makePreview, PREVIEW_RATE } from "./media.mjs";

const DAY = 24 * 60 * 60_000;
/** A file's last use is written down at most this often: it's read each time a film asks. */
const TOUCH_EVERY = 60 * 60_000;
/** The trim batches answered for, the latest first: older ones are forgotten. */
const BATCHES = 200;
/** What a trim's sound comes to, bits a second. */
const TRIM_SOUND = 320_000;

const low = (name) => stemOf(String(name)).toLowerCase();
const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
const exists = (path) =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
const refuse = (message) => Object.assign(new Error(message), { status: 400 });
const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const whyNot = (error) => String(error?.message || error).split("\n")[0];

/** A JSON file of the module's own, `{ version: 1, clips }` and whatever else: changed one change after another. */
function recordFile(path) {
  let last = Promise.resolve();
  const read = async () => {
    try {
      const data = JSON.parse(await readFile(path, "utf8"));
      return { ...data, clips: data.clips ?? {} };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, clips: {} };
      throw error;
    }
  };
  return {
    read: async () => {
      await last;
      return read();
    },
    update(change) {
      const run = last.then(async () => {
        const data = await read();
        change(data);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.part`, `${JSON.stringify({ ...data, version: 1 }, null, 2)}\n`);
        await rename(`${path}.part`, path);
      });
      last = run.catch(() => {});
      return run;
    },
  };
}

/** A trim's file: the clip's name, its start and end in milliseconds, and a hash of the grade it's made with. */
function trimName(name, { startMs, endMs, quality }, key) {
  const hash = createHash("sha256")
    .update(quality < 100 ? `${key} @${quality}%` : key)
    .digest("hex")
    .slice(0, 10);
  return `${stemOf(name)}-${startMs}-${endMs}-${hash}.mp4`;
}

/** What a trim asks for, checked: a clip's name, and seconds in its original, the end after the start. */
function trimAsked(trim) {
  const { name, start, end } = trim ?? {};
  if (typeof name !== "string" || !/^[^/\\]{1,255}$/.test(name)) throw refuse("each trim needs the name of its clip");
  const seconds = (t) => typeof t === "number" && Number.isFinite(t) && t >= 0;
  if (!seconds(start) || !seconds(end) || Math.round(end * 1000) <= Math.round(start * 1000))
    throw refuse(`${name}: start and end are seconds in the original, the end at least a millisecond after the start`);
  return { name, start, end, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) };
}

/**
 * The preview copies and trims. `cache` holds their files (previews/, trims/); `records` names the two JSON files that
 * say what each was made from (previews.json, trims.json). The server says the rest:
 *
 * - `locate(name)`: the clip of that name (any case, with or without its extension) on this Mac or the card, as
 *   `{ name, path, src }`, or null; `meta(clip)` what ffprobe says of it;
 * - `elsewhere(name)`: why a clip that isn't here isn't, and where it is;
 * - `graded(clip, use)`: calls `use({ lut, meta, grade, key })` with its grade's LUT in a file of its own;
 * - `keys()`: a function giving a clip's grade key now, from its name and its profile;
 * - `exporting()`: whether an export is going or waiting; `encoder()`: what exports are encoded on;
 * - `room()`, `keepFree`, `claims()`: bytes free here, how many of them stay free, and what else is still to be written.
 */
export function filmAssets({
  cache,
  records,
  locate,
  meta,
  elsewhere,
  graded,
  keys,
  exporting,
  encoder,
  room,
  keepFree,
  claims = async () => [],
  remakeAfter = 5000,
  keepFor = 30 * DAY,
  log = () => {},
}) {
  const dirs = { previews: join(cache, "previews"), trims: join(cache, "trims") };
  const files = { previews: recordFile(records.previews), trims: recordFile(records.trims) };
  const queue = { trims: [], previews: [] };
  /** The one being made: its job, how far it is, and how to stop it. */
  let current = null;
  let working = null;
  /** Preview copies whose last making failed, by clip; and the trims that did. */
  const failed = new Map();
  let failedTrims = [];
  const batches = new Map();
  const timers = new Map();
  let autoRemake = false;

  const previewFile = (name) => join(dirs.previews, `${stemOf(name)}.mp4`);
  /** A clip's preview record and the name it's under, by the clip's name in any case or with any extension. */
  const recordOf = (clips, stem) => Object.entries(clips).find(([name]) => low(name) === stem) ?? [];
  const jobs = () => [current?.job, ...queue.trims, ...queue.previews].filter(Boolean);
  /** "making" or "queued" while a clip's preview copy is, else null. */
  function previewJob(stem) {
    if (current?.job.kind === "preview" && current.job.stem === stem) return "making";
    return queue.previews.some((job) => job.stem === stem) ? "queued" : null;
  }
  /** A trim as /api/jobs and its failures say it: its clip, and its start and end in seconds. */
  const aboutTrim = (job) => ({ name: job.name, start: job.startMs / 1000, end: job.endMs / 1000 });

  /** Notes when files were last asked for, at most every TOUCH_EVERY: they go after keepFor unused. */
  async function touch(which, keys) {
    const now = Date.now();
    const old = (record) => now - Date.parse(record.usedAt ?? 0) > TOUCH_EVERY;
    const data = await files[which].read();
    if (!keys.some((k) => data.clips[k] && old(data.clips[k]))) return;
    await files[which].update(({ clips }) => {
      for (const k of keys) if (clips[k] && old(clips[k])) clips[k].usedAt = new Date(now).toISOString();
    });
  }

  /**
   * Throws, saying why, when writing that many more bytes would leave less than `keepFree`; else they're the job's claim
   * from then on.
   */
  async function needRoom(doing, bytes) {
    const others = (await claims()).reduce((sum, claim) => sum + Math.max(0, claim.bytes), 0);
    const free = await room();
    if (free - bytes - others < keepFree) {
      const also = others ? `, ${gb(others)} still to come from elsewhere` : "";
      throw new Error(
        `No room on this Mac: ${gb(bytes)} to write, ${gb(free)} free, ${gb(keepFree)} of it kept free${also}`,
      );
    }
    doing.bytes = bytes;
  }

  /**
   * Lets go of preview copies and trims nobody has asked for in `keepFor`, files with no record that are as old, and
   * records whose files are gone. None that's queued or being made.
   */
  async function sweep() {
    const now = Date.now();
    const busy = new Set(jobs().map((job) => job.file ?? previewFile(job.name)));
    const old = (time) => now - Date.parse(time ?? 0) > keepFor;
    for (const which of ["previews", "trims"]) {
      const path = (k, record) => (which === "previews" ? record.file : join(dirs.trims, k));
      const { clips } = await files[which].read();
      const going = [];
      for (const [k, record] of Object.entries(clips)) {
        const file = path(k, record);
        if (!busy.has(file) && (!(await exists(file)) || old(record.usedAt ?? record.madeAt))) going.push([k, file]);
      }
      if (going.length)
        await files[which].update((data) => {
          for (const [k] of going) delete data.clips[k];
        });
      for (const [, file] of going) await rm(file, { force: true });
      const kept = new Set(Object.entries(clips).map(([k, record]) => path(k, record)));
      for (const name of await readdir(dirs[which]).catch(() => [])) {
        const file = join(dirs[which], name);
        if (kept.has(file) || busy.has(file) || name.startsWith(".")) continue;
        const info = await stat(file).catch(() => null);
        if (info && old(info.mtime.toISOString())) await rm(file, { force: true });
      }
    }
  }

  // ---- making them, one at a time ----------------------------------------------------------------------------------

  function pump() {
    if (working || exporting()) return;
    working = work().finally(() => {
      working = null;
      if (queue.trims.length || queue.previews.length) pump();
    });
  }

  async function work() {
    while (!exporting()) {
      const job = queue.trims.shift() ?? queue.previews.shift();
      if (!job) return;
      const doing = { job, progress: 0, stop: new AbortController(), gaveWay: false };
      current = doing;
      try {
        await sweep().catch((e) => log(`couldn't clear the cache: ${whyNot(e)}`));
        await (job.kind === "trim" ? makeTrim(job, doing) : makePreviewOf(job, doing));
      } catch (error) {
        if (doing.gaveWay) queue[job.kind === "trim" ? "trims" : "previews"].unshift(job);
        else if (job.kind === "trim") {
          job.error = whyNot(error);
          failedTrims = [{ ...aboutTrim(job), error: job.error }, ...failedTrims].slice(0, 20);
          log(`trim of ${job.name} failed: ${job.error}`);
        } else {
          failed.set(job.stem, { name: job.name, error: whyNot(error) });
          log(`preview copy of ${job.name} failed: ${whyNot(error)}`);
        }
      }
      current = null;
    }
  }

  /** What making a job hears: how far it is, and a GPU that gave way. */
  const hearing = (doing) => ({
    onProgress: (p) => {
      doing.progress = p;
    },
    onFallback: (why) => {
      log(`${doing.job.name}: encoding on the CPU, the GPU couldn't: ${why}`);
      Object.assign(doing, { fallback: why, progress: 0 });
    },
    signal: doing.stop.signal,
  });

  async function makePreviewOf(job, doing) {
    const clip = await locate(job.name);
    // Gone since it was asked for: its state says where it is.
    if (!clip) return;
    const about = await meta(clip);
    await needRoom(doing, (about.duration * (PREVIEW_RATE + (about.audioBitrate || 0)) * 1.1) / 8);
    const dst = previewFile(clip.name);
    const { key, made } = await graded(clip, async ({ lut, meta: m, grade, key }) => ({
      key,
      made: await makePreview({
        src: clip.path,
        dst,
        cube: lut,
        matrix: m.matrix,
        deflicker: grade.deflicker,
        duration: m.duration,
        width: m.width,
        height: m.height,
        fps: m.fps,
        encoder: encoder(),
        ...hearing(doing),
      }),
    }));
    const now = new Date().toISOString();
    const { size } = await stat(dst);
    await files.previews.update(({ clips }) => {
      for (const name of Object.keys(clips)) if (low(name) === job.stem) delete clips[name];
      clips[clip.name] = {
        file: dst,
        key,
        profile: about.profile,
        source: clip.path,
        width: made.width,
        height: made.height,
        fps: about.fps,
        duration: about.duration,
        size,
        encoder: made.encoder,
        ...(made.fallback ? { fallback: made.fallback } : {}),
        madeAt: now,
        usedAt: now,
      };
    });
    failed.delete(job.stem);
    // Graded again while it was being made: stale already.
    if (autoRemake && (await keys())(clip.name, about.profile) !== key) queue.previews.push(job);
  }

  async function makeTrim(job, doing) {
    const clip = await locate(job.name);
    if (!clip) {
      job.missing = true;
      throw new Error(await elsewhere(job.name));
    }
    const about = await meta(clip);
    const [start, end] = [job.startMs / 1000, job.endMs / 1000];
    if (start >= about.duration)
      throw new Error(`${clip.name} ends at ${about.duration.toFixed(3)} s, before ${start} s`);
    const seconds = Math.min(end, about.duration) - start;
    const bits = about.videoBitrate || ((about.bytes || 0) * 8) / (about.duration || 1);
    // A full-quality export comes to up to four times the camera's bitrate.
    await needRoom(doing, (seconds * (bits * (job.quality < 100 ? job.quality / 100 : 4) + TRIM_SOUND) * 1.1) / 8);
    await graded(clip, async ({ lut, meta: m, grade, key }) => {
      // Graded again since it was asked for: it's made with the grade there is now, and named for it.
      if (key !== job.key) Object.assign(job, { key, file: join(dirs.trims, trimName(clip.name, job, key)) });
      const made = await exportTrim({
        src: clip.path,
        dst: job.file,
        cube: lut,
        matrix: m.matrix,
        deflicker: grade.deflicker,
        start,
        end,
        duration: m.duration,
        width: m.width,
        height: m.height,
        fps: m.fps,
        quality: job.quality,
        videoBitrate: m.videoBitrate,
        encoder: encoder(),
        ...hearing(doing),
      });
      const { size } = await stat(job.file);
      const now = new Date().toISOString();
      await files.trims.update(({ clips }) => {
        clips[basename(job.file)] = {
          name: clip.name,
          startMs: job.startMs,
          endMs: job.endMs,
          quality: job.quality,
          key,
          profile: m.profile,
          actualStart: made.actualStart,
          actualEnd: made.actualEnd,
          size,
          encoder: made.encoder,
          ...(made.fallback ? { fallback: made.fallback } : {}),
          madeAt: now,
          usedAt: now,
        };
      });
    });
  }

  // ---- preview copies ------------------------------------------------------------------------------------------------

  /** Each clip's preview copy, as asked for by name: `{ state, path, key, error }`. */
  async function previewStates(names) {
    const keyOf = await keys();
    const { clips } = await files.previews.read();
    const out = {};
    const used = [];
    for (const asked of names) {
      const stem = low(asked);
      const [recorded, record] = recordOf(clips, stem);
      const path = record && (await exists(record.file)) ? record.file : null;
      const there = { path, key: path ? record.key : null, error: null };
      const coming = previewJob(stem);
      if (coming) out[asked] = { state: coming, ...there };
      else if (path && record.key === keyOf(recorded, record.profile)) {
        out[asked] = { state: "ready", ...there };
        used.push(recorded);
      } else if (failed.has(stem)) out[asked] = { state: "failed", ...there, error: failed.get(stem).error };
      else {
        const away = (await locate(asked)) ? null : await elsewhere(asked);
        out[asked] = { state: path ? "stale" : "missing", ...there, error: away };
      }
    }
    if (used.length) await touch("previews", used);
    return out;
  }

  /** Queues preview copies of the clips named, unless one is current or coming already. Says how each stands. */
  async function askPreviews(names) {
    const keyOf = await keys();
    const { clips } = await files.previews.read();
    for (const asked of names) {
      const stem = low(asked);
      if (previewJob(stem)) continue;
      const clip = await locate(asked);
      if (!clip) continue;
      const [recorded, record] = recordOf(clips, stem);
      if (record && (await exists(record.file)) && record.key === keyOf(recorded, record.profile)) continue;
      failed.delete(stem);
      queue.previews.push({ kind: "preview", name: clip.name, stem });
    }
    pump();
    return previewStates(names);
  }

  /** A clip was graded: with autoRemake on, its preview copy is made again once the grade has been still a while. */
  async function regraded(names) {
    if (!autoRemake) return;
    const { clips } = await files.previews.read();
    for (const name of names) {
      const stem = low(name);
      if (!recordOf(clips, stem).length) continue;
      clearTimeout(timers.get(stem));
      const remake = () => {
        timers.delete(stem);
        askPreviews([name]).catch((e) => log(`couldn't remake the preview copy of ${name}: ${whyNot(e)}`));
      };
      timers.set(stem, setTimeout(remake, remakeAfter));
    }
  }

  // ---- trims -----------------------------------------------------------------------------------------------------------

  /**
   * Queues trims, `[{ name, start, end }]` in seconds of the original, made at `quality` (100 unless asked). A trim that's
   * been made with the grade its clip has now is reused, even once its clip has gone; one that's queued or being made is
   * shared. Says the batch's id and how each trim stands (trimStates).
   */
  async function askTrims(list, { quality = 100 } = {}) {
    if (!Array.isArray(list) || !list.length || list.length > 500)
      throw refuse("trims must be a list of 1 to 500 trims");
    const asked = list.map(trimAsked);
    const keyOf = await keys();
    const { clips } = await files.trims.read();
    const entries = [];
    for (const want of asked) {
      const wanted = { ...want, quality };
      const clip = await locate(want.name);
      if (!clip) {
        // Its original isn't here: a trim made of it, with the grade it has now, still does.
        const same = Object.entries(clips).find(
          ([, r]) =>
            low(r.name) === low(want.name) &&
            r.startMs === want.startMs &&
            r.endMs === want.endMs &&
            (r.quality ?? 100) === quality &&
            r.key === keyOf(r.name, r.profile),
        );
        const file = same && join(dirs.trims, same[0]);
        entries.push(
          file && (await exists(file)) ? { ...wanted, file } : { ...wanted, missing: await elsewhere(want.name) },
        );
        continue;
      }
      const key = keyOf(clip.name, (await meta(clip)).profile);
      const file = join(dirs.trims, trimName(clip.name, wanted, key));
      if (clips[basename(file)] && (await exists(file))) {
        entries.push({ ...wanted, file });
        continue;
      }
      let job = jobs().find((one) => one.kind === "trim" && one.file === file);
      if (!job) {
        job = { kind: "trim", name: clip.name, startMs: want.startMs, endMs: want.endMs, quality, key, file };
        queue.trims.push(job);
        const same = aboutTrim(job);
        failedTrims = failedTrims.filter(
          (f) => !(f.name === same.name && f.start === same.start && f.end === same.end),
        );
      }
      entries.push({ ...wanted, job });
    }
    const id = randomUUID().replaceAll("-", "").slice(0, 16);
    batches.set(id, entries);
    for (const old of [...batches.keys()].slice(0, Math.max(0, batches.size - BATCHES))) batches.delete(old);
    pump();
    return trimStates(id);
  }

  /** How a batch's trims stand, in the order asked: `{ name, start, end, state, path, actualStart, actualEnd, error }`. */
  async function trimStates(id) {
    const entries = batches.get(id);
    if (!entries) throw notFound("No such trims: they're forgotten when the grade app restarts, so ask for them again");
    const { clips } = await files.trims.read();
    const trims = [];
    const used = [];
    for (const entry of entries) {
      const { name, start, end, job } = entry;
      const file = job?.file ?? entry.file;
      const record = file && clips[basename(file)];
      const made = Boolean(record) && (await exists(file));
      let [state, error] = ["ready", null];
      if (entry.missing) [state, error] = ["missing", entry.missing];
      else if (job && current?.job === job) state = "making";
      else if (job && queue.trims.includes(job)) state = "queued";
      else if (job?.error) [state, error] = [job.missing ? "missing" : "failed", job.error];
      else if (!made) [state, error] = ["failed", "Its file has gone since: ask for it again"];
      if (state === "ready") used.push(basename(file));
      const at = state === "ready" ? { path: file, actualStart: record.actualStart, actualEnd: record.actualEnd } : {};
      trims.push({ name, start, end, state, path: null, actualStart: null, actualEnd: null, ...at, error });
    }
    if (used.length) await touch("trims", used);
    return { id, trims };
  }

  // ---- the rest -----------------------------------------------------------------------------------------------------

  return {
    previewStates,
    askPreviews,
    regraded,
    askTrims,
    trimStates,

    /** Loads the settings, clears what a server killed mid-file left, and lets go of what's long unused. */
    async start() {
      autoRemake = (await files.previews.read()).autoRemake === true;
      for (const dir of Object.values(dirs)) {
        await mkdir(dir, { recursive: true });
        for (const name of await readdir(dir))
          if (name.startsWith(".") && name.includes(".part")) await rm(join(dir, name), { force: true });
      }
      await sweep();
    },

    /** Whether preview copies are made again by themselves when their clip's grade changes; set when `on` is given. */
    async autoRemake(on) {
      if (on !== undefined) {
        if (typeof on !== "boolean") throw refuse("autoRemake must be true or false");
        await files.previews.update((data) => {
          data.autoRemake = on;
        });
        autoRemake = on;
      }
      return autoRemake;
    },

    /** Starts on the queues, unless an export is going. */
    pump,
    /** An export is coming: the one being made stops, and goes back to the head of its queue. */
    giveWay() {
      if (!current) return;
      current.gaveWay = true;
      current.stop.abort();
    },
    /** Whether a clip is queued or being made into either: it stays where it is meanwhile. */
    reading: (name) => jobs().some((job) => low(job.name) === low(name)),

    /** How the queues stand, for /api/jobs. */
    state() {
      const about = (job) => (job.kind === "trim" ? aboutTrim(job) : { name: job.name });
      const now = (kind) =>
        current?.job.kind === kind
          ? {
              ...about(current.job),
              progress: current.progress,
              ...(current.fallback ? { fallback: current.fallback } : {}),
            }
          : null;
      const waiting = exporting();
      return {
        previews: {
          current: now("preview"),
          queued: queue.previews.map(about),
          failed: [...failed.values()],
          waiting: waiting && queue.previews.length > 0,
          autoRemake,
        },
        trims: {
          current: now("trim"),
          queued: queue.trims.map(about),
          failed: failedTrims,
          waiting: waiting && queue.trims.length > 0,
        },
      };
    },

    /** What the one being made has still to write, as bring.mjs counts others' claims. */
    claim() {
      if (!current?.bytes) return null;
      return {
        by: current.job.kind === "trim" ? "a trim" : "a preview copy",
        bytes: current.bytes * (1 - current.progress),
      };
    },
  };
}
