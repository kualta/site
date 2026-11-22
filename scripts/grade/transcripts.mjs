// What's said in each offloaded clip, transcribed here by Whisper (large-v3-turbo, on this Mac's GPU) so an edit can start
// from the words. A clip's sound is taken from its Mac copy before that goes, and kept in the cache until it's transcribed:
// one clip at a time, in the background, none started while an export runs. Audio left by a restart, or by a Whisper that
// failed, is picked up later. Nothing is ever downloaded: uvx and the model run offline, from their caches.
//
// A transcript is two files, named for the clip: a .vtt to read and search, and a .json with Whisper's segments and every
// word's time. Whisper's times run early on street audio, so cuts still need forced alignment.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { stemOf } from "./ledger.mjs";
import { extractAudio, FFMPEG } from "./media.mjs";

const MODEL = "mlx-community/whisper-large-v3-turbo";
/** Where uvx is: launchd gives the server too short a PATH to find it on. */
const UVX = ["/opt/homebrew/bin/uvx", "/usr/local/bin/uvx", join(homedir(), ".local/bin/uvx")];
/** Far longer than either takes: seconds for a clip's sound, half a minute to transcribe ten minutes of it. */
const AUDIO_LIMIT = 10 * 60_000;
const WHISPER_LIMIT = 60 * 60_000;

const exists = (path, mode = constants.F_OK) =>
  access(path, mode).then(
    () => true,
    () => false,
  );

async function findUvx(override) {
  for (const path of override ? [override] : UVX) if (await exists(path, constants.X_OK)) return path;
  return null;
}

/** Left to its defaults Whisper repeated itself through most of a clip; these settings stop that. */
const whisperArgs = (audio, out) => [
  ...["--offline", "--from", "mlx-whisper", "mlx_whisper", audio],
  ...["--model", MODEL, "--word-timestamps", "True", "--condition-on-previous-text", "False"],
  ...["--hallucination-silence-threshold", "2", "--verbose", "False"],
  ...["--output-format", "json", "--output-dir", out, "--output-name", "transcript"],
];

/** What went wrong, from what uvx or Whisper printed: Whisper skips a file it can't read, and exits as if all went well. */
function complaint(said) {
  const named = /Skipping .* due to (.+)/.exec(said) ?? /^\s*(?:×|error:)\s*(.+)/m.exec(said);
  const lines = said.trim().split(/[\r\n]+/);
  return named?.[1] ?? lines.at(-1);
}

/** Runs Whisper on `audio`, writing to the empty folder `out`; its answer, as it wrote it. */
async function whisper(uvx, audio, out) {
  // Whisper reads audio through ffmpeg, and looks for it on the PATH.
  const path = [dirname(FFMPEG), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? ""].join(delimiter);
  const said = await new Promise((resolve, reject) => {
    const child = spawn(uvx, whisperArgs(audio, out), {
      env: { ...process.env, PATH: path, HF_HUB_OFFLINE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: WHISPER_LIMIT,
    });
    let heard = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        heard = (heard + chunk).slice(-8000);
      });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve(heard);
      else reject(new Error(complaint(heard) || `Whisper ended with ${signal ?? code}`));
    });
  });
  const written = await readFile(join(out, "transcript.json"), "utf8").catch(() => null);
  if (written === null) throw new Error(complaint(said) || "Whisper wrote nothing");
  return written;
}

