// Reading an OpenFilm film.html for the clips it cuts from camera footage, and writing those clips' sources again.
//
// A film is HTML (OpenFilm's SPEC): each <section> a track, each <video> or <audio> in it a clip whose `src` is a file
// relative to film.html, with a media fragment for the seconds it plays (`assets/a.mp4#t=12.4,15.1`, `#t=12.4` to the
// file's end, none for all of it), in the file's own seconds as its timestamps run. Nothing here parses HTML in
// general: the start tags of sections, clips and the viewport are found with their attributes, and a source is changed
// by writing over its value where it stands, so every other byte of the film stays as the person and Studio left it.
import { posix } from "node:path";

const { basename, dirname, extname } = posix;

/** A camera clip, by its file name: the Pocket 4P's DJI_<YYYYMMDDhhmmss>_<NNNN>_D, as recorded or as exported. */
export const CAMERA = /^DJI_\d{14}_\d{4}_[A-Z]\.(mp4|mov)$/i;
export const isCameraClip = (path) => CAMERA.test(basename(path));

/** How much of a clip is trimmed for a render beyond what the film plays, each side (s). */
export const HANDLE = 0.5;
/** Two stretches of one clip closer than this (s) once handled are trimmed as one. */
export const JOIN = 2;

const TAGS = new Set(["section", "video", "audio", "iframe", "meta"]);

/** The attributes of a start tag from `at` (just past its name) to its `>`: each value with where it stands. */
function readAttributes(text, at) {
  const attributes = new Map();
  let i = at;
  const skipSpace = () => {
    while (/\s/.test(text[i] ?? "")) i++;
  };
  for (;;) {
    skipSpace();
    if (i >= text.length) return { attributes, end: i };
    if (text[i] === ">") return { attributes, end: i + 1 };
    if (text.startsWith("/>", i)) return { attributes, end: i + 2 };
    const name = /^[^\s=/>]+/.exec(text.slice(i, i + 200))?.[0];
    if (!name) {
      i++;
      continue;
    }
    i += name.length;
    skipSpace();
    if (text[i] !== "=") {
      attributes.set(name.toLowerCase(), { value: "", start: i, end: i });
      continue;
    }
    i++;
    skipSpace();
    const quote = text[i] === '"' || text[i] === "'" ? text[i] : null;
    const start = quote ? i + 1 : i;
    let end = start;
    if (quote) {
      end = text.indexOf(quote, start);
      if (end === -1) end = text.length;
      i = end + 1;
    } else {
      while (end < text.length && !/[\s>]/.test(text[end])) end++;
      i = end;
    }
    attributes.set(name.toLowerCase(), { value: decode(text.slice(start, end)), start, end });
  }
}

const ENTITIES = { amp: "&", quot: '"', apos: "'", "#39": "'", lt: "<", gt: ">" };
const decode = (value) => value.replace(/&(amp|quot|apos|#39|lt|gt);/g, (_, name) => ENTITIES[name]);
const encode = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** The start and end tags that matter, in order, skipping comments and what's inside <style> and <script>. */
function tags(text) {
  const found = [];
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    if (text.startsWith("<!--", lt)) {
      const close = text.indexOf("-->", lt + 4);
      i = close === -1 ? text.length : close + 3;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][\w-]*)/.exec(text.slice(lt, lt + 40));
    if (!m) {
      i = lt + 1;
      continue;
    }
    const name = m[2].toLowerCase();
    if (m[1]) {
      if (name === "section") found.push({ name, close: true, start: lt });
      i = lt + m[0].length;
      continue;
    }
    const { attributes, end } = readAttributes(text, lt + m[0].length);
    if (TAGS.has(name)) found.push({ name, attributes, start: lt, end });
    if (name === "style" || name === "script") {
      const close = lower.indexOf(`</${name}`, end);
      i = close === -1 ? text.length : close;
    } else i = end;
  }
  return found;
}

const number = (value, fallback) => {
  const n = Number(value);
  return value != null && value !== "" && Number.isFinite(n) ? n : fallback;
};

/** `a.mp4#t=12.4,15.1` → its file and the seconds it plays: `{ in, out }` (out null to the end), or null for all. */
export function splitSource(src) {
  const hash = src.indexOf("#");
  const file = hash === -1 ? src : src.slice(0, hash);
  const fragment = hash === -1 ? "" : src.slice(hash + 1);
  const t = /(?:^|&)t=(?:npt:)?([\d.]*)(?:,([\d.]*))?(?:&|$)/.exec(fragment);
  if (!t) return { file, time: null };
  const from = number(t[1], 0);
  const to = t[2] ? number(t[2], null) : null;
  return { file, time: { in: from, out: to } };
}

/**
 * The film's frame and every <video> and <audio> clip, in order: its tag, its file (`path`, decoded, from film.html's
 * folder), the seconds it plays (`time`, or null for all), `at`, `speed`, whether it's seen or heard at all, and where
 * its `src` stands in the text (`span`). `pages` are its <iframe> sources.
 */
