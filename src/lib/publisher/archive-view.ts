import { DEFAULT_LOOKS, normalizeGrade } from "../../../scripts/grade/color.mjs";
import { lookPath } from "../../../scripts/grade/looks.mjs";
import type { ArchivedClip, ArchivedSettings } from "./archive-tab";
import type { LedgerClip } from "./ledger";

/**
 * What the Footage tab has open, kept in its address: the player on a clip, by its name without the extension, and the
 * shoot day the cloud files it under when the address says (an Archive tab link does; otherwise the ledger knows); or a
 * film's page, by its name (013-maybe-later).
 */
export interface FootageView {
  clip: string | null;
  day: string | null;
  project: string | null;
}
const isFilm = (name: string) => /^[\w][\w.-]{0,119}$/.test(name) && !name.startsWith("_");
export function readFootageView(search: string): FootageView {
  const params = new URLSearchParams(search);
  const clip = params.get("clip") || null;
  const day = params.get("day");
  const project = clip ? null : params.get("project");
  return {
    clip,
    day: clip && day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
    project: project && isFilm(project) ? project : null,
  };
}
export function writeFootageView({ clip, day, project }: FootageView): string {
  if (clip) return `?clip=${encodeURIComponent(clip)}${day ? `&day=${day}` : ""}`;
  return project ? `?project=${encodeURIComponent(project)}` : "";
}

/** A clip's name without its extension: how the ledger and the transcripts know it. */
export const stemOf = (file: string) => file.replace(/\.[^.]+$/, "");
/** The number the camera gave a clip (DJI_20261108122204_0086_D → 0086), or its name. */
export const clipNumber = (file: string) => /^DJI_\d{14}_(\d+)/.exec(file)?.[1] ?? stemOf(file);
/** When a DJI clip was recorded, by its name, for a clip the ledger doesn't know: "12:22:04". */
export const nameTime = (file: string) => /^DJI_\d{8}(\d{2})(\d{2})(\d{2})_/.exec(file)?.slice(1).join(":") ?? null;
/** A shoot day's clip by its name without the extension, in any case, as the ledger keys it. */
export const archivedClip = (clips: ArchivedClip[], stem: string) =>
  clips.find((clip) => stemOf(clip.file).toLowerCase() === stem.toLowerCase());

/** Where a file of the archive is read, by its hash, named for its type. */
export const fileUrl = (sha256: string, name: string) =>
  `/api/publisher/archive/files/${sha256}/${name
    .replace(/[^\w.-]/g, "_")
    .replace(/^[.]/, "_")
    .slice(-120)}`;

/**
 * Where the grade app listens on the Mac (scripts/grade/server.mjs). The Grade tab frames it, and the Footage tab's
 * player streams the clips it has from it, free and at once.
 */
export const GRADE_APP = "http://127.0.0.1:4777";
/** How long the grade app gets to answer before the player takes it that this browser can't reach it. */
export const MAC_PATIENCE = 8000;

/** What the grade app says of a clip on the Mac or the camera's card (`GET /footage/<clip>`). */
export interface MacClip {
  name: string;
  on: "mac" | "camera";
  /** The shoot day it files the clip under. */
  day: string;
  size: number;
  recorded: string | null;
  profile: string | null;
  duration: number;
  cameraKelvin: number | null;
  /** Its grade as saved on the Mac, fresher than the backup's; null when it has none. */
  grade: Record<string, unknown> | null;
  transcript: boolean;
}
/** Where the grade app serves a clip it has: what it is, its original, or its transcript; or shows it in Finder. */
export const macUrl = (stem: string, part?: "original" | "transcript.vtt" | "reveal") =>
  `${GRADE_APP}/footage/${encodeURIComponent(stem)}${part ? `/${part}` : ""}`;

/**
 * Open in Finder: the grade app on the Mac shows a clip it has on the Mac or the card selected in Finder. Null once it
 * has, else why not, in a few words.
 */
export async function revealOnMac(stem: string): Promise<string | null> {
  try {
    const response = await fetch(macUrl(stem, "reveal"), { method: "POST", signal: AbortSignal.timeout(MAC_PATIENCE) });
    if (response.ok) return null;
    if (response.status === 404) return "Not on the Mac or the camera";
    return `The Mac answered ${response.status}`;
  } catch {
    return "Can't reach the Mac from here";
  }
}