/** Whisper's JSON: Python writes a number that isn't one as NaN or Infinity, which JSON has no word for. */
export function parseWhisper(text) {
  const stringOrNot = /"[^"\\]*(?:\\.[^"\\]*)*"|\bNaN\b|-?\bInfinity\b/g;
  const result = JSON.parse(text.replace(stringOrNot, (token) => (token[0] === '"' ? token : "null")));
  if (!Array.isArray(result.segments)) throw new Error("Whisper's answer has no segments");
  return result;
}

function stamp(seconds) {
  const ms = Math.max(0, Math.round((seconds ?? 0) * 1000));
  const two = (n) => String(Math.floor(n)).padStart(2, "0");
  const thousandths = String(ms % 1000).padStart(3, "0");
  return `${two(ms / 3_600_000)}:${two((ms / 60_000) % 60)}:${two((ms / 1000) % 60)}.${thousandths}`;
}

/** The segments as WebVTT, each a cue from its first word to its last; empty ones left out. */
export function toVtt(segments) {
  const cues = [];
  for (const { text, start, end, words = [] } of segments) {
    const line = text.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (line) cues.push(`${stamp(words[0]?.start ?? start)} --> ${stamp(words.at(-1)?.end ?? end)}\n${line}\n`);
  }
  return ["WEBVTT\n", ...cues].join("\n");
}

async function writeWhole(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.part`, text);
  await rename(`${path}.part`, path);
}

/**
 * The transcriber. `audio` is the folder clips' sound waits in (`<day>/<file>.m4a`), `dir` the one transcripts are kept in
 * (`<day>/<clip>.vtt` and `.json`), `scratch` one Whisper writes to. `records` reads and updates what's known of each
 * clip, by `<day>/<file>`:
 *
 *   size      the clip's
 *   silent    it has no sound
 *   made      when it was transcribed, with its `language` and how many `words`
 *   sent      when its transcript was filed in the archive
 *
 * `busy()` says when not to start on another clip; `made()` hears each transcript made.
 */
export function transcriber({
  audio,
  dir,
  scratch,
  records,
  uvx = null,
  busy = () => false,
  pause = 2000,
  extract = extractAudio,
  log = console.error,
  made = () => {},
}) {
  const queue = [];
  let current = null;
  let working = false;
  /** Of the clips queued since the last time none were: how far it is, for "Transcribing 3 of 12". */
  const batch = { done: 0, total: 0 };
  /** Clips without a transcript, and why: `key` → `{ job, why }`, with no job when there's no audio to try again. */
  const failed = new Map();
  const logged = new Set();

  const jobOf = (day, name) => ({ key: `${day}/${name}`, day, name });
  const jobAt = (key) => jobOf(key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1));
  const audioFile = ({ day, name }) => join(audio, day, `${name}.m4a`);
  const files = ({ day, name }) =>
    ["vtt", "json"].map((ext) => ({
      path: `transcripts/${stemOf(name)}.${ext}`,
      abs: join(dir, day, `${stemOf(name)}.${ext}`),
    }));
  const kept = async (job) => (await Promise.all(files(job).map(({ abs }) => exists(abs)))).every(Boolean);

  /** Keeps what went wrong, and logs it once however many clips it happens to. */
  function fail(job, why, audioKept) {
    failed.set(job.key, { job: audioKept ? job : null, why });
    if (logged.has(why)) return;
    logged.add(why);
    log(`grade: transcripts: ${job.name}: ${why}`);
  }

  function add(job) {
    if (current?.key === job.key || queue.some(({ key }) => key === job.key)) return;
    failed.delete(job.key);
    if (!current && !queue.length) Object.assign(batch, { done: 0, total: 0 });
    queue.push(job);
    batch.total++;
    void work();
  }

  async function work() {
    if (working) return;
    working = true;
    while (queue.length) {
      if (busy()) {
        await wait(pause);
        continue;
      }
      current = queue.shift();
      try {
        await transcribe(current);
      } catch (error) {
        fail(current, error.message, true);
      }
      current = null;
      batch.done++;
    }
    working = false;
  }

  async function transcribe(job) {
    const sound = audioFile(job);
    // The cache was cleared.
    if (!(await exists(sound))) return;
    const tool = await findUvx(uvx);
    if (!tool) throw new Error("uvx isn't installed, so Whisper can't run");
    // A folder of its own: should a Whisper outlive the server that started it, what it writes lands in no other clip's.
    await mkdir(scratch, { recursive: true });
    const out = await mkdtemp(join(scratch, "whisper-"));
    let result;
    try {
      result = parseWhisper(await whisper(tool, sound, out));
    } finally {
      await rm(out, { recursive: true, force: true });
    }
    const [vtt, json] = files(job);
    const at = new Date().toISOString();
    const about = { clip: job.name, day: job.day, model: MODEL, transcribedAt: at };
    await writeWhole(vtt.abs, toVtt(result.segments));
    await writeWhole(json.abs, `${JSON.stringify({ ...about, ...result })}\n`);
    const words = result.segments.reduce((sum, segment) => sum + (segment.words?.length ?? 0), 0);
    await records.update((all) => {
      all[job.key] = { size: all[job.key]?.size ?? null, made: at, language: result.language ?? null, words };
    });
    await rm(sound, { force: true });
    made();
  }

  return {
    /**
     * Takes a clip's sound from its Mac copy, and queues it, unless that's been done already. Throws only when `signal`
     * cuts it short: sound that can't be taken is said, and is no reason to keep the clip here.
     */
    async take(clip, signal = null) {
      const job = jobOf(clip.day, clip.name);
      try {
        const known = (await records.read())[job.key];
        if (known?.size === clip.size) {
          if (known.silent || (known.made && (await kept(job)))) return;
          if (!known.made && (await exists(audioFile(job)))) return add(job);
        }
        const limit = AbortSignal.timeout(AUDIO_LIMIT);
        const sound = await extract(clip.path, audioFile(job), {
          signal: signal ? AbortSignal.any([signal, limit]) : limit,
        });
        await records.update((all) => {
          all[job.key] = sound ? { size: clip.size } : { size: clip.size, silent: true };
        });
        if (sound) add(job);
      } catch (error) {
        if (signal?.aborted) throw error;
        fail(job, `its sound couldn't be taken: ${error.message}`, false);
      }
    },

    /** Picks up the audio an earlier run of the server left untranscribed. */
    async resume() {
      await rm(scratch, { recursive: true, force: true });
      const all = await records.read();
      for (const day of (await readdir(audio).catch(() => [])).sort())
        for (const file of (await readdir(join(audio, day)).catch(() => [])).sort()) {
          if (!file.endsWith(".m4a")) continue;
          const job = jobOf(day, file.slice(0, -".m4a".length));
          // Cut short as it was being taken, or transcribed already.
          const over = file.startsWith(".") || (all[job.key]?.made && (await kept(job)));
          if (over) await rm(join(audio, day, file), { force: true });
          else add(job);
        }
    },

    /** Tries again the clips that failed and whose audio is still here. */
    retry() {
      logged.clear();
      for (const { job } of [...failed.values()]) if (job) add(job);
    },

    /** The transcripts to send: made, not filed yet, of clips `landed` (by file name, each with its day) has. */
    async ready(landed) {
      const ready = [];
      for (const [key, record] of Object.entries(await records.read())) {
        const job = jobAt(key);
        if (!record.made || record.sent || landed[job.name]?.day !== job.day) continue;
        const found = [];
        for (const file of files(job)) {
          const s = await stat(file.abs).catch(() => null);
          if (s) found.push({ ...file, mtime: Math.round(s.mtimeMs) });
        }
        if (found.length === 2) ready.push({ ...job, files: found });
      }
      return ready;
    },

    async sent(keys) {
      const at = new Date().toISOString();
      if (!keys.length) return;
      await records.update((all) => {
        for (const key of keys) if (all[key]) all[key].sent = at;
      });
    },

    /** The clips whose transcripts the archive holds, by file name. */
    async filed() {
      const all = Object.entries(await records.read());
      return all.filter(([, record]) => record.sent).map(([key]) => jobAt(key).name);
    },

    /** How far it is: the clip it's on, how many wait, how many failed, and why the last of those did. */
    summary: () => ({
      ...batch,
      current: current?.name ?? null,
      waiting: queue.length,
      failed: failed.size,
      error: [...failed.values()].at(-1)?.why ?? null,
    }),
  };
}
