// Bring to Mac: the offload's other way round. What the site's archive holds of the shoot days that this Mac doesn't,
// read from the days' manifests (`_originals-<day>`, each clip as `assets/<file>`), and clips brought back from there to
// Movies/Original. Only originals come back: graded copies are made again from them.
//
// The archive is only read, and nothing on this Mac is written over or deleted: a clip is streamed to a hidden `.part`
// beside where it goes, hashed as it comes, and takes its name only once it's the clip its manifest lists, if no other
// file has that name by then. Clips come one at a time.
import { createHash } from "node:crypto";
import { link, mkdir, open, readdir, rm, stat, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import { stemOf } from "./ledger.mjs";
import { VIDEO } from "./media.mjs";
import { hashFile } from "./offload.mjs";

const PROJECT = /^_originals-(\d{4}-\d{2}-\d{2})$/;
/** The archive's list and a day's manifest are small: one that can't be reached is said so in a minute. */
const READ_TIMEOUT = 60_000;
const PART = ".bring.part";

const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
const sum = (clips) => clips.reduce((total, clip) => total + clip.size, 0);
/** What went wrong: "fetch failed" says no more than that, but its cause does. */
const reason = (error) => (error.cause?.code ? `${error.message} (${error.cause.code})` : error.message);
const keyOf = ({ name }) => name.toLowerCase();
export const cloudId = (day) => `cloud:${day}`;

/** A clip's own trouble: the next one is still tried. Anything else (no archive, no room) ends the run. */
class ClipError extends Error {}
class RoomError extends Error {
  status = 409;
}
/** Something was asked for that isn't there. */
class AskError extends Error {
  status = 400;
}

// ---- what the archive holds ---------------------------------------------------------------------------------------

/** A manifest's clips. Its names end up as files on this Mac: only a video's plain name will do. */
function clipsOf(day, files) {
  return files.flatMap(({ path, sha256, size, mtime }) => {
    const name = /^assets\/([^/\\]+)$/.exec(path)?.[1];
    const plain = name && VIDEO.test(name) && !name.startsWith(".") && !name.includes("\0");
    const known = /^[0-9a-f]{64}$/.test(sha256) && Number.isSafeInteger(size) && Number.isFinite(mtime);
    return plain && known ? [{ day, name, size, sha256, mtime }] : [];
  });
}
const transcriptsOf = (files) => files.flatMap(({ path }) => /^transcripts\/([^/]+)\.vtt$/.exec(path)?.[1] ?? []);

/**
 * The shoot days in the archive. `read(request)` says every clip there, `{ day, name, size, sha256, mtime, transcript }`,
 * with when it was read and, if it can't be read now, why (the clips are then as last read). A day's manifest is read
 * once each time it's archived, and the list of days kept for `every` ms unless `refresh` asks again; an archive that
 * couldn't be read is left alone for a minute.
 */
export function archiveDays({ every = 10 * 60_000, patience = 60_000 } = {}) {
  const manifests = new Map();
  let listed = [];
  let readAt = null;
  let triedAt = Number.NEGATIVE_INFINITY;
  let error = null;
  let reading = null;

  async function readAll(request) {
    const { projects } = await request("projects", { timeout: READ_TIMEOUT });
    const names = [];
    for (const { name, archivedAt } of projects) {
      const day = PROJECT.exec(name)?.[1];
      if (!day) continue;
      names.push(name);
      if (manifests.get(name)?.archivedAt === archivedAt) continue;
      const at = `projects/${encodeURIComponent(name)}?at=${encodeURIComponent(archivedAt)}`;
      const { files } = await request(at, { timeout: READ_TIMEOUT });
      manifests.set(name, { archivedAt, day, clips: clipsOf(day, files), transcripts: transcriptsOf(files) });
    }
    listed = names;
    readAt = new Date().toISOString();
  }

  async function read(request) {
    try {
      await readAll(request);
      error = null;
    } catch (e) {
      error = `Couldn't read the Cloudflare archive: ${reason(e)}`;
    }
    triedAt = Date.now();
    reading = null;
  }

  return {
    async read(request, { refresh = false } = {}) {
      const old = Date.now() - triedAt > (error ? patience : every);
      if (refresh || old || reading) {
        reading ??= read(request);
        await reading;
      }
      const held = listed.map((name) => manifests.get(name));
      const transcribed = new Set(held.flatMap(({ day, transcripts }) => transcripts.map((stem) => `${day}/${stem}`)));
      const clips = held.flatMap((project) =>
        project.clips.map((clip) => ({ ...clip, transcript: transcribed.has(`${clip.day}/${stemOf(clip.name)}`) })),
      );
      return { clips, readAt, error };
    },
  };
}

/** A folder's files by name, any case: to the Mac's disk `A.MP4` and `a.mp4` are one name. */
async function namesIn(dir) {
  const names = await readdir(dir).catch(() => []);
  return new Map(names.map((name) => [name.toLowerCase(), name]));
}

/**
 * Those clips, each with whether its copy is in `dir`: `here` is "yes", "no", or "different" when another file has its
 * name. Told by name and size; bringing one checks its bytes.
 */
export async function withHere(clips, dir) {
  const names = await namesIn(dir);
  const here = async ({ name, size }) => {
    const found = names.get(name.toLowerCase());
    if (!found) return "no";
    const info = await stat(join(dir, found)).catch(() => null);
    return info?.isFile() && info.size === size ? "yes" : "different";
  };
  return Promise.all(clips.map(async (clip) => ({ ...clip, here: await here(clip) })));
}

const weigh = (clips) => ({ clips: clips.length, bytes: sum(clips) });

/** The days among those clips (withHere's), newest first: how much of each is in the archive, and not on this Mac. */
export function summarise(clips) {
  const days = [...Map.groupBy(clips, (clip) => clip.day)].sort(([a], [b]) => b.localeCompare(a));
  return days.map(([day, all]) => ({
    id: cloudId(day),
    day,
    ...weigh(all),
    missing: weigh(all.filter((clip) => clip.here === "no")),
  }));
}

/**
 * A day's clips, each by its name without extension (`stem`). IMG_0001.MOV and IMG_0001.MP4 are two clips: the second
 * goes by its whole name.
 */
export function dayClips(clips, day) {
  const rows = new Map();
  for (const clip of clips) {
    if (clip.day !== day) continue;
    const { name, size, sha256, here, transcript } = clip;
    const stem = rows.has(stemOf(name).toLowerCase()) ? name : stemOf(name);
    rows.set(stem.toLowerCase(), { stem, name, size, sha256, here, transcript });
  }
  return [...rows.values()].sort((a, b) => a.stem.localeCompare(b.stem));
}

/**
 * The clips a request asks for: a day's that aren't on this Mac, or those named (of `day`, when two days share a name).
 * Throws, saying why, when one isn't in the archive. Only originals come back: a request for anything else is refused.
 */
export function pickClips(clips, { what = "original", names = null, day = null }) {
  if (what !== "original") throw new AskError("Only originals come back from Cloudflare");
  const ofDay = clips.filter((clip) => day === null || clip.day === day);
  if (names === null && day !== null)
    return ofDay.filter((clip) => clip.here === "no").sort((a, b) => a.name.localeCompare(b.name));
  if (!Array.isArray(names) || !names.length) throw new AskError("Name the clips to bring, or their day");
  return [...new Set(names)].map((name) => {
    const found = ofDay.filter((clip) => clip.name === name);
    if (!found.length) throw new AskError(`${name} isn't in the archive`);
    if (new Set(found.map((clip) => clip.sha256)).size > 1) throw new AskError(`Two days have a ${name}: say which`);
    return found[0];
  });
}

// ---- bringing clips back ------------------------------------------------------------------------------------------

/** Streams a clip from the archive into a file of its own. Throws when it isn't the clip its manifest lists. */
async function fetchClip(request, clip, path, { signal, onBytes }) {
  // A few GB on a slow line outlasts a request's usual ten minutes: allow down to 50 KB/s.
  const timeout = Math.min(2 ** 31 - 1, Math.max(10 * 60_000, Math.ceil(clip.size / 50)));
  const response = await request(`blobs/${clip.sha256}`, { raw: true, signal, timeout }).catch((error) => {
    const lost = /Not in the archive/.test(error.message);
    throw lost ? new ClipError(`${clip.name} isn't in the archive any more`) : error;
  });
  const hash = createHash("sha256");
  let got = 0;
  const file = await open(path, "w");
  try {
    for await (const chunk of response.body) {
      got += chunk.length;
      if (got > clip.size) throw new ClipError(`${clip.name} came back longer than the ${clip.size} bytes listed`);
      hash.update(chunk);
      await file.appendFile(chunk);
      onBytes(chunk.length);
    }
    await file.sync();
  } finally {
    await file.close();
  }
  if (got !== clip.size) throw new ClipError(`${clip.name} came back ${got} bytes long, not ${clip.size}`);
  if (hash.digest("hex") !== clip.sha256)
    throw new ClipError(`${clip.name} came back different from what was archived`);
}

/**
 * Brings one clip into `dir`. Says "landed", or "skipped" when that very clip is there already; throws, leaving nothing of
 * it behind, when another file has its name, what comes isn't what its manifest lists, or `signal` cuts it short.
 * `ready` is called before anything is fetched, and can refuse by throwing; `placing(clip)` before it takes its name, so
 * that it's kept out of any offload going on by the time there's a file to take, and can say how to undo that.
 */
export async function bringClip(
  request,
  clip,
  dir,
  { signal, onBytes = () => {}, ready = async () => {}, placing = async () => {} } = {},
) {
  await mkdir(dir, { recursive: true });
  const taken = (await namesIn(dir)).get(clip.name.toLowerCase());
  const another = () => new ClipError(`Another file is already ${basename(dir)}/${taken ?? clip.name}`);
  if (taken) {
    const path = join(dir, taken);
    const info = await stat(path).catch(() => null);
    const same = info?.isFile() && info.size === clip.size && (await hashFile(path, signal)) === clip.sha256;
    if (!same) throw another();
    await placing(clip);
    return "skipped";
  }
  await ready();
  const partial = join(dir, `.${clip.name}${PART}`);
  try {
    await fetchClip(request, clip, partial, { signal, onBytes });
    const when = new Date(clip.mtime);
    await utimes(partial, when, when);
    const undo = await placing(clip);
    // A rename would write over a file put there meanwhile (an export, a clip off the card). A link won't.
    await link(partial, join(dir, clip.name)).catch(async (error) => {
      await undo?.();
      throw error.code === "EEXIST" ? another() : error;
    });
    return "landed";
  } finally {
    await rm(partial, { force: true });
  }
}

/** Removes what a server killed mid-clip left behind. */
export async function clearParts(dirs) {
  for (const dir of dirs)
    for (const name of await readdir(dir).catch(() => []))
      if (name.startsWith(".") && name.endsWith(PART)) await rm(join(dir, name), { force: true });
}

/**
 * Brings clips back into `dir`, one at a time, in the order they're added. `room()` says how many bytes are free there,
 * of which `keepFree` stay so; `claims()` says what else is being written there and how much of it is still to come,
 * `[{ by, bytes }]`: a clip comes only while there's room for both, looked at again every `every` ms.
 * `landed(clip)` hears each one, and `placing(clip)` each before it takes its name (bringClip). `pausedAll()` says why
 * the next clip waits, if it does (paused from the Footage tab), which `state().paused` says too.
 *
 * Says `{ add, stop, state, settled }`: `add(request, clips)` refuses, by throwing, what there's no room for, `stop()` ends
 * the run and keeps what's landed, `state()` says how far it is, `settled()` when it has ended.
 */
export function bringer({
  dir,
  room,
  keepFree = 5e9,
  claims = async () => [],
  placing = async () => {},
  landed = () => {},
  pausedAll = () => null,
  every = 5000,
}) {
  /** Why the next clip waits, while it does: everything paused from the Footage tab (pause.mjs). */
  let holding = null;
  const blank = () => ({
    total: 0,
    bytes: 0,
    landed: 0,
    skipped: 0,
    doneBytes: 0,
    failed: [],
    finished: null,
    error: null,
  });
  let run = blank();
  /** Clips landed in all the runs so far. */
  let arrived = 0;
  let queue = [];
  let current = null;
  let cut = null;
  let stopped = false;
  let running = null;
  /** The last clips asked for: each asking waits for the one before it. */
  let adding = Promise.resolve();
  /** Bytes come so far in the run; and how many had by when, [time, bytes] over the last minute, for the speed. */
  let came = 0;
  let samples = [];

  /** Why there's no room for that many more bytes; null when there is. */
  async function short(bytes) {
    if (!bytes) return null;
    const others = (await claims()).filter((claim) => claim.bytes > 0);
    const free = await room();
    const spoken = others.reduce((total, claim) => total + claim.bytes, 0);
    if (free - bytes - spoken >= keepFree) return null;
    const why = others.map((claim) => `, and ${gb(claim.bytes)} still to come from ${claim.by}`).join("");
    return `No room on this Mac: ${gb(bytes)} to bring, ${gb(free)} free, ${gb(keepFree)} of it kept free${why}`;
  }
  async function needRoom(bytes) {
    const why = await short(bytes);
    if (why) throw new RoomError(why);
  }
  /** What a clip takes: nothing when a file has its name already, as it's then skipped or refused. */
  const takes = ({ here = "no", size }) => (here === "no" ? size : 0);

  function onBytes(bytes) {
    const now = Date.now();
    if (!samples.length || now - samples.at(-1)[0] > 500) samples.push([now, came]);
    came += bytes;
    current.got += bytes;
  }
  /** Bytes a second, once there's a second to go by. One that stalls slows down, and then has none. */
  function speed() {
    const now = Date.now();
    while (samples.length && now - samples[0][0] > 60_000) samples.shift();
    const [since, had] = samples[0] ?? [now, came];
    return running && now - since >= 1000 ? ((came - had) / (now - since)) * 1000 : null;
  }

  async function bringNext({ request, clip }) {
    const going = { ...clip, got: 0 };
    const cutting = new AbortController();
    current = going;
    cut = cutting;
    // When room runs short mid-clip, as something else starts writing, the clip gives way.
    let gaveWay = null;
    let watch = null;
    const look = async () => {
      const why = await short(clip.size - going.got).catch(() => null);
      if (!why || cutting.signal.aborted) return;
      gaveWay = why;
      cutting.abort();
    };
    const ready = async () => {
      await needRoom(clip.size);
      watch = setInterval(look, every);
    };
    try {
      const options = { signal: cutting.signal, onBytes, ready, placing };
      const how = await bringClip(request, clip, dir, options);
      run[how]++;
      run.doneBytes += clip.size;
      if (how === "landed") {
        arrived++;
        landed(clip);
      }
    } catch (error) {
      if (error instanceof ClipError) {
        run.failed.push({ day: clip.day, name: clip.name, why: error.message });
        run.doneBytes += clip.size;
        return;
      }
      queue = [];
      if (stopped) return;
      if (gaveWay) run.error = gaveWay;
      else if (error instanceof RoomError) run.error = error.message;
      else run.error = `${clip.name} didn't come: ${reason(error)}`;
    } finally {
      clearInterval(watch);
      current = null;
    }
  }

  /** Paused from the Footage tab, the clip coming is finished and the next waits, till it goes on or the run stops. */
  async function whileHeld() {
    for (;;) {
      holding = stopped ? null : pausedAll();
      if (!holding) return;
      await new Promise((resolve) => setTimeout(resolve, every / 5));
    }
  }

  async function runAll() {
    while (queue.length) {
      await whileHeld();
      if (!queue.length) break;
      await bringNext(queue.shift());
    }
    if (!run.error) run.finished = stopped ? "stopped" : "done";
    running = null;
  }

  async function add(request, clips) {
    // A run being stopped ends first.
    if (stopped) await running;
    const queued = queue.map(({ clip }) => clip);
    const known = new Set([...queued, current].filter(Boolean).map(keyOf));
    const fresh = clips.filter((clip) => !known.has(keyOf(clip)));
    if (!fresh.length) return 0;
    const coming = current ? current.size - current.got : 0;
    await needRoom([...queued, ...fresh].reduce((total, clip) => total + takes(clip), coming));
    if (!running) {
      run = blank();
      came = 0;
      samples = [];
      stopped = false;
    }
    queue.push(...fresh.map((clip) => ({ request, clip })));
    run.total += fresh.length;
    run.bytes += sum(fresh);
    running ??= runAll();
    return fresh.length;
  }

  return {
    add(request, clips) {
      const asked = adding.then(() => add(request, clips));
      adding = asked.catch(() => {});
      return asked;
    },

    stop() {
      if (!running) return false;
      stopped = true;
      queue = [];
      cut?.abort();
      return true;
    },

    settled: async () => running,

    state() {
      const about = ({ day, name, size }) => ({ day, name, size });
      return {
        ...run,
        arrived,
        running: Boolean(running),
        current: current && { ...about(current), got: current.got },
        queued: queue.map(({ clip }) => about(clip)),
        gotBytes: run.doneBytes + (current?.got ?? 0),
        speed: speed(),
        paused: holding,
      };
    },
  };
}