/** The clip the player plays, from the grade app on the Mac (the card's clips through it too) or from the cloud. */
export interface ClipSource {
  from: "mac" | "cloud";
  /** The original's file name. */
  file: string;
  video: string;
  /** Its transcript's address, when one is filed where it plays from. */
  vtt: string | null;
  size: number;
  day: string;
}
export const macSource = (stem: string, clip: MacClip): ClipSource => ({
  from: "mac",
  file: clip.name,
  video: macUrl(stem, "original"),
  vtt: clip.transcript ? macUrl(stem, "transcript.vtt") : null,
  size: clip.size,
  day: clip.day,
});
export const cloudSource = (clip: ArchivedClip, day: string): ClipSource => ({
  from: "cloud",
  file: clip.file,
  video: fileUrl(clip.sha256, clip.file),
  vtt: clip.vtt ? fileUrl(clip.vtt, `${stemOf(clip.file)}.vtt`) : null,
  size: clip.size,
  day,
});

/**
 * Where to look for a clip's original, nearest first: the grade app, for one on the Mac or the card, then the cloud.
 * A clip the ledger doesn't know is looked for in both, in the cloud only on a day its address names.
 */
export function placesOf(record: LedgerClip | undefined, day: string) {
  if (!record) return { mac: true, cloud: Boolean(day) };
  return { mac: record.original.mac || record.original.camera, cloud: record.original.cloudflare };
}

type Grades = Record<string, Record<string, unknown>>;
type Records = Record<string, { cameraKelvin?: number | null }>;
/**
 * The grades and export records a clip's own grade is composed from: the backup's, but for a clip the grade app has,
 * the Mac's, which are fresher: its grade as saved there, and the camera's white balance from its file.
 */
export function withMac(grades: Grades | null, records: Records | null, mac: MacClip | null) {
  if (!mac) return { grades, records };
  const { [mac.name]: _, ...others } = grades ?? {};
  return {
    grades: grades && (mac.grade ? { ...others, [mac.name]: mac.grade } : others),
    records: { ...records, [mac.name]: { cameraKelvin: mac.cameraKelvin } },
  };
}

/** What looking for a clip found: the grade app didn't answer or hasn't it; the cloud hasn't it, or couldn't be read. */
export interface Missed {
  mac?: "away" | "gone";
  cloud?: "gone" | "unread";
}
/** Why a clip found nowhere it was looked for can't play here, and whether looking again could help. */
export function unplayable(record: LedgerClip | undefined, missed: Missed): { why: string; again: boolean } {
  if (missed.cloud === "unread") return { why: "Couldn't read it from the archive.", again: true };
  const camera = Boolean(record?.original.camera && !record.original.mac);
  if (missed.mac === "away") {
    if (!record) return { why: "Open this page on the Mac to look for it there.", again: true };
    if (camera) return { why: "It's on the camera. Plug it into the Mac, and open this page there.", again: true };
    return {
      why: "It's on the Mac. Open this page there, and allow local network access if Chrome asks.",
      again: true,
    };
  }
  if (missed.mac === "gone" && camera) return { why: "It's on the camera, which isn't plugged in.", again: true };
  if (missed.mac === "gone" && record?.original.mac) return { why: "It isn't on the Mac any more.", again: true };
  if (missed.cloud === "gone") return { why: "It isn't in the cloud.", again: false };
  if (missed.mac === "gone") return { why: "It isn't on the Mac or the camera.", again: true };
  return { why: "No copy of it is left.", again: false };
}

/** A film's name as OpenFilm projects are named, split: its number and the rest (013-maybe-later → 013, maybe-later). */
export function filmParts(name: string): { number: string | null; slug: string } {
  const match = /^(\d+)-(.+)$/.exec(name);
  return match ? { number: match[1], slug: match[2] } : { number: null, slug: name };
}
/** A film's name to read: "013 · maybe-later". */
export function filmLabel(name: string) {
  const { number, slug } = filmParts(name);
  return number ? `${number} · ${slug}` : slug;
}

/** A film's manifest as the archive keeps it (archive.ts's Manifest), as far as its page reads it. */
export interface FilmManifest {
  archivedAt: string;
  files: { path: string; sha256: string; size: number }[];
}
/** A video a film made: its render, its Chinese render, or another exported beside them. */
export interface FilmOutput {
  name: string;
  file: string;
  sha256: string;
  size: number;
}
/**
 * The videos a film made, from its manifest: those at the top of its folder, beside film.html, where OpenFilm writes its
 * render (`<name>.mp4`) and the Chinese render (`<name>-zh.mp4`). The clips it's cut from are in assets/.
 */
