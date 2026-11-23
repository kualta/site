/*
 * What the grade app on the Mac says of its offload (scripts/grade/report.mjs), for the Footage tab's This Mac: each
 * switch's state, speed and time left; what's left for each, and the space on the card and the Mac; the clips passed
 * over, the transcripts and what's kept; and which of the tab's Start and Pause it has taken. It's one small object in
 * the media bucket, checked here field by field and stored as checked, so the tab reads only these fields.
 */

/** The switches the tab shows: Camera → Mac and Mac → Cloudflare. */
export const MAC_LANES = ["copy", "send"] as const;
export type MacLaneName = (typeof MAC_LANES)[number];
export const LANE_NAMES: Record<MacLaneName, string> = { copy: "Camera → Mac", send: "Mac → Cloudflare" };
const STATES = ["idle", "running", "paused", "waiting", "stopping", "done", "stopped", "failed"] as const;
export type MacLaneState = (typeof STATES)[number];

export interface MacLane {
  state: MacLaneState;
  /** Bytes a second, and seconds left at that; null while it isn't moving or hasn't been measured. */
  speed: number | null;
  left: number | null;
  /** What it waits for (`camera`, `network`, `room`, `cloudflare`, `page`, `owner`, or what went wrong), and why. */
  waiting: { for: string; why: string; until: string | null } | null;
  error: string | null;
}
/** A volume's bytes in use, and its size. */
export interface Space {
  used: number;
  total: number;
}
/** The tab's last Start or Pause of a switch that the Mac has taken, by when it was asked, and why it couldn't be done. */
export interface Heard {
  at: number;
  error: string | null;
}
export interface MacReport {
  version: 1;
  /** When the Mac made it. */
  at: string;
  running: boolean;
  lanes: Record<MacLaneName, MacLane>;
  /** The card: plugged in or not, its clips to copy, and its space while it's plugged in. */
  camera: { mounted: boolean; clips: number; bytes: number; space: Space | null };
  /** Movies/Original's clips to send, and the space on the volume that holds it. */
  mac: { clips: number; bytes: number; space: Space | null };
  skipped: { lane: MacLaneName; name: string; why: string }[];
  /** Clips waiting for a transcript, those that failed (and the last one's why), and those made but not yet sent. */
  transcripts: { waiting: number; failed: number; toSend: number; error: string | null };
  /** Shoot days kept out of offload, and how many clips here are kept. */
  kept: { days: string[]; clips: number };
  heard: Record<MacLaneName, Heard | null>;
}

/** Far more than a report with every list at its longest. */
export const MAX_MAC_REPORT = 64 * 1024;
const MOST_SKIPPED = 100;
const MOST_DAYS = 400;

class Invalid extends Error {}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Invalid();
  return value as Record<string, unknown>;
};
/** A whole, or any, number from 0 up to `most`. */
function amount(value: unknown, most = 1e15, whole = false): number {
  const fine = typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= most;
  if (!fine || (whole && !Number.isInteger(value))) throw new Invalid();
  return value;
}
const count = (value: unknown) => amount(value, 1e7, true);
const maybe = <T>(value: unknown, read: (value: unknown) => T): T | null => (value === null ? null : read(value));
/** What a report from before the field was added leaves out, as none. */
const optional = <T>(value: unknown, read: (value: unknown) => T): T | null =>
  value === undefined ? null : maybe(value, read);
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Invalid();
  return value;
}
function text(value: unknown, most = 600): string {
  if (typeof value !== "string" || value.length > most) throw new Invalid();
  return value;
}
function time(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Invalid();
  return value;
}
function oneOf<T extends string>(value: unknown, among: readonly T[]): T {
  if (!among.includes(value as T)) throw new Invalid();
  return value as T;
}
function list<T>(value: unknown, most: number, read: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > most) throw new Invalid();
  return value.map(read);
}

