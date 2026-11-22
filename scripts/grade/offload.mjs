// Offloading frees the camera's card fast and the Mac after it, by three switches (lane.mjs), each on or off whatever the
// others are:
//
//   Camera → Mac          each clip is copied off the card to Movies/Original (hashed as it's read, then read back on the
//                         Mac and checked against that), a clip at a time while the Mac has room for the next with
//                         `keepFree` to spare, and deleted from the card with its .LRF: once it's on the Mac, or only
//                         once Cloudflare has it.
//   Mac → Cloudflare      each clip in Movies/Original goes to the site's archive under its SHA-256, `together` at a time,
//                         and is deleted from the Mac once it's checked there (read back, unless R2 checked it whole).
//   Exports → Cloudflare  the same for the graded copies in Movies/Exported.
//
// Each switch deletes only what it takes from: the card's clips only Camera → Mac, the Mac's only the other two. With the
// first two on, each clip gone from the Mac makes room for the next off the card.
//
// Each shoot day is a manifest of its own in the archive, `_originals-<day>`, holding its clips as `assets/<file>`, saved
// again after every clip so a clip is safe the moment it's in; its graded copies are `_graded-<day>`. The ledger counts an
// archived file the original's size as the original in Cloudflare; the leading `_` keeps these out of the films.
// `bun run publisher restore _originals-<day>` brings a day back.
//
// Each clip's sound is taken before its Mac copy goes, to be transcribed meanwhile or later (transcripts.mjs). A
// transcript is filed beside its clip, as `transcripts/<clip>.vtt` and `.json`, while Mac → Cloudflare is on, and never
// stops it.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, statSync, unlinkSync } from "node:fs";
import { readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readRange } from "../publisher/archive.mjs";
import { makeLane, RETRY } from "./lane.mjs";

/** Each request carries this much of a clip: on a slow uplink one still lands well inside a request's ten minutes. */
export const OFFLOAD_PART = 16 * 1024 * 1024;

export const LANES = ["copy", "send", "exports"];
export const originalsName = (day) => `_originals-${day}`;
export const gradedName = (day) => `_graded-${day}`;
const clipPath = (name) => `assets/${name}`;
const lrfOf = (path) => path.replace(/\.mp4$/i, ".LRF");
const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
const statOf = (path) => stat(path).catch(() => null);

export async function hashFile(abs, signal = null, onBytes = () => {}) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(abs, { highWaterMark: 8 << 20, ...(signal ? { signal } : {}) })) {
    hash.update(chunk);
    onBytes(chunk.length);
  }
  return hash.digest("hex");
}

/** An error trying again wouldn't help. */
const final = (message) => Object.assign(new Error(message), { final: true });

/** A file that's in the way of a clip's copy: the clip's SHA-256 if that's what it is already, and it's never replaced. */
async function alreadyThere(clip, target, size, { signal, onBytes }) {
  const sha256 = size === clip.size ? await hashFile(clip.path, signal, onBytes) : null;
  if (sha256 && sha256 === (await hashFile(target, signal))) return sha256;
  throw final(`${clip.name} is on this Mac already and isn't the card's: both stay where they are`);
}

/**
 * Copies a card clip into `dir` under its own name and time, hashing it as it's read, then reads the copy back and
 * checks it against that. Says its SHA-256. A copy cut short leaves nothing behind; a clip that's there already is only
 * checked, and one of its name that isn't it stays as it is.
 */
export async function copyClip(clip, dir, { signal = null, onBytes = () => {} } = {}) {
  const target = join(dir, clip.name);
  const partial = join(dir, `.${clip.name}.part`);
  const there = await statOf(target);
  if (there) return alreadyThere(clip, target, there.size, { signal, onBytes });
  const hash = createHash("sha256");
  const hashing = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk);
      onBytes(chunk.length);
      done(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(clip.path, { highWaterMark: 8 << 20 }),
      hashing,
      createWriteStream(partial),
      ...(signal ? [{ signal }] : []),
    );
    const sha256 = hash.digest("hex");
    const { size } = await stat(partial);
    if (size !== clip.size) throw new Error(`${clip.name} came off the card ${size} bytes long, not ${clip.size}`);
    if ((await hashFile(partial, signal)) !== sha256)
      throw new Error(`${clip.name}'s copy on this Mac doesn't match the card`);
    const when = new Date(clip.mtime);
    await utimes(partial, when, when);
    if (await statOf(target)) throw new Error(`${clip.name} turned up on this Mac while it was being copied`);
    await rename(partial, target);
    return sha256;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/**
 * Sends one file to the archive under its hash: whole up to `part`, else a part at a time. `ready()` is waited for before
 * anything goes up, each part too; `onBytes` hears each request's bytes land; aborting `signal` stops the request in
 * flight and gives the part-sent file up. A file sent in parts is put together only if what went up is what `hash` says:
 * R2 checks that of one sent whole.
 */
