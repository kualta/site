/** The footage ledger as the grade app keeps it (scripts/grade/ledger.mjs), and what the composer reads from it. */

/** A clip's record: when it was recorded, its profile and grade, and where its original and graded copies are. */
export interface LedgerClip {
  name: string;
  recorded: string | null;
  profile: string | null;
  duration: number | null;
  size: number | null;
  original: { camera: boolean; mac: boolean; cloudflare: boolean };
  graded: null | {
    look: string | null;
    at: string | null;
    size: number | null;
    mac: boolean;
    cloudflare: "current" | "earlier" | false;
    youtube: null | { video: string; at: string; current: boolean };
  };
  gradePending: boolean;
  /** Its small picture is in the archive: graded through the grade this keys, or (true) as it was made. */
  thumb?: boolean | string;
  /** Its transcript is in the archive, beside its original. */
  transcript?: boolean;
}
/** A film (an OpenFilm project): the ledger's clips in it, and whether it's on the Mac and in the archive. */
export interface LedgerProject {
  clips: string[];
  local: boolean;
  archived: boolean;
}
export interface Ledger {
  updatedAt: string;
  camera: { name: string; mounted: boolean; seenAt: string | null };
  archiveAt: string | null;
  clips: Record<string, LedgerClip>;
  projects?: Record<string, LedgerProject>;
}
/** What a Pipeline piece's footage is: a film's, or a shoot day's (YYYY-MM-DD) before there's a film. */
export interface FootageLink {
  project?: string;
  day?: string;
}

/**
 * Its original is off the Mac and the card, in the Cloudflare archive. Only an original counts as a copy of a clip:
 * graded copies aren't kept (films render from graded trims made when they're needed), and YouTube's is re-encoded.
 */
export const keptAway = (c: LedgerClip) => c.original.cloudflare;
/** Losing the Mac or the card would lose it. */
export const atRisk = (c: LedgerClip) => !keptAway(c);
/** No original of it left anywhere. */
export const lost = (c: LedgerClip) => !c.original.camera && !c.original.mac && !keptAway(c);
/** Log footage waiting for its grade (Rec.709 is as shot). */
export const needsGrade = (c: LedgerClip) => c.profile !== "rec709" && !c.graded;

/** A clip's small picture, asked for by the grade it went through, so a regraded one isn't the browser's earlier copy. */
export const thumbUrl = (clip: string, thumb: LedgerClip["thumb"]) =>
  `/api/publisher/footage/thumbs/${encodeURIComponent(clip)}.jpg${typeof thumb === "string" ? `?v=${thumb}` : ""}`;

/** The day a clip was recorded, YYYY-MM-DD, or "" when unknown. */
export const dayOf = (c: LedgerClip) => c.recorded?.slice(0, 10) ?? "";

/** The ledger's key for a clip named by its name without the extension, in any case, as an address names it. */
export function ledgerKey(ledger: Ledger, stem: string) {
  if (Object.hasOwn(ledger.clips, stem)) return stem;
  const lower = stem.toLowerCase();
  return Object.keys(ledger.clips).find((key) => key.toLowerCase() === lower);
}

/** A film's number, from its folder's name (017-big-cookie), or null for a name without one. */
export function filmNumber(name: string) {
  const match = /^(\d{3,})-/.exec(name);
  return match ? Number(match[1]) : null;
}

/** The ledger's film made from the piece numbered `number`: the one whose name starts with it. */
export function numberedFilm(number: number | null, ledger: Ledger | null) {
  if (number === null) return undefined;
  return Object.keys(ledger?.projects ?? {}).find((name) => filmNumber(name) === number);
}

/**
 * A piece's footage: the film it was linked to by name, as pieces were before they had numbers; else the film with its
 * number, once the ledger has it; else the shoot day it was linked to before there was a film.
 */