function lane(value: unknown): MacLane {
  const l = object(value);
  const waiting = maybe(l.waiting, (value) => {
    const w = object(value);
    return { for: text(w.for, 40), why: text(w.why), until: maybe(w.until, time) };
  });
  return {
    state: oneOf(l.state, STATES),
    speed: maybe(l.speed, (value) => amount(value, 1e12)),
    left: maybe(l.left, (value) => amount(value, 1e9)),
    waiting,
    error: maybe(l.error, text),
  };
}
function space(value: unknown): Space {
  const s = object(value);
  const [used, total] = [amount(s.used), amount(s.total)];
  if (used > total) throw new Invalid();
  return { used, total };
}
function heard(value: unknown): Heard {
  const h = object(value);
  return { at: amount(h.at), error: maybe(h.error, text) };
}

/** The report as the grade app sent it, with only the fields the tab reads; null if anything in it is amiss. */
export function readMacReport(value: unknown): MacReport | null {
  try {
    const r = object(value);
    if (r.version !== 1) return null;
    const lanes = object(r.lanes);
    const camera = object(r.camera);
    const mac = object(r.mac);
    const transcripts = object(r.transcripts);
    const kept = object(r.kept);
    const asked = r.heard === undefined ? {} : object(r.heard);
    return {
      version: 1,
      at: time(r.at),
      running: flag(r.running),
      lanes: { copy: lane(lanes.copy), send: lane(lanes.send) },
      camera: {
        mounted: flag(camera.mounted),
        clips: count(camera.clips),
        bytes: amount(camera.bytes),
        space: optional(camera.space, space),
      },
      mac: { clips: count(mac.clips), bytes: amount(mac.bytes), space: optional(mac.space, space) },
      skipped: list(r.skipped, MOST_SKIPPED, (value) => {
        const s = object(value);
        return { lane: oneOf(s.lane, MAC_LANES), name: text(s.name, 200), why: text(s.why) };
      }),
      transcripts: {
        waiting: count(transcripts.waiting),
        failed: count(transcripts.failed),
        toSend: count(transcripts.toSend),
        error: maybe(transcripts.error, text),
      },
      kept: { days: list(kept.days, MOST_DAYS, (value) => text(value, 20)), clips: count(kept.clips) },
      heard: { copy: optional(asked.copy, heard), send: optional(asked.send, heard) },
    };
  } catch (error) {
    if (error instanceof Invalid) return null;
    throw error;
  }
}

/** What the owner last asked of a switch from the tab, and when (the site's clock): kept until the next. */
export type LaneWant = "start" | "pause";
export interface LaneAsk {
  want: LaneWant;
  at: number;
}
export type LaneAsks = Partial<Record<MacLaneName, LaneAsk>>;
/** The asks as stored, with any that's amiss left out. */
export function readLaneAsks(value: unknown): LaneAsks {
  const asks: LaneAsks = {};
  if (!value || typeof value !== "object") return asks;
  for (const name of MAC_LANES) {
    const ask = (value as Record<string, Partial<LaneAsk> | undefined>)[name];
    if ((ask?.want === "start" || ask?.want === "pause") && Number.isFinite(ask.at))
      asks[name] = { want: ask.want, at: Number(ask.at) };
  }
  return asks;
}

/**
 * While it offloads the Mac says how it's going at least every 2 minutes, so a report saying a run goes that's older
 * than this is from a Mac that's asleep, off or offline.
 */
export const MAC_STALE = 4 * 60_000;

/** Network speed in the unit an internet plan states it in. */
export function formatRate(bytesPerSecond: number) {
  const mbit = (bytesPerSecond * 8) / 1e6;
  return `${mbit.toFixed(mbit < 10 ? 1 : 0)} Mbit/s`;
}
export function formatDuration(seconds: number) {
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
/** Everything paused from the Footage tab (footage.ts), since when. */
export interface Paused {
  since: number;
}
/** That, in a line. */
export const pausedText = ({ since }: Paused) => `Paused by you · since ${formatWhen(since)}`;

/** A time by the clock, with its day when it isn't today. */
export function formatWhen(ms: number) {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