export async function sendBlob(
  request,
  { abs, size },
  hash,
  { part = OFFLOAD_PART, signal = null, ready = async () => {}, onBytes = () => {} } = {},
) {
  await ready();
  if (size <= part) {
    await request(`blobs/${hash}`, { method: "PUT", body: await readRange(abs, 0, size), signal });
    onBytes(size);
    return;
  }
  const { upload } = await request("uploads", { method: "POST", json: { blob: hash }, signal });
  const query = `upload=${encodeURIComponent(upload)}`;
  const parts = [];
  const sent = createHash("sha256");
  try {
    for (let offset = 0, n = 1; offset < size; offset += part, n++) {
      await ready();
      const length = Math.min(part, size - offset);
      const body = await readRange(abs, offset, length);
      sent.update(body);
      parts.push(await request(`uploads/${hash}/${n}?${query}`, { method: "PUT", body, signal }));
      onBytes(length);
    }
    if (sent.digest("hex") !== hash) throw new Error(`${abs} changed while it was being sent`);
    await request(`uploads/${hash}/complete`, { method: "POST", json: { upload, parts }, signal });
  } catch (error) {
    await request(`uploads/${hash}?${query}`, { method: "DELETE", timeout: 30_000 }).catch(() => {});
    throw error;
  }
}

/**
 * Whether the archive's file under `hash` reads back as exactly that. R2 checks a file sent whole against its hash, but
 * not one sent in parts, and the pipeline deletes the last copy on the strength of it.
 */
async function readsBack(request, hash, size, signal) {
  // A few GB on a slow line outlasts a request's usual ten minutes: allow down to 50 KB/s.
  const timeout = Math.max(10 * 60_000, Math.ceil(size / 50));
  const response = await request(`blobs/${hash}`, { raw: true, signal, timeout });
  const read = createHash("sha256");
  try {
    for await (const chunk of response.body) read.update(chunk);
  } catch (error) {
    throw reaching(error);
  }
  return read.digest("hex") === hash;
}

/** Which of `hashes` the archive holds. */
async function held(request, hashes, signal) {
  const missing = new Set();
  for (let i = 0; i < hashes.length; i += 1000) {
    const answer = await request("missing", { method: "POST", json: { blobs: hashes.slice(i, i + 1000) }, signal });
    for (const hash of answer.missing) missing.add(hash);
  }
  return new Set(hashes.filter((hash) => !missing.has(hash)));
}

/** A project's manifest as last archived: its files by path, or none yet. */
async function projectFiles(request, project, signal) {
  try {
    const manifest = await request(`projects/${project}`, { signal });
    return new Map(manifest.files.map((file) => [file.path, file]));
  } catch (error) {
    if (/No such archived project/.test(error.message)) return new Map();
    throw error;
  }
}

/** Refuses a file that would take the place of another in a manifest, unless it's larger: part of a clip isn't the clip. */
function mayReplace(held, { path, sha256, size }) {
  const was = held.get(path);
  if (was && was.sha256 !== sha256 && was.size >= size)
    throw final(`Another ${path.split("/").pop()}, no smaller, is in Cloudflare already: this one stays where it is`);
}

/** Files in a project's manifest all it holds and these, until the manifest reads back with them. */
async function saveProject(request, project, files, signal) {
  for (let saves = 0; ; saves++) {
    const held = await projectFiles(request, project, signal);
    const filing = files.filter(({ beside }) => !beside || held.has(beside));
    for (const file of filing) if (file.lasting) mayReplace(held, file);
    const listed = ({ path, sha256, size }) => held.get(path)?.sha256 === sha256 && held.get(path).size === size;
    if (filing.every(listed)) return filing.map(({ path }) => path);
    if (saves === 3) throw new Error(`${project} doesn't list what was filed in it`);
    for (const { path, sha256, size, mtime, lasting } of filing) {
      const was = held.get(path);
      // What a larger one takes the place of stays listed, out of the way.
      const aside = was && `replaced/${was.sha256.slice(0, 12)}/${path.split("/").pop()}`;
      if (lasting && was && was.sha256 !== sha256) held.set(aside, { ...was, path: aside });
      held.set(path, { path, sha256, size, mtime });
    }
    await request(`projects/${project}`, { method: "PUT", json: { files: [...held.values()], folders: [] }, signal });
  }
}

/**
 * Files into the shoot days' manifests. A manifest is saved whole, so every save of a day's, whichever run or transcript
 * asks for it, waits for the one before it and keeps all the day has in the archive by then. It's done once the manifest
 * reads back with what was filed: the archive dates a manifest by a Worker's clock, so one saved after another can come
 * out the earlier of the two.
 *
 * `fileInDay(request, day, files, signal)` takes `{ path, sha256, size, mtime }`, and with `beside` files one only if the
 * day holds that path, and with `lasting` only if it's not over another that's no smaller. It says the paths filed.
 * `project` is the day's originals unless it's said.
 */
