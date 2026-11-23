import { DEFAULT_LOOKS, normalizeGrade } from "../../../scripts/grade/color.mjs";
import { lookPath } from "../../../scripts/grade/looks.mjs";
import type { ArchivedClip, ArchivedSettings } from "./archive-tab";
import type { LedgerClip } from "./ledger";

/** What the Archive tab shows, kept in its address: the shoot day and the clip open. */
export interface ArchiveView {
  day: string | null;
  clip: string | null;
}
export function readArchiveView(search: string): ArchiveView {
  const params = new URLSearchParams(search);
  const day = params.get("day");
  return {
    day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
    clip: params.get("clip") || null,
  };
}
export function writeArchiveView({ day, clip }: ArchiveView): string {
  const entries: string[] = [];
  if (day) entries.push(`day=${day}`);
  if (clip) entries.push(`clip=${encodeURIComponent(clip)}`);
  return entries.length ? `?${entries.join("&")}` : "";
}

/** A clip's name without its extension: how the ledger and the transcripts know it. */
export const stemOf = (file: string) => file.replace(/\.[^.]+$/, "");
/** The number the camera gave a clip (DJI_20261108122204_0086_D → 0086), or its name. */
export const clipNumber = (file: string) => /^DJI_\d{14}_(\d+)/.exec(file)?.[1] ?? stemOf(file);
/** When a DJI clip was recorded, by its name, for a clip the ledger doesn't know: "12:22:04". */
export const nameTime = (file: string) => /^DJI_\d{8}(\d{2})(\d{2})(\d{2})_/.exec(file)?.slice(1).join(":") ?? null;

/** Where a file of the archive is read, by its hash, named for its type. */
export const fileUrl = (sha256: string, name: string) =>
  `/api/publisher/archive/files/${sha256}/${name
    .replace(/[^\w.-]/g, "_")
    .replace(/^[.]/, "_")
    .slice(-120)}`;

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

/** Where a clip's other copies are, from the ledger, in a line; nothing when Cloudflare's is the only one. */
export function otherCopies(clip: LedgerClip | undefined) {
  if (!clip) return "Not in the ledger";
  const original = [clip.original.camera && "camera", clip.original.mac && "Mac"].filter(Boolean);
  const graded = [
    clip.graded?.mac && "Mac",
    clip.graded?.cloudflare && "Cloudflare",
    clip.graded?.youtube && "YouTube",
  ].filter(Boolean);
  const parts = [];
  if (original.length) parts.push(`Also on ${original.join(", ")}`);
  if (graded.length) parts.push(`graded on ${graded.join(", ")}`);
  if (!parts.length) return "";
  const line = parts.join(" · ");
  return line[0].toUpperCase() + line.slice(1);
}

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
 * The clip's own grade, as the grade app would bake it: its grade from the backed-up grades.json over its look's LUT,
 * with the camera's white balance from its export record when the grade moves it.
 */
export function ownGrade(
  clip: ArchivedClip,
  profile: string | null | undefined,
  settings: ArchivedSettings | null,
  grades: Record<string, Record<string, unknown>> | null,
  exports: Record<string, { cameraKelvin?: number | null }> | null,
): Look {
  if (!profile || !PROFILES[profile]) return { ok: false, why: "The ledger doesn't know its profile yet" };
  if (!settings || !grades) return { ok: false, why: "Reading its grade…" };
  const saved = grades[clip.file];
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
  const shotK = Number(exports?.[clip.file]?.cameraKelvin) || null;
  if ((grade.kelvin !== null || grade.tint) && !shotK)
    return { ok: false, why: "Its white balance needs the camera's, which only its export records" };
  return { ok: true, path, grade: { ...grade, base }, shotK, name: base };
}
