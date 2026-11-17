// The footage archive: every graded clip goes up, unlisted, to a YouTube channel of its own. It's a second copy beside
// the Cloudflare archive, one that keeps playing years on. The helper uploads a few a day: clips in ~/Movies/Exported,
// and clips the laptop has since let go of (after their film was posted) from the Cloudflare archive.
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
/** Each request carries this much of a file, so a dropped connection costs one part, not the clip. */
const CHUNK = 64 * 1024 * 1024;
const HOUR = 60 * 60_000;
/** A Pocket 4P clip: the camera's clock in its name, then its number. */
const CLIP = /^DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_(\d{4})_D\.mp4$/i;

const stem = (name) => name.replace(/\.[^.]+$/, "");
const gb = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

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

/** Graded clips of archived projects that no version of has gone up yet: the ones cleaned off the laptop. */
export async function archivedClips(request, state, records = new Map()) {
  const clips = new Map();
  for (const { name: project } of (await request("projects")).projects) {
    for (const file of (await request(`projects/${project}`)).files) {
      const name = file.path.split("/").pop();
      if (!/^(zh\/)?assets\//.test(file.path) || !CLIP.test(name) || state.clips[name] || clips.has(name)) continue;
      const record = records.get(stem(name).toLowerCase());
      clips.set(name, { name, sha256: file.sha256, size: file.size, record, from: "archive", project });
    }
  }
  return [...clips.values()].sort((a, b) => a.name.localeCompare(b.name));
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
 * The clips waiting to go up: the grade app's exports, then, with `request` (the Cloudflare archive's client), clips
 * only the archive still holds.
 */
export async function dueClips(
  state,
  { exported = EXPORTED, exportsFile = EXPORTS, request = null, now = Date.now() } = {},
) {
  const local = (await exportedClips({ exported, exportsFile, now })).filter((clip) => !isUp(state, clip));
  if (!request) return local;
  const archived = await archivedClips(request, state, await exportRecords(exportsFile));
  return [...local, ...archived.filter((clip) => !local.some((l) => l.name === clip.name))];
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

/**
 * The upload calls of a signed-in YouTube session: on the channel `pageId` names, when the Google account holds several,
 * else on the account's own channel.
 */
export async function youtubeSession(cookie, pageId, signal) {
  const yt = await Innertube.create({
    cookie,
    retrieve_player: false,
    on_behalf_of_user: pageId || undefined,
    fetch: (input, init) => fetch(input, { ...init, signal }),
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
 */
export async function uploadVideo(
  client,
  file,
  { title, description },
  {
    session = null,
    save = async () => {},
    log = () => {},
    chunk = CHUNK,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
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
  while (!result) {
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
      });
      if (!response.ok) throw new Error(`YouTube refused part of the upload (${response.status})`);
      offset += length;
      failures = 0;
      if (last) result = await response.json();
      else if (offset - told >= file.size / 4) {
        told = offset;
        log(`${Math.round((offset / file.size) * 100)}%`);
      }
    } catch (error) {
      if (++failures > 5) throw error;
      await wait(5000 * failures);
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
async function download(request, clip, dir) {
  await mkdir(dir, { recursive: true });
  const target = join(dir, clip.name);
  const response = await request(`blobs/${clip.sha256}`, { raw: true });
  const hash = createHash("sha256");
  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk) => hash.update(chunk));
  await pipeline(body, createWriteStream(target));
  if (hash.digest("hex") !== clip.sha256) {
    await rm(target, { force: true });
    throw new Error(`${clip.name} came back from the archive different`);
  }
  return target;
}

/**
 * Puts up the clips due, up to the day's limit: the grade app's exports first, then (with `request`, the Cloudflare
 * archive's client) clips only the archive still holds. A failure stops the run and waits longer each time before
 * the next: half an hour, then an hour, and so on up to a day, which is also how YouTube's daily limit is waited out.
 */
export async function uploadFootage({
  stateDir,
  config,
  request = null,
  connect = footageSession,
  exported = EXPORTED,
  exportsFile = EXPORTS,
  log = () => {},
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
    let queue = await dueClips(state, { exported, exportsFile, now: now() });
    // The archive is only asked when today's room isn't already taken by exports.
    if (request && room > queue.length) queue = await dueClips(state, { exported, exportsFile, now: now(), request });
    if (!queue.length || room <= 0) return { uploaded: 0, left: queue.length };
    const client = await connect({ stateDir, config });
    let uploaded = 0;
    for (const clip of queue.slice(0, room)) {
      const version = clip.sha256 ?? `${clip.size}:${clip.mtime}`;
      let temp = null;
      try {
        const abs = clip.abs ?? (temp = await download(request, clip, join(stateDir, "footage-download")));
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
            log: (progress) => log(`Footage: ${clip.name} ${progress}`),
            chunk,
            wait,
          },
        );
        const kept = clip.from === "archive" ? { sha256: clip.sha256 } : { mtime: clip.mtime };
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