export function dayManifests() {
  const turns = new Map();
  return function fileInDay(request, day, files, signal = null, project = originalsName(day)) {
    const save = (turns.get(project) ?? Promise.resolve()).then(() => saveProject(request, project, files, signal));
    turns.set(
      project,
      save.catch(() => {}),
    );
    return save;
  };
}

/** Marks an error as one of getting to the site and back, not the clip's own. */
const reaching = (error) => Object.assign(error, { reaching: true });
/** Refusals that have nothing to do with the file: the pairing, or a site that has had enough. */
const REFUSALS = new Set([401, 403, 408, 425, 429]);
/** Whether an error is the network's or the site's, so every clip would meet it. */
const onTheWay = ({ reaching, status }) =>
  Boolean(reaching) && (status === undefined || status >= 500 || REFUSALS.has(status));

/** No transcripts: an offload of clips alone. */
const NO_TRANSCRIPTS = { take: async () => {}, ready: async () => [], sent: async () => {} };
/** No exports: an offload of originals alone. */
const NO_RECORDS = { read: async () => ({}), add: async () => {}, drop: async () => {} };

const UNPLUGGED = "The camera isn't plugged in";
const WAITS_FOR_CLOUDFLARE = "Clips stay on the camera until they're in Cloudflare";
const sum = (clips) => clips.reduce((total, clip) => total + clip.size, 0);
/** A file as it was listed: one written since is another. */
const idOf = ({ name, size, mtime }) => `${name}/${size}/${mtime}`;
const isAsListed = (now, { size, mtime }) => Boolean(now) && now.size === size && Math.round(now.mtimeMs) === mtime;
const unchanged = async (clip) => isAsListed(await statOf(clip.path), clip);
/** Calls of `work` made one after another. */
function inTurn(work) {
  let last = Promise.resolve();
  return (...given) => {
    const mine = last.then(() => work(...given));
    last = mine.catch(() => {});
    return mine;
  };
}

/**
 * Starts offloading, with the switches `lanes` on. What there is to take is listed as it goes: `camera({ fresh })` says the
 * card's clips, or null while it's unplugged (`fresh`: not from a listing a few seconds old); `mac()` Movies/Original's;
 * `exports()` Movies/Exported's. Each clip is `{ name, path, size, mtime, day }`, oldest first, with `settles` the time
 * until which it may still be being written. `dir` is Movies/Original; `room()` says how many bytes are free there.
 *
 * `records` (`graded` for the exports) keeps what went to the archive: `read()` says name → `{ sha256, size, card }`, and
 * `add(clip, sha256, { card })` is done once it's on disk, as `drop(sha256)` is, which forgets a hash. A clip there that
 * the archive still holds is only deleted. `card` is the time the card's file had when the hash was read off it.
 *
 * Nothing is deleted that's kept or in use: `keeping()` says which clips are kept out of all this (`(clip) => boolean`),
 * asked again at each deletion, and one `removable(clip)` says no to (being exported, say) stays where it is.
 *
 * `paused()` says why uploads wait, if they do: they wait between parts. `clearCardAfter()` says when a clip goes from the
 * card, "copied" to the Mac or "sent" to the archive. `copied(clip)` hears each clip on the Mac, `removed(clip, where)`
 * each one deleted. `fileInDay` is the days' manifests: the one `dayManifests()` for every run.
 *
 * `transcripts` is what the transcriber does: `take(clip, signal)` takes a clip's sound from its Mac copy, which waits for
 * it; `ready()` says the transcripts to send, each `{ key, name, day, files: [{ path, abs, mtime }] }`; `sent(keys)` hears
 * the ones filed.
 *
 * Says `{ state, start, stop, poke, done }`: `state` is read as it goes; `start(lane)` turns another switch on while the
 * run goes; `stop(lanes, { now })` turns them off (lane.mjs); `poke()` says something may have changed, like a transcript
 * made or a page opened; `done` settles once every switch is off.
 */
