// The footage archive: every graded clip goes up, unlisted, to a YouTube channel of its own. It's a second copy beside
// the Cloudflare archive, one that keeps playing years on. The helper uploads a few a day: clips in ~/Movies/Exported,
// and clips the laptop has since let go of (after their film was posted) from the Cloudflare archive. It uploads only
// while the composer's Archive tab is open, so the uploads never take the network without the owner seeing them.
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Innertube } from "youtubei.js";
import { EXPORTED, readRange } from "./archive.mjs";
import { findId, openProfile, youtubeCookie } from "./browser.mjs";

/** The account's name, in the composer's list and the helper's config. */
export const FOOTAGE = "youtube-footage";
export const FOOTAGE_HOME = "https://www.youtube.com/";
/** What the grade app made each export from, and how. */
export const EXPORTS = join(homedir(), "Library/Application Support/Grade/exports.json");
/** YouTube caps how many videos a channel puts up a day; this stays well under it. */
export const DAILY = 10;
/** A clip changed in the last two minutes may still be being written. */
const SETTLE = 2 * 60_000;
/**
 * Each request carries this much of a file, so a dropped connection costs one part, not the clip, and the Archive tab's
 * progress and speed move every few seconds even on a slow uplink.
 */
const CHUNK = 16 * 1024 * 1024;
const HOUR = 60 * 60_000;
/** A Pocket 4P clip: the camera's clock in its name, then its number. */
const CLIP = /^DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_(\d{4})_D\.mp4$/i;
/** A status lists at most this many clips, the newest first; its totals still count them all. */
const LISTED = 300;

/** Thrown when the Archive tab closes mid-upload. It isn't a failure, so nothing waits before the next try. */
export class Stopped extends Error {
  constructor() {
    super("Stopped: the Archive tab closed");
  }
}

const stem = (name) => name.replace(/\.[^.]+$/, "");
const gb = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const total = (clips) => clips.reduce((sum, clip) => sum + (clip.size || 0), 0);

/** A clip's title: when the camera started it, and its number. */
export function clipTitle(name) {
  const match = name.match(CLIP);
  if (!match) return stem(name);
  const [, year, month, date, hour, minute, second, number] = match;
  return `${year}-${month}-${date} ${hour}:${minute}:${second} · clip ${number}`;
}

/** A clip's description: its file, where it came from and how it was graded, from the grade app's record. */
export function clipDescription(name, record) {
  const lines = [`${stem(name)}, graded footage.`];
  if (record?.source) lines.push(`Source: ${record.source}`);
  if (record?.base?.name) {
    const settings = Object.entries(record.grade ?? {})
      .filter(([key, value]) => key !== "base" && value !== null && value !== undefined)
      .map(([key, value]) => `${key} ${value}`);
    const from = record.profile ? ` from ${record.profile}` : "";
    lines.push(`Grade: ${record.base.name}${from}${settings.length ? ` (${settings.join(", ")})` : ""}`);
  }
  if (record?.exportedAt) lines.push(`Exported ${record.exportedAt.slice(0, 10)}`);
  return lines.join("\n");
}

async function exportRecords(exportsFile) {
  try {
    const { clips = {} } = JSON.parse(await readFile(exportsFile, "utf8"));
    return new Map(Object.entries(clips).map(([name, record]) => [stem(name).toLowerCase(), record]));
  } catch {
    return new Map();
  }
}

/** The grade app's finished exports in `exported`: each with a record of how it was made, and settled on disk. */
export async function exportedClips({ exported = EXPORTED, exportsFile = EXPORTS, now = Date.now() } = {}) {
  const records = await exportRecords(exportsFile);
  const clips = [];
  for (const name of (await readdir(exported).catch(() => [])).sort()) {
    const record = records.get(stem(name).toLowerCase());
    if (!record) continue;
    const abs = join(exported, name);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile() || now - info.mtimeMs < SETTLE) continue;
    clips.push({ name, abs, size: info.size, mtime: Math.round(info.mtimeMs), record, from: "exported" });
  }
  return clips;
}

/**
 * Every graded clip the archive's projects hold, once each. Listing them takes a request per project, so the Archive
 * tab's uploads ask once while it's open and reuse the answer.
 */
