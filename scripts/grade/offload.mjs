// Offloading frees the camera's card fast and the Mac after it. Each clip is copied off the card to Movies/Original
// (hashed as it's read, then read back on the Mac and checked against it) and deleted from the card with its .LRF; then
// it goes to the site's archive under its SHA-256 and is deleted from the Mac once it's checked there (read back, unless
// R2 checked it whole). The two go on
// together: the card is read a clip at a time while the Mac has room for the next with `keepFree` to spare, and the clips
// on the Mac go up `together` at a time, each one gone making room for the next off the card. The camera is needed only
// until the last clip is on the Mac.
//
// Each shoot day is a manifest of its own in the archive, `_originals-<day>`, holding its clips as `assets/<file>`, saved
// again after every clip so a clip is safe the moment it's in. The ledger counts an archived file the original's size as
// the original in Cloudflare; the leading `_` keeps these out of the films. `bun run publisher restore _originals-<day>`
// brings a day back.
//
// Each clip's sound is taken before its Mac copy goes, to be transcribed meanwhile or later (transcripts.mjs). A
// transcript is filed beside its clip, as `transcripts/<clip>.vtt` and `.json`, while a run goes, and never stops one.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readRange } from "../publisher/archive.mjs";

/** Each request carries this much of a clip: on a slow uplink one still lands well inside a request's ten minutes. */
export const OFFLOAD_PART = 16 * 1024 * 1024;

export const originalsName = (day) => `_originals-${day}`;
const clipPath = (name) => `assets/${name}`;
const lrfOf = (path) => path.replace(/\.mp4$/i, ".LRF");
const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;

export async function hashFile(abs, signal = null) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(abs, { highWaterMark: 8 << 20, ...(signal ? { signal } : {}) }))
    hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Copies a card clip into `dir` under its own name and time, hashing it as it's read, then reads the copy back and
 * checks it against that. Says its SHA-256. A copy cut short leaves nothing behind.
 */
