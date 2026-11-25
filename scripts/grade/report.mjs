// Tells the composer's Footage tab how the offload stands, so it can show it as numbers under This Mac: each switch's
// state, speed, time left and what it waits for; what's on the card to copy and on this Mac to send, and the space each
// has; the clips passed over; the transcripts; what's kept; and which of the tab's Start and Pause it has taken
// (asks.mjs). It goes to the site (`helper/footage/mac`, on the crossposter helper's pairing), which keeps it as one small
// object. Nothing in it counts from when a run started: the app runs on, so it says how things stand.
//
// What the tab shows goes as soon as it changes: the card plugged in or pulled out (mount.mjs), a switch starting,
// stopping, finishing or waiting, a clip starting or done, a transcript made, the kept list, a Start or Pause taken; at
// most one every 2 seconds. Numbers that only move (bytes, speed, time left, space) go every 4 seconds while a run goes
// and the Footage tab is open (every 30 while none does), and with it closed every 30 seconds while a run goes and every
// 10 minutes while none does. At those last paces it's said again even when nothing changed, so the tab can tell a Mac
// that's asleep, off or offline from one that's waiting; each report says its pace, for the tab to go by. One that
// doesn't get there is tried again in 5 seconds, then twice as long each time up to a minute.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const REPORT_EVERY = {
  /** At most this long between reports while a run goes, and while none does. */
  running: 30_000,
  idle: 10 * 60_000,
  /** How often numbers that only move go while a run goes and the Footage tab is open. */
  watched: 4_000,
  /** The least between two reports, however fast what the tab shows changes. */
  least: 2_000,
  /** The first wait to try one that didn't get there again, and the longest. */
  retry: 5_000,
  retryMost: 60_000,
};
/** The lists are cut short well inside what the site takes. */
const MOST_SKIPPED = 50;
/** More than either switch ever has in flight. */
const MOST_IN_FLIGHT = 4;
const MOST_DAYS = 300;
const cut = (text, most) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);
const iso = (ms) => new Date(ms).toISOString();
/** A volume's space with what's used rounded to `step`, so a little written or deleted isn't a change. */
function space(volume, step) {
  if (!volume) return null;
  const total = Math.max(0, volume.total);
  return { used: Math.min(total, Math.round(Math.max(0, volume.used) / step) * step), total };
}

/** What a lane is doing, as the tab says it. */
function laneState(lane) {
  if (!lane || (!lane.on && !lane.finished && !lane.error)) return "idle";
  if (lane.on) {
    if (lane.mode !== "on") return "stopping";
    // No Grade page open, or everything paused from the Footage tab.
    if (["page", "owner"].includes(lane.waiting?.for)) return "paused";
    return lane.waiting ? "waiting" : "running";
  }
  return lane.error ? "failed" : lane.finished;
}

/** A lane as the tab shows it; `sent` is its bytes through with what's in flight, `speed` how fast they go. */
function laneReport(lane, sent, speed) {
  const state = laneState(lane);
  const moving = state === "running" && speed > 0;
  const left = moving ? Math.max(0, lane.bytes - sent) / speed : null;
  const { waiting } = lane ?? {};
  return {
    state,
    speed: moving ? Math.round(speed) : null,
    left: left === null ? null : Math.round(left),
    waiting: waiting
      ? { for: cut(String(waiting.for), 40), why: cut(String(waiting.why ?? ""), 600), until: waiting.until ?? null }
      : null,
    error: lane?.error ? cut(lane.error, 600) : null,
    // The clips in flight (the card's one, or the uploads together), each with how far it's got.
    current: [lane?.current ?? []]
      .flat()
      .filter(Boolean)
      .slice(0, MOST_IN_FLIGHT)
      .map(({ name, sent, size }) => ({
        name: cut(String(name), 200),
        sent: Math.max(0, Math.round(sent ?? 0)),
        size: Math.max(0, Math.round(size ?? 0)),
      })),
  };
}

/**
 * What the tab shows of a run (offload.mjs's `state`) but the numbers that only move: cheap enough to look at every
 * second, so a change goes at once.
 */