export function pieceFootage(
  number: number | null,
  link: FootageLink | undefined,
  ledger: Ledger | null,
): FootageLink | undefined {
  if (link?.project) return link;
  const film = numberedFilm(number, ledger);
  if (film) return { project: film };
  return link?.day ? link : undefined;
}

/**
 * Each film's post, by the film's name: the post its piece went out as. A film's piece is the one with its number, or
 * one linked to it by name; `get` finds either.
 */
export function filmPosts(
  pieces: { id: string; number: number | null; stage: string; job_id: string | null }[],
  links: Record<string, FootageLink>,
): Map<string, string> {
  const byName = new Map<string, string>();
  const byNumber = new Map<number, string>();
  for (const piece of pieces) {
    if (piece.stage !== "posted" || !piece.job_id) continue;
    const film = links[piece.id]?.project;
    if (film) byName.set(film, piece.job_id);
    if (piece.number !== null) byNumber.set(piece.number, piece.job_id);
  }
  return new (class extends Map<string, string> {
    get(film: string) {
      const number = filmNumber(film);
      return super.get(film) ?? (number === null ? undefined : byNumber.get(number));
    }
  })(byName);
}

/** The clips a piece's footage is, or null when it names none or the film isn't in the ledger yet. */
export function linkedClips(link: FootageLink | undefined, ledger: Ledger | null): LedgerClip[] | null {
  if (!link || !ledger) return null;
  if (link.project) {
    const project = ledger.projects?.[link.project];
    return project ? project.clips.map((key) => ledger.clips[key]).filter(Boolean) : null;
  }
  if (link.day) return Object.values(ledger.clips).filter((c) => dayOf(c) === link.day);
  return null;
}

/** How a piece's footage stands, in a line: "24 clips · 18 graded · 3 at risk". */
export function footageLine(clips: LedgerClip[]) {
  if (!clips.length) return "No clips";
  const parts = [`${clips.length} ${clips.length === 1 ? "clip" : "clips"}`];
  const log = clips.filter((c) => c.profile !== "rec709");
  if (log.length) parts.push(`${log.filter((c) => c.graded).length} graded`);
  const risky = clips.filter(atRisk).length;
  if (risky) parts.push(`${risky} at risk`);
  return parts.join(" · ");
}

/**
 * How much footage is where: originals on the card, on the Mac and in the archive, and videos on YouTube (re-encoded,
 * so counted, not weighed). Graded copies aren't counted: none are kept, and the few in archived films are the films'.
 */
export function storage(clips: LedgerClip[]) {
  const originals = (where: keyof LedgerClip["original"]) => {
    const kept = clips.filter((c) => c.original[where]);
    return { clips: kept.length, bytes: kept.reduce((total, c) => total + (c.size ?? 0), 0) };
  };
  return {
    camera: originals("camera"),
    mac: originals("mac"),
    cloudflare: originals("cloudflare"),
    youtube: { videos: clips.filter((c) => c.graded?.youtube).length },
  };
}

/**
 * What R2 charges a month for each GB the archive keeps footage in: it's stored on Infrequent Access, the archive
 * bucket's default class (wrangler.jsonc), which the Worker's puts and multipart uploads of footage don't override. R2's
 * free 10 GB-month is Standard's only, so none of it is free. developers.cloudflare.com/r2/pricing, November 2026:
 * Infrequent Access $0.01 a GB-month, Standard $0.015. Reads ($0.01 a GB) and requests aren't counted here.
 */
export const ARCHIVE_GB_MONTH = 0.01;
/** What storing `bytes` in the archive costs a month, in dollars. */
export const archiveCost = (bytes: number) => (bytes / 1e9) * ARCHIVE_GB_MONTH;

/** The films each clip is in, by its key. */
export function filmsByClip(ledger: Ledger | null) {
  const films = new Map<string, string[]>();
  for (const [name, project] of Object.entries(ledger?.projects ?? {}))
    for (const key of project.clips) {
      const names = films.get(key) ?? [];
      names.push(name);
      films.set(key, names);
    }
  return films;
}
