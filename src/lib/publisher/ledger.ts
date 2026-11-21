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
  /** Its small picture is in the archive. */
  thumb?: boolean;
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

/** A copy off the Mac and the card: in the Cloudflare archive, or on YouTube (re-encoded, but a copy). */
export const keptAway = (c: LedgerClip) =>
  c.original.cloudflare || Boolean(c.graded?.cloudflare) || Boolean(c.graded?.youtube);
/** Losing the Mac or the card would lose it. */
export const atRisk = (c: LedgerClip) => !keptAway(c);
/** No copy of it left anywhere. */
export const lost = (c: LedgerClip) => !c.original.camera && !c.original.mac && !c.graded?.mac && !keptAway(c);
/** Log footage waiting for its grade (Rec.709 is as shot). */
export const needsGrade = (c: LedgerClip) => c.profile !== "rec709" && !c.graded;

/** The day a clip was recorded, YYYY-MM-DD, or "" when unknown. */
export const dayOf = (c: LedgerClip) => c.recorded?.slice(0, 10) ?? "";

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
 * How much footage is where: originals on the card, originals and graded copies on the Mac and in the archive, and
 * videos on YouTube (re-encoded, so counted, not weighed). An archived graded copy of an earlier grade counts at the
 * current grade's size.
 */
export function storage(clips: LedgerClip[]) {
  const sum = (list: LedgerClip[], size: (c: LedgerClip) => number | null | undefined) =>
    list.reduce((total, c) => total + (size(c) ?? 0), 0);
  const originals = (where: keyof LedgerClip["original"]) => clips.filter((c) => c.original[where]);
  const camera = originals("camera");
  const place = (where: "mac" | "cloudflare") => {
    const kept = originals(where);
    const graded = clips.filter((c) => Boolean(c.graded?.[where]));
    return {
      originals: kept.length,
      graded: graded.length,
      bytes: sum(kept, (c) => c.size) + sum(graded, (c) => c.graded?.size),
    };
  };
  return {
    camera: { clips: camera.length, bytes: sum(camera, (c) => c.size) },
    mac: place("mac"),
    cloudflare: place("cloudflare"),
    youtube: { videos: clips.filter((c) => c.graded?.youtube).length },
  };
}

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