export function runShape(run) {
  if (!run) return null;
  const lane = (it) => [
    laneState(it),
    it.waiting?.for ?? null,
    it.waiting?.why ?? null,
    it.waiting?.until ?? null,
    it.error ?? null,
    it.done ?? 0,
    it.skipped?.length ?? 0,
    [it.current ?? []].flat().map((clip) => clip?.name),
  ];
  return [Boolean(run.running), lane(run.copy), lane(run.send)];
}

/**
 * The report, from `/api/offload`'s summary, with each volume's `space` (`{ used, total }`, the card's null while it's
 * unplugged). `copySpeed` is how fast clips come off the card, measured between reports; `heard` the tab's Start and
 * Pause taken (asks.mjs); `every` the longest until the next report. The Mac's space is said in whole GB, so it doesn't
 * count as a change every time any app writes a file; the card's, which only the offload writes, in tenths.
 */
export function macReport(summary, { now, copySpeed = null, heard = {}, every = null }) {
  const run = summary.run;
  const copied = run ? run.copy.doneBytes + (run.copy.current?.sent ?? 0) : 0;
  const skipped = run
    ? ["copy", "send"].flatMap((lane) =>
        (run[lane]?.skipped ?? []).map(({ name, why }) => ({
          lane,
          name: cut(String(name), 200),
          why: cut(String(why), 600),
        })),
      )
    : [];
  const { camera, mac, transcripts, kept } = summary;
  const took = (lane) =>
    heard[lane] ? { at: heard[lane].at, error: heard[lane].error && cut(heard[lane].error, 600) } : null;
  return {
    version: 1,
    at: iso(now),
    every,
    running: Boolean(run?.running),
    lanes: {
      copy: laneReport(run?.copy, copied, copySpeed),
      send: laneReport(run?.send, run?.sentBytes ?? 0, run?.speed ?? null),
    },
    camera: { mounted: camera.mounted, clips: camera.clips, bytes: camera.bytes, space: space(camera.space, 1e8) },
    mac: { clips: mac.clips, bytes: mac.bytes, space: space(mac.space, 1e9) },
    skipped: skipped.slice(0, MOST_SKIPPED),
    transcripts: {
      waiting: transcripts.waiting + (transcripts.current ? 1 : 0),
      failed: transcripts.failed,
      toSend: transcripts.toSend,
      error: transcripts.error ? cut(transcripts.error, 600) : null,
    },
    kept: { days: kept.days.slice(0, MOST_DAYS), clips: kept.count },
    heard: { copy: took("copy"), send: took("send") },
  };
}

/**
 * The site's helper API on the crossposter helper's pairing: `call(path, json)` asks `helper/<path>` (a POST of `json`
 * when there's one) and says its answer, or null when this Mac isn't paired.
 */