export function filmOutputs(film: string, manifest: FilmManifest): FilmOutput[] {
  const named: Record<string, string> = { [`${film}.mp4`]: "Render", [`${film}-zh.mp4`]: "Chinese" };
  const rank = (file: string) => ({ Render: 0, Chinese: 1 })[named[file]] ?? 2;
  return manifest.files
    .filter(({ path, sha256 }) => /^[^/]+\.(mp4|mov|m4v|webm)$/i.test(path) && /^[0-9a-f]{64}$/.test(sha256))
    .map(({ path, sha256, size }) => ({ name: named[path] ?? path, file: path, sha256, size }))
    .sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file));
}

/** A size as Finder shows it. */
export function fileSize(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e7) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** A duration as a player shows it: 0:42, 12:05, 1:02:09. */
export function clock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export const PROFILES: Record<string, string> = { dlog2: "D-Log2", dlog: "D-Log", hlg: "HLG", rec709: "Rec.709" };

/** A transcript's lines, from its WebVTT: when each starts and ends, in seconds, and what's said. */
export interface Cue {
  start: number;
  end: number;
  text: string;
}
const seconds = (stamp: string) => {
  const parts = stamp.split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
};
export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) continue;
    const [from, to] = lines[at].split("-->").map((side) => side.trim().split(/\s+/)[0]);
    const words = lines
      .slice(at + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (words) cues.push({ start: seconds(from), end: seconds(to), text: words });
  }
  return cues;
}

/** The line being said at `time`, by its index, or -1. */
export const cueAt = (cues: Cue[], time: number) => cues.findIndex((cue) => time >= cue.start && time < cue.end);

/** What the "Look" choice can show a clip as, or why it can't: a LUT from the settings backup, and what to do with it. */
export type Look =
  | { ok: true; path: string | null; grade: Record<string, unknown> | null; shotK: number | null; name: string }
  | { ok: false; why: string };

const backedUp = (settings: ArchivedSettings, profile: string, id: string) =>
  settings.files[lookPath(profile, id)] ? lookPath(profile, id) : null;

/** The clip's profile through the default look its profile has, as the grade app starts an ungraded clip. */
export function defaultLook(profile: string | null | undefined, settings: ArchivedSettings | null): Look {
  if (!profile || !PROFILES[profile]) return { ok: false, why: "The ledger doesn't know its profile yet" };
  if (profile === "rec709") return { ok: false, why: "Rec.709 is graded as shot" };
  if (!settings) return { ok: false, why: "Reading the looks…" };
  for (const id of DEFAULT_LOOKS as readonly string[]) {
    const path = backedUp(settings, profile, id);
    if (path) return { ok: true, path, grade: null, shotK: null, name: id };
  }
  return { ok: false, why: "The grade app hasn't backed up a default look yet" };
}

/**
 * The clip's own grade, by its file's name, as the grade app would bake it: its grade from the backed-up grades.json over its look's LUT,
 * with the camera's white balance from its export record when the grade moves it.
 */
export function ownGrade(
  file: string,
  profile: string | null | undefined,
  settings: ArchivedSettings | null,
  grades: Record<string, Record<string, unknown>> | null,
  exports: Record<string, { cameraKelvin?: number | null }> | null,
): Look {
  if (!profile || !PROFILES[profile]) return { ok: false, why: "The ledger doesn't know its profile yet" };
  if (!settings || !grades) return { ok: false, why: "Reading its grade…" };
  const saved = grades[file];
  if (!saved) return { ok: false, why: "It hasn't been graded" };
  const grade = normalizeGrade(saved) as Record<string, unknown> & {
    base: string | null;
    kelvin: number | null;
    tint: number;
  };
  let base = grade.base;
  if (!base) {
    const first = (DEFAULT_LOOKS as readonly string[]).find((id) => backedUp(settings, profile, id));
    if (!first) return { ok: false, why: "Its look isn't backed up yet" };
    base = first;
  }
  const path = base === "none" ? null : backedUp(settings, profile, base);
  if (base !== "none" && !path) return { ok: false, why: "Its look isn't backed up yet" };
  // Moving the white balance starts from the camera's, which only an export records.
  const shotK = Number(exports?.[file]?.cameraKelvin) || null;
  if ((grade.kelvin !== null || grade.tint) && !shotK)
    return { ok: false, why: "Its white balance needs the camera's, which only its export records" };
  return { ok: true, path, grade: { ...grade, base }, shotK, name: base };
}