export async function copyClip(clip, dir, { signal = null, onBytes = () => {} } = {}) {
  const partial = join(dir, `.${clip.name}.part`);
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
    await rename(partial, join(dir, clip.name));
    return sha256;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/**
 * Sends one file to the archive under its hash: whole up to `part`, else a part at a time. `onBytes` hears each request's
 * bytes land; aborting `signal` stops the request in flight and gives the part-sent file up.
 */
export async function sendBlob(
  request,
  { abs, size },
  hash,
  { part = OFFLOAD_PART, signal = null, onBytes = () => {} } = {},
) {
  if (size <= part) {
    await request(`blobs/${hash}`, { method: "PUT", body: await readRange(abs, 0, size), signal });
    onBytes(size);
    return;
  }
  const { upload } = await request("uploads", { method: "POST", json: { blob: hash }, signal });
  const query = `upload=${encodeURIComponent(upload)}`;
  const parts = [];
  try {
    for (let offset = 0, n = 1; offset < size; offset += part, n++) {
      const length = Math.min(part, size - offset);
      const body = await readRange(abs, offset, length);
      parts.push(await request(`uploads/${hash}/${n}?${query}`, { method: "PUT", body, signal }));
      onBytes(length);
    }
    await request(`uploads/${hash}/complete`, { method: "POST", json: { upload, parts }, signal });
  } catch (error) {
    await request(`uploads/${hash}?${query}`, { method: "DELETE" }).catch(() => {});
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
  for await (const chunk of response.body) read.update(chunk);
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

/** A day's manifest as last archived: its files by path, or none yet. */
async function dayFiles(request, day, signal) {
  try {
    const manifest = await request(`projects/${originalsName(day)}`, { signal });
    return new Map(manifest.files.map((file) => [file.path, file]));
  } catch (error) {
    if (/No such archived project/.test(error.message)) return new Map();
    throw error;
  }
}

/** Files in a day's manifest all it holds and these, until the manifest reads back with them. */
async function saveDay(request, day, files, signal) {
  for (let saves = 0; ; saves++) {
    const held = await dayFiles(request, day, signal);
    const filing = files.filter(({ beside }) => !beside || held.has(beside));
    const listed = ({ path, sha256, size }) => held.get(path)?.sha256 === sha256 && held.get(path).size === size;
    if (filing.every(listed)) return filing.map(({ path }) => path);
    if (saves === 3) throw new Error(`${originalsName(day)} doesn't list what was filed in it`);
    for (const { path, sha256, size, mtime } of filing) held.set(path, { path, sha256, size, mtime });
    await request(`projects/${originalsName(day)}`, {
      method: "PUT",
      json: { files: [...held.values()], folders: [] },
      signal,
    });
  }
}

/**
 * Files into the shoot days' manifests. A manifest is saved whole, so every save of a day's, whichever run or transcript
 * asks for it, waits for the one before it and keeps all the day has in the archive by then. It's done once the manifest
 * reads back with what was filed: the archive dates a manifest by a Worker's clock, so one saved after another can come
 * out the earlier of the two.
 *
 * `fileInDay(request, day, files, signal)` takes `{ path, sha256, size, mtime }`, and with `beside` files one only if the
 * day holds that path. It says the paths filed.
 */
export function dayManifests() {
  const turns = new Map();
  return function fileInDay(request, day, files, signal = null) {
    const save = (turns.get(day) ?? Promise.resolve()).then(() => saveDay(request, day, files, signal));
    turns.set(
      day,
      save.catch(() => {}),
    );
    return save;
  };
}

/** No transcripts: an offload of clips alone. */
const NO_TRANSCRIPTS = { take: async () => {}, ready: async () => [], sent: async () => {} };

/**
 * Starts offloading. `camera`: the card's clips, `mac`: Movies/Original's, each `{ name, path, size, mtime, day }`,
 * oldest first. `record` (name → { sha256, size }) is what went to the archive before: those it still holds are only
 * deleted. `dir` is Movies/Original; `room()` says how many bytes are free there. A clip `removable` says no to (one
 * being exported) stays where it is. `landed(clip, sha256)` hears each clip once the archive has it, `removed(clip)` each
 * one deleted from the card or the Mac. `fileInDay` is the days' manifests: the one `dayManifests()` for every run.
 *
 * `transcripts` is what the transcriber does: `take(clip, signal)` takes a clip's sound from its Mac copy, which waits for
 * it; `ready()` says the transcripts to send, each `{ key, name, day, files: [{ path, abs, mtime }] }`; `sent(keys)` hears
 * the ones filed.
 *
 * Says `{ state, stop, poke, done }`: `state` is read as it goes; `stop()` ends it, keeping what's in; `poke()` says a
 * transcript is ready; `done` settles when it has ended, `state.finished` then saying "done" or "stopped", or `state.error`
 * what went wrong.
 */
export function startOffload({
  camera,
  mac,
  record = {},
  dir,
  request,
  room,
  keepFree = 5e9,
  removable = () => true,
  part = OFFLOAD_PART,
  together = 2,
  landed = () => {},
  removed = () => {},
  fileInDay = dayManifests(),
  transcripts = NO_TRANSCRIPTS,
}) {
  const stopping = new AbortController();
  const { signal } = stopping;
  const sum = (clips) => clips.reduce((total, clip) => total + clip.size, 0);
  const state = {
    running: true,
    /** Off the card onto the Mac. */
    copy: { total: camera.length, bytes: sum(camera), done: 0, doneBytes: 0, current: null, ended: false, error: null },
    /** Up to the archive: what's on the Mac now and all that comes off the card. */
    send: { total: camera.length + mac.length, bytes: sum(camera) + sum(mac), done: 0, doneBytes: 0, current: [] },
    /** Transcripts filed, and why one couldn't be: it waits for the next run. */
    transcripts: { sent: 0, error: null },
    /** Set while the next clip off the card waits for room on the Mac. */
    waiting: null,
    /** Bytes sent to the archive: [time, total] over the last minute or so, for the speed. */
    sent: 0,
    samples: [],
    /** Bytes deleted from the card, and from the Mac. */
    freed: { camera: 0, mac: 0 },
    finished: null,
    error: null,
  };

  // Every stage waits on the others: a clip off the card for the senders, room on the Mac for the copy.
  const waiters = new Set();
  const notify = () => {
    for (const wake of waiters) wake();
    waiters.clear();
  };
  signal.addEventListener("abort", notify, { once: true });
  const change = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      waiters.add(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  const sentBytes = (n) => {
    state.sent += n;
    const now = Date.now();
    state.samples.push([now, state.sent]);
    while (state.samples.length > 2 && now - state.samples[0][0] > 60_000) state.samples.shift();
  };

  async function remove(clip, where) {
    if (!removable(clip)) return;
    await rm(clip.path, { force: true });
    if (where === "camera") await rm(lrfOf(clip.path), { force: true });
    state.freed[where] += clip.size;
    removed(clip, where);
    notify();
  }

  const fileClip = (clip, sha256) =>
    fileInDay(request, clip.day, [{ path: clipPath(clip.name), sha256, size: clip.size, mtime: clip.mtime }], signal);

  const queue = [];
  let copying = true;

  /**
   * Takes a clip's sound. Says whether its Mac copy may go: not if this was cut short, but a sound that can't be taken
   * keeps no clip here.
   */
  async function takeSound(clip) {
    if (signal.aborted) return false;
    await transcripts.take(clip, signal).catch(() => {});
    return !signal.aborted;
  }
  // Taken as soon as the clip is on the Mac, one at a time, so it's transcribed while the clip goes up.
  const sounds = new Map();
  let taking = Promise.resolve();
  function onMac(clip) {
    taking = taking.then(() => takeSound(clip));
    sounds.set(clip, taking);
    queue.push(clip);
  }

  async function copyAll(clips) {
    try {
      for (const clip of clips) {
        for (;;) {
          if (signal.aborted) return;
          const free = await room();
          if (free - clip.size >= keepFree) break;
          // Nothing on the Mac left to go up: no room will come.
          if (!queue.length && !state.send.current.length)
            throw new Error(`No room on this Mac for the next clip: ${gb(free)} free, ${gb(keepFree)} kept free`);
          state.waiting = "room";
          await change(10_000);
        }
        state.waiting = null;
        state.copy.current = { name: clip.name, sent: 0, size: clip.size };
        let sha256;
        try {
          sha256 = await copyClip(clip, dir, {
            signal,
            onBytes: (n) => {
              state.copy.current.sent += n;
            },
          });
        } catch (error) {
          if (!(await stat(clip.path).catch(() => null))) throw new Error("The camera was unplugged");
          throw error;
        }
        onMac({ ...clip, path: join(dir, clip.name), sha256 });
        state.copy.done++;
        state.copy.doneBytes += clip.size;
        state.copy.current = null;
        await remove(clip, "camera");
        notify();
      }
    } catch (error) {
      if (!signal.aborted) state.copy.error = error.message;
    } finally {
      state.copy.current = null;
      state.waiting = null;
      state.copy.ended = true;
      copying = false;
      notify();
    }
  }

  /** Puts a clip in the archive and makes sure of it: anything R2 didn't just check whole is read back first. */
  async function store(clip, sha256, going) {
    const { missing } = await request("missing", { method: "POST", json: { blobs: [sha256] }, signal });
    let send = missing.length > 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (send) {
        going.sent = 0;
        await sendBlob(request, { abs: clip.path, size: clip.size }, sha256, {
          part,
          signal,
          onBytes: (n) => {
            going.sent += n;
            sentBytes(n);
          },
        });
        if (clip.size <= part) return;
      }
      if (await readsBack(request, sha256, clip.size, signal)) return;
      // What's there under this hash isn't this clip: send it over that, once.
      send = true;
    }
    throw new Error(`${clip.name} doesn't read back from Cloudflare as it was sent: it stays on this Mac`);
  }

  async function sendAll() {
    for (;;) {
      if (signal.aborted) return;
      const clip = queue.shift();
      if (!clip) {
        if (!copying) return;
        await change(10_000);
        continue;
      }
      const going = { name: clip.name, sent: 0, size: clip.size, hashing: !clip.sha256 };
      state.send.current.push(going);
      try {
        const sha256 = clip.sha256 ?? (await hashFile(clip.path, signal));
        going.hashing = false;
        await store(clip, sha256, going);
        await fileClip(clip, sha256);
        state.send.done++;
        state.send.doneBytes += clip.size;
        landed(clip, sha256);
        if (await sounds.get(clip)) await remove(clip, "mac");
      } finally {
        state.send.current.splice(state.send.current.indexOf(going), 1);
      }
    }
  }

  /** Sends a day's transcripts and files each beside its clip. */
  async function sendDay(day, ready) {
    const files = [];
    for (const { name, files: made } of ready)
      for (const { path, abs, mtime } of made) {
        const body = await readFile(abs);
        const sha256 = createHash("sha256").update(body).digest("hex");
        await request(`blobs/${sha256}`, { method: "PUT", body, signal });
        files.push({ path, sha256, size: body.length, mtime, beside: clipPath(name) });
      }
    const filed = new Set(await fileInDay(request, day, files, signal));
    const sent = ready.filter(({ files: made }) => made.every(({ path }) => filed.has(path)));
    await transcripts.sent(sent.map(({ key }) => key));
    state.transcripts.sent += sent.length;
  }

  // Transcripts go up as they're made, and those left from earlier runs, until the clips are all in. Each is tried once a
  // run, and none is waited for: what isn't made by then goes with the next run.
  let sending = true;
  async function sendTranscripts() {
    const tried = new Set();
    while (!signal.aborted) {
      const last = !sending;
      const ready = (await transcripts.ready()).filter(({ key }) => !tried.has(key));
      for (const [day, ofDay] of Map.groupBy(ready, (transcript) => transcript.day)) {
        for (const { key } of ofDay) tried.add(key);
        await sendDay(day, ofDay).catch((error) => {
          if (!signal.aborted) state.transcripts.error = error.message;
        });
      }
      if (ready.length) continue;
      if (last) return;
      if (sending) await change(10_000);
    }
  }

  async function run() {
    // What the archive holds already is only deleted; anything it's lost goes again.
    const recordedHash = (clip) => record[clip.name]?.size === clip.size && record[clip.name].sha256;
    const recorded = [...new Set([...camera, ...mac].map(recordedHash).filter(Boolean))];
    const holds = await held(request, recorded, signal);
    const safe = (clip) => holds.has(recordedHash(clip));
    for (const clip of camera.filter(safe)) await remove(clip, "camera");
    for (const clip of mac.filter(safe)) if (await takeSound(clip)) await remove(clip, "mac");
    const fromCamera = camera.filter((clip) => !safe(clip));
    const fromMac = mac.filter((clip) => !safe(clip));
    Object.assign(state.copy, { total: fromCamera.length, bytes: sum(fromCamera) });
    Object.assign(state.send, {
      total: fromCamera.length + fromMac.length,
      bytes: sum(fromCamera) + sum(fromMac),
    });
    for (const clip of fromMac) onMac(clip);
    // A sender failing stops the rest, and the copy: the next run picks up where this one stopped.
    const senders = Array.from({ length: together }, () =>
      sendAll().catch((error) => {
        if (!signal.aborted) state.error ??= error.message;
        stopping.abort();
      }),
    );
    const clipsSent = Promise.all([copyAll(fromCamera), ...senders]).then(() => {
      sending = false;
      notify();
    });
    const transcriptsSent = sendTranscripts().catch((error) => {
      state.transcripts.error = error.message;
    });
    await Promise.all([clipsSent, transcriptsSent]);
  }

  const done = run()
    .catch((error) => {
      if (!signal.aborted) state.error ??= error.message;
    })
    .finally(() => {
      if (state.error) state.finished = null;
      else if (signal.aborted) state.finished = "stopped";
      else state.finished = "done";
      state.running = false;
      state.waiting = null;
    });
  return { state, stop: () => stopping.abort(), poke: notify, done };
}