export function readFilm(text) {
  let stage = { w: 1920, h: 1080 };
  let track = null;
  const clips = [];
  const pages = [];
  for (const tag of tags(text)) {
    if (tag.name === "section") {
      if (tag.close) track = null;
      else track = { hidden: tag.attributes.has("hidden"), muted: tag.attributes.has("muted") };
      continue;
    }
    const a = tag.attributes;
    if (tag.name === "meta") {
      if (a.get("name")?.value.toLowerCase() !== "viewport") continue;
      const content = a.get("content")?.value ?? "";
      const w = /width\s*=\s*(\d+)/.exec(content);
      const h = /height\s*=\s*(\d+)/.exec(content);
      if (w && h) stage = { w: Number(w[1]), h: Number(h[1]) };
      continue;
    }
    const src = a.get("src");
    if (!src) continue;
    if (tag.name === "iframe") {
      pages.push(splitSource(src.value).file);
      continue;
    }
    const { file, time } = splitSource(src.value);
    let path;
    try {
      path = posix.normalize(decodeURI(file));
    } catch {
      path = posix.normalize(file);
    }
    const disabled = a.has("disabled");
    const hidden = Boolean(track?.hidden);
    const volume = number(a.get("volume")?.value, 1);
    const silent = a.has("muted") || volume === 0 || Boolean(track?.muted);
    clips.push({
      tag: tag.name,
      id: a.get("id")?.value ?? null,
      src: src.value,
      file,
      path,
      time,
      at: number(a.get("at")?.value, 0),
      speed: number(a.get("speed")?.value, 1),
      // A video is seen unless it or its track is off; a sound is heard unless it's silent as well.
      used: !disabled && !hidden && (tag.name === "video" || !silent),
      span: { start: src.start, end: src.end },
    });
  }
  return { stage, clips, pages };
}

/** Writes new sources over clips' old ones: `changes` maps a clip's `span.start` to its new src. */
export function writeSources(text, changes) {
  let out = "";
  let at = 0;
  for (const [start, { end, src }] of [...changes.entries()].sort(([a], [b]) => a - b)) {
    out += text.slice(at, start) + encode(src);
    at = end;
  }
  return out + text.slice(at);
}

/** A time as film.html writes it: seconds to the millisecond, no trailing zeros. */
export const seconds = (ms) => String(Math.round(ms) / 1000);

/**
 * The stretches of one camera clip a film plays, each widened by `handle` on both sides within the clip's length, and
 * joined where they touch or come within `join` of each other: `[{ start, end, uses }]`, `uses` the clips of the film
 * each one serves. `duration` is the clip's length, for clips that play to its end.
 */
export function stretches(uses, duration, { handle = HANDLE, join = JOIN } = {}) {
  const spans = uses
    .map((use) => {
      const from = use.time?.in ?? 0;
      const to = use.time?.out ?? duration;
      return { start: Math.max(0, from - handle), end: Math.min(duration, Math.max(from, to) + handle), use };
    })
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const span of spans) {
    const last = out.at(-1);
    if (last && span.start <= last.end + join) {
      last.end = Math.max(last.end, span.end);
      last.uses.push(span.use);
    } else out.push({ start: span.start, end: span.end, uses: [span.use] });
  }
  return out.map((s) => ({ start: round3(s.start), end: round3(s.end), uses: s.uses }));
}

const round3 = (s) => Math.round(s * 1000) / 1000;

/**
 * Which frame of a file a moment shows, as OpenFilm picks it: the last frame begun a millisecond after the moment, its
 * times to the microsecond (src/host.mjs SEEK_INSIDE_FRAME, src/direct.mjs). Frames are `rate` ({ num, den }) apart
 * from `first`.
 */
export function frameAt(moment, rate, first = 0) {
  const asked = Math.floor((moment + 0.001) * 1e6 + 1e-3);
  const begins = (k) => Math.round((first + (k * rate.den) / rate.num) * 1e6);
  let k = Math.floor(((asked / 1e6 - first) * rate.num) / rate.den);
  while (k > 0 && begins(k) > asked) k--;
  while (begins(k + 1) <= asked) k++;
  return k;
}

/**
 * How far a clip's seconds move, in ms, when it plays from a trim: a frame of the original at T is at
 * T - actualStart + `first` in the trim (`first` its first frame's own time). Times are written to the millisecond, so
 * the move is rounded; for a video it's then nudged a millisecond either way if rounding would show the frame beside
 * the one the original shows at the clip's first moment. Takes the clip's in-point (s), the trim, and the frame rate
 * both share (or null).
 */
export function moveFor(inPoint, trim, rate, video) {
  const base = Math.round((trim.first - trim.actualStart) * 1000);
  if (!video || !rate) return base;
  // Only when the trim starts on a frame of the original can a frame of one be told in the other.
  const startFrame = (trim.actualStart * rate.num) / rate.den;
  if (Math.abs(startFrame - Math.round(startFrame)) > 0.01) return base;
  const wanted = frameAt(inPoint, rate) - Math.round(startFrame);
  for (const move of [base, base + 1, base - 1]) {
    const moment = (Math.round(inPoint * 1000) + move) / 1000;
    if (frameAt(moment, rate, trim.first) === wanted) return move;
  }
  return base;
}

/** A trim's file name in a render copy: the clip's own, `-trim<k>` before its extension. */
export function trimName(clipPath, k, ext) {
  return posix.join(dirname(clipPath), `${basename(clipPath, extname(clipPath))}-trim${k}${ext || extname(clipPath)}`);
}