export async function archiveFootage(request, records = new Map()) {
  const clips = new Map();
  for (const { name: project } of (await request("projects")).projects) {
    // Of what the grade app keeps here only a day's graded copies (`_graded-<day>`) are footage: its offloaded originals
    // (`_originals-<day>`) are ungraded, and never go to YouTube.
    if (project.startsWith("_") && !project.startsWith("_graded-")) continue;
    for (const file of (await request(`projects/${project}`)).files) {
      const name = file.path.split("/").pop();
      if (!/^(zh\/)?assets\//.test(file.path) || !CLIP.test(name) || clips.has(name)) continue;
      const record = records.get(stem(name).toLowerCase());
      const { sha256, size, mtime } = file;
      clips.set(name, { name, sha256, size, mtime, record, from: "archive", project });
    }
  }
  return [...clips.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Graded clips of archived projects that no version of has gone up yet: the ones cleaned off the laptop. */
export async function archivedClips(request, state, records = new Map()) {
  return (await archiveFootage(request, records)).filter((clip) => !state.clips[clip.name]);
}

/* ── what's up ─────────────────────────────────────────────────────────── */

const stateFile = (stateDir) => join(stateDir, "footage.json");

/**
 * What went up: each clip's videos by its name (a clip graded again goes up again), uploads per day, the upload in
 * progress, so a restart picks it up where it stopped, and the last failure with when to try again.
 */
export async function readState(stateDir) {
  try {
    const state = JSON.parse(await readFile(stateFile(stateDir), "utf8"));
    return { clips: {}, days: {}, ...state };
  } catch {
    return { clips: {}, days: {} };
  }
}
async function writeState(stateDir, state) {
  const temp = `${stateFile(stateDir)}.${process.pid}`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temp, stateFile(stateDir));
}

/** Whether this version of a clip is up: an export by its size and time, an archived clip by any version. */
export function isUp(state, clip) {
  const versions = state.clips[clip.name] ?? [];
  if (clip.from === "archive") return versions.length > 0;
  return versions.some((v) => v.size === clip.size && v.mtime === clip.mtime);
}

/**
 * The clips waiting to go up: the grade app's exports, then clips only the archive still holds, from `archived` (the
 * archive's clips, already asked for) or else by asking `request` (the Cloudflare archive's client).
 */
export async function dueClips(
  state,
  { exported = EXPORTED, exportsFile = EXPORTS, request = null, archived = null, now = Date.now() } = {},
) {
  const local = (await exportedClips({ exported, exportsFile, now })).filter((clip) => !isUp(state, clip));
  if (!archived && !request) return local;
  const held = archived
    ? archived.filter((clip) => !state.clips[clip.name])
    : await archivedClips(request, state, await exportRecords(exportsFile));
  return [...local, ...held.filter((clip) => !local.some((l) => l.name === clip.name))];
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
/** Only one uploader at a time: the helper's, or one run by hand. A lock whose process is gone is taken over. */
async function takeLock(stateDir) {
  const dir = join(stateDir, "footage.lock");
  try {
    await mkdir(dir);
  } catch {
    const pid = Number(await readFile(join(dir, "pid"), "utf8").catch(() => "0"));
    if (pid && alive(pid)) return null;
    await rm(dir, { recursive: true, force: true });
    try {
      await mkdir(dir);
    } catch {
      return null;
    }
  }
  await writeFile(join(dir, "pid"), String(process.pid));
  return { release: () => rm(dir, { recursive: true, force: true }) };
}

/* ── YouTube ───────────────────────────────────────────────────────────── */

const either = (a, b) => (a && b ? AbortSignal.any([a, b]) : a ?? b);

/**
 * The upload calls of a signed-in YouTube session: on the channel `pageId` names, when the Google account holds several,
 * else on the account's own channel.
 */
export async function youtubeSession(cookie, pageId, signal) {
  const yt = await Innertube.create({
    cookie,
    retrieve_player: false,
    on_behalf_of_user: pageId || undefined,
    // A part's own signal stops it when the Archive tab closes; the session's stops everything.
    fetch: (input, init) => fetch(input, { ...init, signal: either(init?.signal, signal) }),
  });
  return {
    start: (payload) =>
      yt.session.http.fetch("/upload/youtubei", {
        baseURL: "https://upload.youtube.com/",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-goog-upload-command": "start",
          "x-goog-upload-protocol": "resumable",
        },
        body: JSON.stringify(payload),
      }),
    send: (url, init) => yt.session.http.fetch_function(url, init),
    create: (body) => yt.session.actions.execute("/upload/createvideo", body),
  };
}

/** The footage channel's session, from its own Chrome profile, opened out of sight. */
export async function footageSession({ stateDir, config, open = openProfile, signal }) {
  const context = await open(join(stateDir, FOOTAGE), true);
  let cookie;
  try {
    cookie = youtubeCookie(await context.cookies(FOOTAGE_HOME));
  } finally {
    await context.close();
  }
  if (!cookie) throw new Error("The footage channel's session is gone: connect the YouTube footage archive again");
  return youtubeSession(cookie, config.footage?.pageId, signal);
}

/** The channel a signed-in YouTube window is on, and the page id that picks it among an account's channels. */
export async function channelIn(page) {
  await page.goto("https://www.youtube.com/profile");
  await page.waitForURL(/youtube\.com\/(?:channel\/UC[\w-]+|@[\w.-]+)/, { timeout: 30_000 }).catch(() => {});
  const channel = new URL(page.url()).pathname.match(/^\/(channel\/UC[\w-]+|@[\w.-]+)/)?.[1] ?? null;
  const pageId = await page.evaluate(() => window.ytcfg?.get?.("DELEGATED_SESSION_ID") ?? null).catch(() => null);
  return { channel, pageId };
}

/** How many bytes of an upload YouTube holds, or null once the upload is over or gone. */
async function received(client, session) {
  const response = await client
    .send(session.url, { method: "POST", headers: { "x-goog-upload-command": "query" } })
    .catch(() => null);
  if (!response?.ok || response.headers.get("x-goog-upload-status") !== "active") return null;
  return Number(response.headers.get("x-goog-upload-size-received")) || 0;
}

/**
 * Puts a file up as an unlisted video and says its id. The file goes in parts, each resent from where YouTube says it
 * stopped when one fails; `session` resumes an upload a restart cut short, and `save` keeps the one it starts.
 * `progress` hears how many bytes YouTube holds, at the start and after each part. Aborting `signal` stops the part in
 * flight and throws `Stopped`, the session kept to resume from.
 */
export async function uploadVideo(
  client,
  file,
  { title, description },
  {
    session = null,
    save = async () => {},
    log = () => {},
    progress = () => {},
    signal = null,
    chunk = CHUNK,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  if (signal?.aborted) throw new Stopped();
  let offset = session ? await received(client, session) : null;
  if (offset === null) {
    const frontendUploadId = `innertube_android:${randomUUID()}:0:v=3,api=1,cf=3`;
    const response = await client.start({
      frontendUploadId,
      deviceDisplayName: "Pixel 6 Pro",
      fileId: `goog-edited-video://generated?videoFileUri=content://media/external/video/media/${randomUUID()}`,
      mp4MoovAtomRelocationStatus: "UNSUPPORTED",
      transcodeResult: "DISABLED",
      connectionType: "WIFI",
    });
    const url = response.ok ? response.headers.get("x-goog-upload-url") : null;
    if (!url) throw new Error(`YouTube didn't start the upload (${response.status})`);
    const granularity = Number(response.headers.get("x-goog-upload-chunk-granularity")) || 256 * 1024;
    session = { url, frontendUploadId, granularity };
    await save(session);
    offset = 0;
  }
  // Every part but the last is a whole number of YouTube's chunks.
  const step = Math.max(1, Math.floor(chunk / session.granularity)) * session.granularity;
  let result = null;
  let failures = 0;
  let told = 0;
  progress(offset);
  while (!result) {
    if (signal?.aborted) throw new Stopped();
    const length = Math.min(step, file.size - offset);
    const last = offset + length >= file.size;
    try {
      const response = await client.send(session.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-goog-upload-command": last ? "upload, finalize" : "upload",
          "x-goog-upload-offset": String(offset),
        },
        body: await file.read(offset, length),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(`YouTube refused part of the upload (${response.status})`);
      offset += length;
      failures = 0;
      if (last) result = await response.json();
      else {
        progress(offset);
        if (offset - told >= file.size / 4) {
          told = offset;
          log(`${Math.round((offset / file.size) * 100)}%`);
        }
      }
    } catch (error) {
      if (signal?.aborted) throw new Stopped();
      if (++failures > 5) throw error;
      await wait(5000 * failures);
      if (signal?.aborted) throw new Stopped();
      const at = await received(client, session);
      if (at === null) throw error;
      offset = at;
    }
  }
  if (result?.status !== "STATUS_SUCCESS") throw new Error("YouTube couldn't process the upload");
  const created = await client.create({
    resourceId: { scottyResourceId: { id: result.scottyResourceId } },
    frontendUploadId: session.frontendUploadId,
    initialMetadata: {
      title: { newTitle: title },
      description: { newDescription: description, shouldSegment: true },
      privacy: { newPrivacy: "UNLISTED" },
      draftState: { isDraft: false },
    },
  });
  const id = findId(created?.data, ["videoId", "video_id", "encryptedVideoId"]);
  if (!id) throw new Error("YouTube didn't confirm the video");
  return id;
}

/** A clip of the archive, fetched to `dir` and checked against its hash. */
async function download(request, clip, dir, signal) {
  await mkdir(dir, { recursive: true });
  const target = join(dir, clip.name);
  const response = await request(`blobs/${clip.sha256}`, { raw: true, signal });
  const hash = createHash("sha256");
  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk) => hash.update(chunk));
  try {
    await pipeline(body, createWriteStream(target));
  } catch (error) {
    await rm(target, { force: true });
    throw signal?.aborted ? new Stopped() : error;
  }
  if (hash.digest("hex") !== clip.sha256) {
    await rm(target, { force: true });
    throw new Error(`${clip.name} came back from the archive different`);
  }
  return target;
}

/**
 * Puts up the clips due, up to the day's limit: the grade app's exports first, then (with `request`, the Cloudflare
 * archive's client) clips only the archive still holds, from `archived` when they've been asked for already. A failure
 * stops the run and waits longer each time before the next: half an hour, then an hour, and so on up to a day, which is
 * also how YouTube's daily limit is waited out. Aborting `signal` stops the run where it is with nothing to wait out,
 * and the upload in flight resumes from there next time; `progress` hears each clip's bytes as they go up.
 */
export async function uploadFootage({
  stateDir,
  config,
  request = null,
  archived = null,
  connect = footageSession,
  exported = EXPORTED,
  exportsFile = EXPORTS,
  log = () => {},
  progress = () => {},
  signal = null,
  now = () => Date.now(),
  daily = config.footage?.daily ?? DAILY,
  chunk,
  wait,
}) {
  const lock = await takeLock(stateDir);
  if (!lock) return { busy: true, uploaded: 0, left: 0 };
  try {
    const state = await readState(stateDir);
    if ((state.pausedUntil ?? 0) > now()) return { uploaded: 0, left: 0, pausedUntil: state.pausedUntil };
    const today = day(now());
    const room = daily - (state.days[today] ?? 0);
    let queue = await dueClips(state, { exported, exportsFile, now: now(), archived });
    // The archive is only asked when today's room isn't already taken by exports.
    if (request && !archived && room > queue.length)
      queue = await dueClips(state, { exported, exportsFile, now: now(), request });
    if (!queue.length || room <= 0) return { uploaded: 0, left: queue.length };
    if (signal?.aborted) return { uploaded: 0, left: queue.length, stopped: true };
    const client = await connect({ stateDir, config });
    let uploaded = 0;
    for (const clip of queue.slice(0, room)) {
      if (signal?.aborted) return { uploaded, left: queue.length - uploaded, stopped: true };
      const version = clip.sha256 ?? `${clip.size}:${clip.mtime}`;
      let temp = null;
      try {
        progress({ name: clip.name, size: clip.size, sent: 0, from: clip.from });
        const abs = clip.abs ?? (temp = await download(request, clip, join(stateDir, "footage-download"), signal));
        log(`Footage: putting up ${clip.name} (${gb(clip.size)})`);
        const resume = state.current?.name === clip.name && state.current.version === version;
        const video = await uploadVideo(
          client,
          { size: clip.size, read: (offset, length) => readRange(abs, offset, length) },
          { title: clipTitle(clip.name), description: clipDescription(clip.name, clip.record) },
          {
            session: resume ? state.current.session : null,
            save: async (session) => {
              state.current = { name: clip.name, version, session };
              await writeState(stateDir, state);
            },
            log: (share) => log(`Footage: ${clip.name} ${share}`),
            progress: (sent) => progress({ name: clip.name, size: clip.size, sent, from: clip.from }),
            signal,
            chunk,
            wait,
          },
        );
        // The time the file had, so one put up from the archive is known when it's brought back to the Mac.
        const kept = { ...(clip.from === "archive" ? { sha256: clip.sha256 } : {}), mtime: clip.mtime };
        (state.clips[clip.name] ??= []).push({
          video,
          size: clip.size,
          ...kept,
          from: clip.from,
          uploadedAt: new Date(now()).toISOString(),
        });
        state.current = null;
        state.days[today] = (state.days[today] ?? 0) + 1;
        state.failures = 0;
        delete state.lastError;
        await writeState(stateDir, state);
        uploaded++;
        log(`Footage: ${clip.name} is up as https://youtu.be/${video}`);
      } catch (error) {
        // The Archive tab closing isn't a failure: the upload resumes where YouTube says it stopped, next time.
        if (error instanceof Stopped || signal?.aborted) {
          log(`Footage: stopped ${clip.name}, the Archive tab closed`);
          return { uploaded, left: queue.length - uploaded, stopped: true };
        }
        state.failures = (state.failures ?? 0) + 1;
        state.pausedUntil = now() + Math.min(24 * HOUR, (HOUR / 2) * 2 ** (state.failures - 1));
        state.lastError = { clip: clip.name, message: error.message, at: new Date(now()).toISOString() };
        await writeState(stateDir, state);
        throw error;
      } finally {
        if (temp) await rm(temp, { force: true });
      }
    }
    return { uploaded, left: queue.length - uploaded };
  } finally {
    await lock.release();
  }
}

/* ── the Archive tab ───────────────────────────────────────────────────── */

/**
 * The upload in flight and how fast it's going: bytes over the last minute of parts, so one slow part doesn't swing it.
 * The speed carries over from clip to clip, so the next one has a speed from its start.
 */
export function progressMeter(now = () => Date.now()) {
  let current = null;
  let samples = [];
  let speed = null;
  return {
    update({ name, size, sent, from }) {
      const at = now();
      if (current?.name !== name || sent < current.sent) samples = [];
      current = { name, size, sent, from };
      samples.push([at, sent]);
      while (samples.length > 2 && at - samples[0][0] > 60_000) samples.shift();
      const [first, latest] = [samples[0], samples.at(-1)];
      if (latest[0] > first[0] && latest[1] > first[1])
        speed = ((latest[1] - first[1]) / (latest[0] - first[0])) * 1000;
    },
    clear() {
      current = null;
      samples = [];
    },
    get current() {
      return current;
    },
    /** Bytes a second, or null before any part has gone up. */
    get speed() {
      return speed;
    },
  };
}

/**
 * What the Archive tab shows: every graded clip with whether it's up, waiting or going up now, today's uploads against
 * the day's limit, why the uploads wait when they do, and the upload in flight with its speed.
 */
export async function footageStatus({
  stateDir,
  config,
  exported = EXPORTED,
  exportsFile = EXPORTS,
  archived = [],
  progress = null,
  speed = null,
  busy = false,
  now = Date.now(),
}) {
  const state = await readState(stateDir);
  const daily = config.footage?.daily ?? DAILY;
  const today = state.days[day(now)] ?? 0;
  const due = await dueClips(state, { exported, exportsFile, archived, now });
  const clips = new Map();
  for (const [name, versions] of Object.entries(state.clips)) {
    const latest = versions.at(-1);
    if (!latest) continue;
    clips.set(name, {
      name,
      title: clipTitle(name),
      size: latest.size,
      from: latest.from,
      state: "up",
      video: latest.video,
      uploadedAt: latest.uploadedAt,
    });
  }
  // A clip graded again since it went up is waiting too, with its earlier grade's video.
  for (const clip of due) {
    const earlier = clips.get(clip.name);
    clips.set(clip.name, {
      name: clip.name,
      title: clipTitle(clip.name),
      size: clip.size,
      from: clip.from,
      state: progress?.name === clip.name ? "uploading" : "due",
      video: earlier?.video ?? null,
      uploadedAt: earlier?.uploadedAt ?? null,
    });
  }
  const all = [...clips.values()];
  const up = all.filter((clip) => clip.state === "up");
  const waiting = all.filter((clip) => clip.state !== "up");
  // Today's uploads are the queue's first clips, as many as the day has room for.
  const todays = due.slice(0, Math.max(0, daily - today));
  const sent = progress?.sent ?? 0;
  const pausedUntil = (state.pausedUntil ?? 0) > now ? state.pausedUntil : null;
  let phase = "limit";
  if (busy) phase = "busy";
  else if (progress) phase = "uploading";
  else if (pausedUntil) phase = "paused";
  else if (!due.length) phase = "done";
  else if (todays.length) phase = "waiting";
  return {
    at: now,
    channel: config.footage?.channel ?? null,
    daily,
    today,
    state: phase,
    pausedUntil,
    lastError: pausedUntil ? state.lastError ?? null : null,
    current: progress ? { ...progress, title: clipTitle(progress.name) } : null,
    speed,
    totals: {
      up: up.length,
      upBytes: total(up),
      due: waiting.length,
      dueBytes: Math.max(0, total(waiting) - sent),
      today: todays.length,
      todayBytes: Math.max(0, total(todays) - (todays.some((clip) => clip.name === progress?.name) ? sent : 0)),
    },
    clips: all.sort((a, b) => b.name.localeCompare(a.name)).slice(0, LISTED),
  };
}

/** Waits `ms`, or less once `signal` aborts. */
const pause = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * One stretch of the Archive tab being open: the helper reports what's up (every `every` while a clip goes up, every
 * `poll` otherwise) and puts clips up until the tab closes. `ask(status)` sends the site the status and answers whether
 * the tab is still open. When it isn't, or the site doesn't answer three times running (so there's no telling), the
 * upload stops mid-part, kept to resume where YouTube says it stopped.
 */
export async function watchedFootage({
  stateDir,
  config,
  ask,
  request = null,
  connect = footageSession,
  exported = EXPORTED,
  exportsFile = EXPORTS,
  log = () => {},
  now = () => Date.now(),
  poll = 10_000,
  every = 5_000,
  wait = pause,
  signal = null,
  chunk,
}) {
  const stop = new AbortController();
  const end = () => stop.abort();
  signal?.addEventListener("abort", end, { once: true });
  const meter = progressMeter(now);
  let busy = false;
  let missed = 0;
  let archived = [];
  if (request)
    archived = await archiveFootage(request, await exportRecords(exportsFile)).catch((error) => {
      log(`Footage archive: couldn't list the Cloudflare archive (${error.message})`);
      return [];
    });
  const report = async () => {
    try {
      const status = await footageStatus({
        stateDir,
        config,
        exported,
        exportsFile,
        archived,
        progress: meter.current,
        speed: meter.speed,
        busy,
        now: now(),
      });
      const { watching } = await ask(status);
      missed = 0;
      if (!watching) stop.abort();
    } catch (error) {
      if (++missed >= 3) {
        log(`Footage archive: the site didn't answer (${error.message}); stopping`);
        stop.abort();
      }
    }
  };
  await report();
  const reporting = (async () => {
    while (!stop.signal.aborted) {
      await wait(meter.current ? every : poll, stop.signal);
      if (!stop.signal.aborted) await report();
    }
  })();
  try {
    while (!stop.signal.aborted) {
      let done;
      try {
        done = await uploadFootage({
          stateDir,
          config,
          request,
          archived,
          connect,
          exported,
          exportsFile,
          log,
          now,
          chunk,
          signal: stop.signal,
          progress: (upload) => meter.update(upload),
        });
      } catch (error) {
        log(`Footage archive: ${error.message}`);
        done = { uploaded: 0 };
      }
      meter.clear();
      busy = Boolean(done.busy);
      if (done.uploaded) log(`Footage archive: ${done.uploaded} clips up, ${done.left} to go`);
      if (stop.signal.aborted) break;
      await report();
      // Nothing more to put up now (all up, today's room taken, a failure to wait out): look again in a while.
      if (!done.uploaded) await wait(poll, stop.signal);
    }
  } finally {
    signal?.removeEventListener("abort", end);
    stop.abort();
    await reporting;
    meter.clear();
  }
  // The tab sees where the uploads stopped when it opens again.
  if (missed < 3) await report();
}

/**
 * The helper's footage uploads: every `poll` it asks the site whether the composer's Archive tab is open (`ask(null)`),
 * and uploads only while it is. `client(config)` is the Cloudflare archive's client; `signal` ends the loop.
 */
export async function watchFootage({
  loadConfig,
  ask,
  client = () => null,
  log = () => {},
  poll = 10_000,
  wait = pause,
  signal = null,
  ...rest
}) {
  // A site that's down fails the same way every 10 seconds: the log says so once, and again when it changes.
  let failing = null;
  while (!signal?.aborted) {
    try {
      const config = await loadConfig();
      if (config.platforms?.includes(FOOTAGE) && (await ask(null)).watching)
        await watchedFootage({ ...rest, config, ask, request: client(config), log, poll, wait, signal });
      failing = null;
    } catch (error) {
      if (error.message !== failing) log(`Footage archive: ${error.message}`);
      failing = error.message;
    }
    await wait(poll, signal);
  }
}