export function pairedSite(publisherDir, fetcher = fetch) {
  return async (path, json) => {
    let config;
    try {
      config = JSON.parse(await readFile(join(publisherDir, "config.json"), "utf8"));
    } catch {
      return null;
    }
    if (!config.origin || !config.token) return null;
    const response = await fetcher(`${config.origin}/api/publisher/helper/${path}`, {
      method: json === undefined ? "GET" : "POST",
      // Without a type Astro refuses a POST as a cross-site form submission.
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(json === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `The site answered ${response.status}`);
    return data;
  };
}

/**
 * Looks at the offload every second, cheaply (`running()`, and `shape()`: what the tab shows but the numbers that only
 * move), and at its summary (`summary()`, `/api/offload`'s, with `space`) only when a report could go: then sends it with
 * `post(report)` if it changed, or if the pace says it's due again. `watched()` says whether the Footage tab is open,
 * `heard()` the tab's Start and Pause taken. `post` says the site's answer, or null when there's nowhere to send it. A
 * look that sends nothing does `between()` instead (the asks' check, pause.mjs), so the site is asked at most once a
 * look. Says `{ start, stop, tick, soon }`: `tick` is one look, for tests; `soon()` has the next look go whatever the
 * pace, as one does after a Start or Pause, or the card coming or going.
 */
export function macReporter({
  summary,
  running,
  shape = () => null,
  watched = () => false,
  between = async () => {},
  post,
  heard = () => ({}),
  every = REPORT_EVERY,
  clock = Date.now,
  log = (line) => console.error(`grade: report: ${line}`),
}) {
  const paces = { ...REPORT_EVERY, ...every };
  /** What the site has: when it was sent, and what it said (without its time). */
  let sent = { at: Number.NEGATIVE_INFINITY, key: null };
  /** When a report was last tried, for the least between two. */
  let triedAt = Number.NEGATIVE_INFINITY;
  /** The last look at the summary: when, and the shape and run it went with. */
  let looked = { at: Number.NEGATIVE_INFINITY, shape: undefined, running: false };
  /** The bytes copied off the card at the looks of the last 30 seconds, for how fast they come. */
  let copied = [];
  /** While reports fail: why, how long the wait is, and when the next try goes. */
  let failing = null;
  let busy = false;
  let hurry = false;
  let timer = null;

  function copySpeed(summary, now) {
    const copy = summary.run?.copy;
    const bytes = copy?.on ? copy.doneBytes + (copy.current?.sent ?? 0) : null;
    if (bytes === null) {
      copied = [];
      return null;
    }
    copied.push([now, bytes]);
    while (copied.length > 2 && now - copied[0][0] > 30_000) copied.shift();
    const [[from, was], [to, is]] = [copied[0], copied.at(-1)];
    // Over a second or two, a clip's bytes come too unevenly to say.
    if (to - from < 2_000) return null;
    const speed = ((is - was) / (to - from)) * 1000;
    return speed >= 0 ? speed : null;
  }

  /** Sends a report if one's due, saying whether the site was asked. */
  async function report(now) {
    const going = running();
    const look = shape();
    // A run going is said at least every 30 seconds, none every 10 minutes. Numbers that only move go that often too,
    // unless the tab is open: then every 4 seconds in a run, and every 30 without one.
    const pace = going ? paces.running : paces.idle;
    const moving = Math.min(pace, watched() ? (going ? paces.watched : paces.running) : pace);
    // While reports fail, the next goes when its wait is up, with whatever's changed meanwhile.
    if (failing && now < failing.at) return false;
    // What the tab shows changed, or a Start or Pause was taken: it goes now, if it's been long enough since the last.
    const urgent = hurry || failing !== null || look !== looked.shape || going !== looked.running;
    if (urgent ? now - triedAt < paces.least : now - looked.at < moving) return false;
    hurry = false;
    looked = { at: now, shape: look, running: going };
    let report;
    try {
      const current = await summary();
      report = macReport(current, { now, copySpeed: copySpeed(current, now), heard: heard(), every: pace });
    } catch (error) {
      failed(error, now);
      return false;
    }
    const key = JSON.stringify({ ...report, at: null });
    if (key === sent.key && now - sent.at < pace) {
      // Back to what the site has: there's nothing to try again.
      failing = null;
      return false;
    }
    triedAt = now;
    try {
      const delivered = Boolean(await post(report));
      if (failing) log("reports go through again");
      failing = null;
      // One with nowhere to go (this Mac unpaired) goes again at the next pace.
      sent = { at: now, key: delivered ? key : null };
    } catch (error) {
      failed(error, now);
    }
    return true;
  }
  /** Logs what went wrong, once until something else does, and has it tried again soon: later each time it fails. */
  function failed(error, now) {
    if (error.message !== failing?.message) log(error.message);
    const wait = failing ? Math.min(paces.retryMost, failing.wait * 2) : paces.retry;
    failing = { message: error.message, wait, at: now + wait };
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (!(await report(clock()))) await between();
    } catch (error) {
      log(error.message);
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    soon() {
      hurry = true;
    },
    start() {
      void tick();
      timer = setInterval(tick, Math.min(1_000, paces.running));
    },
    stop() {
      clearInterval(timer);
    },
  };
}