export function startOffload({
  lanes: wanted = ["copy", "send"],
  camera = async () => null,
  mac = async () => [],
  exports = async () => [],
  records = NO_RECORDS,
  graded = NO_RECORDS,
  dir,
  request,
  room,
  keepFree = 5e9,
  removable = () => true,
  keeping = async () => () => false,
  paused = () => null,
  clearCardAfter = () => "copied",
  part = OFFLOAD_PART,
  together = 2,
  copied: onCopied = () => {},
  removed = () => {},
  fileInDay = dayManifests(),
  transcripts = NO_TRANSCRIPTS,
  retry = RETRY,
  look = 10_000,
  log = () => {},
}) {
  const ask = async (...asked) => {
    try {
      return await request(...asked);
    } catch (error) {
      throw reaching(error);
    }
  };
  const lanes = {
    /** Off the card onto the Mac. `onCamera`: clips staying on the card until they're in the archive. */
    copy: makeLane({ current: null, onCamera: 0 }, { retry, log }),
    /** Up to the archive: what's on the Mac, and what Camera → Mac brings while it's on. */
    send: makeLane({ current: [] }, { retry, log }),
    exports: makeLane({ current: [] }, { retry, log }),
  };
  const { copy, send } = lanes;
  const state = {
    running: true,
    copy: copy.state,
    send: send.state,
    exports: lanes.exports.state,
    /** Transcripts filed, and why one couldn't be: it waits for the next run. */
    transcripts: { sent: 0, error: null },
    /** Set while the next clip off the card waits for room on the Mac. */
    get waiting() {
      return copy.state.waiting?.for === "room" ? "room" : null;
    },
    /** Why uploads wait, while they do. */
    get paused() {
      const held = [send, lanes.exports].find((lane) => lane.state.waiting?.for === "page");
      return held?.state.waiting ?? null;
    },
    /** Bytes sent to the archive: [time, total] over the last minute or so, for the speed. */
    sent: 0,
    samples: [],
    /** Bytes deleted from the card, from Movies/Original and from Movies/Exported. */
    freed: { camera: 0, mac: 0, exports: 0 },
    finished: null,
    error: null,
  };

  // Every stage waits on the others: a clip off the card for the senders, room on the Mac for the copy.
  const waiters = new Set();
  const notify = () => {
    for (const wake of [...waiters]) wake();
  };
  const change = (ms) =>
    new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      waiters.add(wake);
    });

  const sentBytes = (n) => {
    state.sent += n;
    const now = Date.now();
    state.samples.push([now, state.sent]);
    while (state.samples.length > 2 && now - state.samples[0][0] > 60_000) state.samples.shift();
  };

  /** Whether a clip may go: not one that's kept or in use. */
  const mayGo = async (clip) => !(await keeping())(clip) && (await removable(clip));
  /** Looked at and deleted in one go, so nothing here can write to it in between. */
  function removeAtOnce(clip) {
    if (!isAsListed(statSync(clip.path, { throwIfNoEntry: false }), clip)) return false;
    unlinkSync(clip.path);
    return true;
  }
  async function removeFromCard(clip) {
    // Looked at without waiting on it first: a camera that's going might take its time to answer.
    if (!(await unchanged(clip)) || !removeAtOnce(clip)) return false;
    await rm(lrfOf(clip.path), { force: true });
    return true;
  }
  /** Deletes a clip, unless it's to stay or was written to since it was listed. */
  async function remove(clip, where) {
    if (!(await mayGo(clip))) return;
    const gone = where === "camera" ? await removeFromCard(clip) : removeAtOnce(clip);
    if (!gone) return;
    state.freed[where] += clip.size;
    removed(clip, where);
    notify();
  }

  /** The cheapest request there is, to tell whether the site can be reached. */
  const reachSite = (lane) => () =>
    ask("missing", { method: "POST", json: { blobs: [] }, signal: lane.signal, timeout: 60_000 });
  /** Waits out what stopped a lane. Says whether it was an outage. */
  const recover = (lane, error) =>
    onTheWay(error) ? lane.recover("network", error, reachSite(lane)) : lane.recover("trouble", error, async () => {});

  /** The clips this run read off the card: name → the file's id and time there, and its SHA-256. */
  const offCard = new Map();
  /** The card's files (by id) whose copy on the Mac this run made, or checked against them: the copy, as it was then. */
  const copied = new Map();
  /** The clips this run put in the archive, or found there: name → SHA-256. */
  const landed = new Map();

  // ---- the sound of each clip, taken one at a time, as soon as it's on the Mac so it's transcribed while it goes up ----

  const sounds = new Map();
  const takeInTurn = inTurn(async (clip, signal) => {
    if (signal.aborted) return false;
    await transcripts.take(clip, signal).catch(() => {});
    return !signal.aborted;
  });
  /**
   * Takes a clip's sound. Says whether its Mac copy may go: not if this was cut short, but a sound that can't be taken
   * keeps no clip here.
   */
  function takeSound(clip, { signal }) {
    const key = idOf(clip);
    if (!sounds.has(key)) {
      const taking = takeInTurn(clip, signal);
      sounds.set(key, taking);
      void taking.then((taken) => taken || sounds.delete(key));
    }
    return sounds.get(key);
  }

  // ---- Camera → Mac ------------------------------------------------------------------------------------------------

  /** The card's clips left to copy, as last seen, and whether there are any or it isn't known yet. */
  let cardLeft = [];
  let bringing = true;
  /** Clips whose record says they're in the archive, and aren't: copied and sent again. */
  const strange = new Set();
  /** Hashes the archive was asked for and holds; and when it may be asked again, after it couldn't be. */
  const holds = new Set();
  let askAt = 0;

  function totals() {
    const { done, doneBytes } = copy.state;
    Object.assign(copy.state, { total: done + cardLeft.length, bytes: doneBytes + sum(cardLeft) });
    for (const source of [originals, gradedCopies]) {
      const { state: s } = source.lane;
      if (!s.on) continue;
      const coming = source === originals && copy.state.on ? [...source.left, ...cardLeft] : source.left;
      Object.assign(s, { total: s.done + coming.length, bytes: s.doneBytes + sum(coming) });
    }
  }

  /** A clip's SHA-256 as this run read it off the card, if the card's file is still that one. */
  function readOffCard(clip) {
    const mine = offCard.get(clip.name);
    return mine?.id === idOf(clip) ? mine.sha256 : null;
  }
  /** Whether the Mac still has the copy this run checked against a clip on the card. */
  async function copiedStill(clip) {
    const copy = copied.get(idOf(clip));
    return Boolean(copy) && unchanged(copy);
  }

  /** Whether the card's file is what's in the archive under `known`'s hash, read off the card if nothing else says so. */
  async function isTheSame(clip, known) {
    const mine = readOffCard(clip);
    if (mine) return mine === known.sha256;
    if (known.card === clip.mtime) return true;
    const going = { name: clip.name, sent: 0, size: clip.size, checking: true };
    copy.state.current = going;
    try {
      const sha256 = await hashFile(clip.path, copy.signal, (n) => {
        going.sent += n;
      });
      offCard.set(clip.name, { id: idOf(clip), mtime: clip.mtime, sha256 });
      return sha256 === known.sha256;
    } finally {
      copy.state.current = null;
    }
  }

  /**
   * Deletes from the card the clips recorded as in the archive, once the archive says it holds them and they're the same.
   * Says the ones that aren't there after all, and the error if the archive couldn't be asked.
   */
  async function clearRecorded(recorded) {
    const again = [];
    let unasked = null;
    const going = [];
    for (const item of recorded) if (await mayGo(item.clip)) going.push(item);
    const unknown = [...new Set(going.map(({ known }) => known.sha256))].filter((hash) => !holds.has(hash));
    if (unknown.length && Date.now() < askAt) unasked = new Error("The archive couldn't be asked what it holds");
    else if (unknown.length)
      try {
        for (const hash of await held(ask, unknown, copy.signal)) holds.add(hash);
      } catch (error) {
        if (copy.signal.aborted) throw error;
        unasked = error;
        askAt = Date.now() + retry.first;
      }
    for (const { clip, known } of going) {
      if (copy.ending()) break;
      if (unasked && !holds.has(known.sha256)) continue;
      try {
        if (holds.has(known.sha256) && (await isTheSame(clip, known))) await remove(clip, "camera");
        else {
          strange.add(idOf(clip));
          again.push(clip);
        }
      } catch (error) {
        if (copy.signal.aborted) throw error;
        if (!(await statOf(clip.path))) throw Object.assign(new Error(UNPLUGGED), { unplugged: true });
        copy.failed(clip, error);
      }
    }
    return { again, unasked };
  }

  /**
   * Goes over the card: what's in the archive, or (as it's set) on the Mac, is deleted from it. Says the next clip to copy,
   * how many wait on the card for the archive to have them, how long until one that failed is tried again, and the error if
   * the archive couldn't be asked about some.
   */
  async function lookOver(card) {
    const keeps = await keeping();
    const record = await records.read();
    const left = [];
    const recorded = [];
    const clear = [];
    let awaiting = 0;
    let later = null;
    const mustWait = (clip) => {
      const ms = copy.wait(clip);
      if (ms) later = Math.min(later ?? ms, ms);
      return ms > 0;
    };
    for (const clip of card) {
      if (keeps(clip) || copy.passes(clip)) continue;
      const mine = readOffCard(clip);
      const known = record[clip.name];
      if (mine && landed.get(clip.name) === mine) clear.push(clip);
      else if (known?.size === clip.size && !strange.has(idOf(clip))) recorded.push({ clip, known });
      else if (!(await copiedStill(clip))) left.push(clip);
      else if (clearCardAfter() === "copied") clear.push(clip);
      else awaiting++;
    }
    for (const clip of clear) {
      if (copy.ending()) break;
      if (!mustWait(clip)) await remove(clip, "camera").catch((error) => copy.failed(clip, error));
    }
    const seen = recorded.filter(({ clip }) => !mustWait(clip));
    const { again, unasked } = await clearRecorded(seen);
    left.push(...again);
    cardLeft = left;
    copy.state.onCamera = awaiting;
    totals();
    const next = left.find((clip) => !mustWait(clip));
    // Any of these may turn out to need copying.
    const unsure = seen.length < recorded.length || Boolean(unasked);
    return { next, awaiting, later, unasked, unsure };
  }

  /** Copies a clip to the Mac, if there's room, and deletes it from the card if that's all it waits for. */
  async function takeOffCard(clip) {
    const path = join(dir, clip.name);
    if ((await statOf(path))?.size !== clip.size) {
      const free = await room();
      if (free - clip.size < keepFree) {
        const why = `No room on this Mac for the next clip: ${gb(free)} free, ${gb(keepFree)} kept free`;
        return copy.hold({ for: "room", why }, change(look));
      }
    }
    const going = { name: clip.name, sent: 0, size: clip.size };
    copy.state.current = going;
    try {
      const sha256 = await copyClip(clip, dir, {
        signal: copy.signal,
        onBytes: (n) => {
          going.sent += n;
        },
      });
      const here = { ...clip, path, mtime: Math.round((await stat(path)).mtimeMs) };
      offCard.set(clip.name, { id: idOf(clip), mtime: clip.mtime, sha256 });
      copied.set(idOf(clip), here);
      copy.state.done++;
      copy.state.doneBytes += clip.size;
      cardLeft = cardLeft.filter((other) => other !== clip);
      copy.fine();
      totals();
      void takeSound(here, copy);
      onCopied(here);
      notify();
      if (clearCardAfter() === "copied" && (await copiedStill(clip))) await remove(clip, "camera");
    } catch (error) {
      if (copy.signal.aborted) return;
      if (!(await statOf(clip.path))) await recoverCamera();
      else if (error.code === "ENOSPC") await copy.hold({ for: "room", why: error.message }, change(look));
      else copy.failed(clip, error);
    } finally {
      copy.state.current = null;
      notify();
    }
  }

  const recoverCamera = () =>
    copy.recover("camera", new Error(UNPLUGGED), async () => {
      if (!(await camera({ fresh: true }))) throw new Error(UNPLUGGED);
    });

  async function copyAll() {
    bringing = true;
    cardLeft = [];
    let fresh = false;
    while (!copy.ending()) {
      try {
        const card = await camera({ fresh });
        if (!card) {
          await recoverCamera();
          continue;
        }
        // Asked before looking: what lands as the sending ends is seen to have by the look after.
        const sending = send.state.on;
        const { next, awaiting, later, unasked, unsure } = await lookOver(card);
        if (copy.ending()) return;
        // A card being pulled can look like an empty one: it's not taken for that until it's looked at again.
        const sure = fresh;
        fresh = !next;
        bringing = cardLeft.length > 0 || unsure || !sure;
        if (!bringing) notify();
        if (next) await takeOffCard(next);
        else if (!sure) continue;
        else if (unasked) {
          await recover(copy, reaching(unasked));
          askAt = 0;
        } else if (later !== null) await change(Math.min(later, look));
        else if (awaiting && sending) await copy.hold({ for: "cloudflare", why: WAITS_FOR_CLOUDFLARE }, change(look));
        else return;
      } catch (error) {
        if (copy.signal.aborted) return;
        if (error.unplugged) await recoverCamera();
        else await recover(copy, error);
      }
    }
  }

  // ---- Mac → Cloudflare and Exports → Cloudflare -----------------------------------------------------------------------

  const gateLook = Math.min(look, 1000);
  /** Waits while uploads are paused. Throws once the lane is told to stop now. */
  async function open(lane) {
    for (;;) {
      lane.signal.throwIfAborted();
      const why = paused();
      if (!why) return;
      await lane.hold({ for: "page", why }, change(gateLook));
    }
  }

  /** Forgets that the archive holds a hash, till it's been checked again: a run cut short before then leaves no record. */
  async function distrust(from, sha256) {
    await from.records.drop(sha256);
    holds.delete(sha256);
    for (const [name, hash] of landed) if (hash === sha256) landed.delete(name);
  }

  /** Puts a clip in the archive and makes sure of it: anything R2 didn't just check whole is read back first. */
  async function store(from, clip, sha256, going) {
    const { lane } = from;
    const { signal } = lane;
    const { missing } = await ask("missing", { method: "POST", json: { blobs: [sha256] }, signal });
    let sending = missing.length > 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (sending) {
        await distrust(from, sha256);
        going.sent = 0;
        await sendBlob(ask, { abs: clip.path, size: clip.size }, sha256, {
          part,
          signal,
          ready: () => open(lane),
          onBytes: (n) => {
            going.sent += n;
            sentBytes(n);
          },
        });
        if (clip.size <= part) return;
      }
      await open(lane);
      if (await readsBack(ask, sha256, clip.size, signal)) return;
      // What's there under this hash isn't this clip: send it over that, once.
      sending = true;
    }
    throw final(`${clip.name} doesn't read back from Cloudflare as it was sent: it stays on this Mac`);
  }

  /**
   * What a lane sends: `list()` says the clips, `records` those sent, `project(day)` where a day's are filed, `lasting`
   * whether one there keeps its place, `before(clip)` whether a clip's Mac copy may go yet, `feeding()` whether more may
   * come. `left` are the clips to send as last seen, `flying` those being seen to (true until they're in the archive),
   * `gone` those a record is wrong about.
   */
  const source = (lane, given) => ({ lane, left: [], flying: new Map(), gone: new Set(), ...given });
  const originals = source(send, {
    where: "mac",
    records,
    list: mac,
    project: originalsName,
    lasting: true,
    before: (clip) => takeSound(clip, send),
    feeding: () => copy.state.on && bringing,
    // The hash is the card's own, of the file it had at that time, so that file can go on the strength of it.
    proof: (clip, sha256) => {
      const mine = offCard.get(clip.name);
      return mine?.sha256 === sha256 ? { card: mine.mtime } : {};
    },
  });
  const gradedCopies = source(lanes.exports, {
    where: "exports",
    records: graded,
    list: exports,
    project: gradedName,
    // A clip graded and exported again is its graded copy from then on.
    lasting: false,
    before: async () => true,
    feeding: () => false,
    proof: () => ({}),
  });

  /** How long until a clip may be seen to: one that failed has a wait, and one that may still be being written. */
  const waits = (lane, clip) => Math.max(lane.wait(clip), (clip.settles ?? 0) - Date.now(), 0);

  /** Deletes from the Mac the clips recorded as in the archive, once it says it holds them and they're the same. */
  async function clear(from, recorded, record) {
    const { lane, gone } = from;
    const going = [];
    for (const clip of recorded) if (!waits(lane, clip) && (await mayGo(clip))) going.push(clip);
    if (!going.length) return;
    const there = await held(ask, [...new Set(going.map((clip) => record[clip.name].sha256))], lane.signal);
    for (const clip of going) {
      if (lane.ending()) return;
      const { sha256 } = record[clip.name];
      try {
        if (there.has(sha256) && (await hashFile(clip.path, lane.signal)) === sha256) {
          landed.set(clip.name, sha256);
          if (await from.before(clip)) await remove(clip, from.where);
        } else {
          gone.add(idOf(clip));
          from.left.push(clip);
        }
      } catch (error) {
        if (lane.signal.aborted) throw error;
        lane.failed(clip, error);
      }
    }
  }

  /** The next clip to send, or how long until there may be one. */
  const nextOf = inTurn(async (from) => {
    const { lane, flying, gone } = from;
    const keeps = await keeping();
    const there = (await from.list()).filter((clip) => !keeps(clip));
    const record = await from.records.read();
    const recorded = [];
    from.left = [];
    for (const clip of there) {
      if (flying.has(clip.name)) {
        if (flying.get(clip.name)) from.left.push(clip);
      } else if (lane.passes(clip)) continue;
      else if (record[clip.name]?.size === clip.size && !gone.has(idOf(clip))) recorded.push(clip);
      else from.left.push(clip);
    }
    await clear(from, recorded, record);
    totals();
    const waiting = from.left.filter((clip) => !flying.has(clip.name));
    const ready = waiting.filter((clip) => !waits(lane, clip));
    for (const clip of ready) void from.before(clip);
    if (ready.length) flying.set(ready[0].name, true);
    const later = [...waiting, ...recorded].map((clip) => waits(lane, clip)).filter(Boolean);
    return { clip: ready[0] ?? null, later: later.length ? Math.min(...later) : null };
  });

  /** Sends a clip, files it, records it and deletes its Mac copy, in that order. */
  async function sendOne(from, clip) {
    const { lane, flying } = from;
    const going = { name: clip.name, sent: 0, size: clip.size, hashing: true };
    lane.state.current.push(going);
    try {
      const sha256 = await hashFile(clip.path, lane.signal);
      going.hashing = false;
      const { lasting } = from;
      const file = { path: clipPath(clip.name), sha256, size: clip.size, mtime: clip.mtime, lasting };
      // One recorded as another is looked up before it's sent, for hours maybe, only to be refused.
      const known = (await from.records.read())[clip.name];
      if (lasting && known && known.sha256 !== sha256)
        mayReplace(await projectFiles(ask, from.project(clip.day), lane.signal), file);
      await store(from, clip, sha256, going);
      await fileInDay(ask, clip.day, [file], lane.signal, from.project(clip.day));
      await from.records.add(clip, sha256, from.proof(clip, sha256));
      landed.set(clip.name, sha256);
      flying.set(clip.name, false);
      from.left = from.left.filter((other) => other.name !== clip.name);
      lane.state.done++;
      lane.state.doneBytes += clip.size;
      going.sent = 0;
      lane.fine();
      totals();
      notify();
      if (await from.before(clip)) await remove(clip, from.where);
    } catch (error) {
      if (lane.signal.aborted) return;
      going.sent = 0;
      // The site answering all the same, it's a try of this clip's: it may be what fails.
      const outage = onTheWay(error) && (await recover(lane, error));
      if (!outage) lane.failed(clip, error, { soon: onTheWay(error) });
    } finally {
      lane.state.current.splice(lane.state.current.indexOf(going), 1);
      flying.delete(clip.name);
      notify();
    }
  }

  async function sendAll(from) {
    const { lane } = from;
    while (!lane.ending()) {
      try {
        await lane.recovered();
        const why = paused();
        if (why) {
          await lane.hold({ for: "page", why }, change(gateLook));
          continue;
        }
        // Asked before looking: what's brought as the copying ends is there by the look after.
        const feeding = from.feeding();
        const { clip, later } = await nextOf(from);
        if (clip && lane.ending()) from.flying.delete(clip.name);
        else if (clip) await sendOne(from, clip);
        else if (later !== null || feeding) await change(Math.min(later ?? look, look));
        else return;
      } catch (error) {
        if (lane.signal.aborted) return;
        await recover(lane, error);
      }
    }
  }
  const senders = (from) => {
    from.gone.clear();
    from.left = [];
    return Promise.all(Array.from({ length: together }, () => sendAll(from)));
  };

  /** Sends a day's transcripts and files each beside its clip. */
  async function sendDay(day, ready) {
    const { signal } = send;
    const files = [];
    for (const { name, files: made } of ready)
      for (const { path, abs, mtime } of made) {
        const body = await readFile(abs);
        const sha256 = createHash("sha256").update(body).digest("hex");
        await open(send);
        await ask(`blobs/${sha256}`, { method: "PUT", body, signal });
        files.push({ path, sha256, size: body.length, mtime, beside: clipPath(name) });
      }
    const filed = new Set(await fileInDay(ask, day, files, signal));
    const sent = ready.filter(({ files: made }) => made.every(({ path }) => filed.has(path)));
    await transcripts.sent(sent.map(({ key }) => key));
    state.transcripts.sent += sent.length;
  }

  // Transcripts go up as they're made, and those left from earlier runs, until the clips are all in. Each is tried once a
  // run, but for the network's failings, and none is waited for: what isn't made by then goes with the next run.
  async function sendTranscripts(clipsIn) {
    const over = new Set();
    const tries = new Map();
    /** Sends what's ready of a day's. */
    async function trySending(day, ready) {
      try {
        await sendDay(day, ready);
      } catch (error) {
        if (send.signal.aborted) return;
        tries.set(day, (tries.get(day) ?? 0) + 1);
        if (onTheWay(error) && tries.get(day) < retry.tries) {
          if (await recover(send, error)) tries.delete(day);
          return;
        }
        state.transcripts.error = error.message;
      }
      for (const { key } of ready) over.add(key);
    }
    while (!send.ending()) {
      const last = clipsIn();
      const made = await transcripts.ready().catch((error) => {
        state.transcripts.error = error.message;
        return [];
      });
      const ready = made.filter(({ key }) => !over.has(key));
      for (const [day, ofDay] of Map.groupBy(ready, (transcript) => transcript.day)) {
        await send.recovered();
        if (send.ending()) return;
        await trySending(day, ofDay);
      }
      if (ready.length) continue;
      if (last) return;
      if (!clipsIn()) await change(look);
    }
  }

  async function sendOriginals() {
    let clipsIn = false;
    const clipsSent = senders(originals).then(() => {
      clipsIn = true;
      notify();
    });
    await Promise.all([clipsSent, sendTranscripts(() => clipsIn)]);
  }

  // ---- the switches ----------------------------------------------------------------------------------------------------

  const works = { copy: copyAll, send: sendOriginals, exports: () => senders(gradedCopies) };
  let on = 0;
  let over;
  const done = new Promise((resolve) => {
    over = resolve;
  });
  function start(name) {
    if (!state.running || lanes[name].state.on) return false;
    on++;
    void lanes[name].run(works[name]).then(() => {
      on--;
      totals();
      notify();
      if (on) return;
      const ran = LANES.map((lane) => lanes[lane].state);
      state.error = ran.find(({ error }) => error)?.error ?? null;
      if (!state.error) state.finished = ran.some(({ finished }) => finished === "stopped") ? "stopped" : "done";
      state.running = false;
      over();
    });
    notify();
    return true;
  }
  function stop(names = LANES, { now = false } = {}) {
    const stopping = names.map((name) => lanes[name]).filter((lane) => lane.state.on);
    // Asked of several, the ones not told yet are told; asked again, they're all cut.
    const untold = stopping.filter((lane) => !lane.ending());
    for (const lane of now || !untold.length ? stopping : untold) lane.stop(now);
    notify();
  }
  for (const name of wanted) start(name);
  return { state, start, stop, poke: notify, done };
}
