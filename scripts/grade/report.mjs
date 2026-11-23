// Tells the composer's Footage tab how the offload stands, so it can show it as numbers under This Mac: each switch's
// clips and bytes, speed, time left and what it waits for; the clips passed over; the transcripts; what's kept and freed;
// and the room on this Mac. It goes to the site (`helper/footage/mac`, on the crossposter helper's pairing), which keeps
// it as one small object.
//
// Sent only when it changed: at most every 30 seconds while a run goes, and every 10 minutes otherwise, so an idle Mac
// whose numbers stay put sends nothing at all. While a run goes and nothing changes (waiting for the camera, say) it's
// sent again every 2 minutes, so the tab can tell a Mac that's asleep or off from one that's waiting.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const REPORT_EVERY = { running: 30_000, idle: 10 * 60_000, alive: 2 * 60_000 };
/** The lists are cut short well inside what the site takes. */
const MOST_SKIPPED = 50;
const MOST_DAYS = 300;
const cut = (text, most) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

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
    done: lane?.done ?? 0,
    total: lane?.total ?? 0,
    sentBytes: Math.max(0, Math.round(sent)),
    totalBytes: lane?.bytes ?? 0,
    speed: moving ? Math.round(speed) : null,
    left: left === null ? null : Math.round(left),
    waiting: waiting
      ? { for: cut(String(waiting.for), 40), why: cut(String(waiting.why ?? ""), 600), until: waiting.until ?? null }
      : null,
    error: lane?.error ? cut(lane.error, 600) : null,
  };
}

/**
 * The report, from `/api/offload`'s summary. `copySpeed` is how fast clips come off the card, measured between reports;
 * `startedAt` and `endedAt` the run's times as seen here. The room is said in whole GB, so it doesn't count as a change
 * every time any app writes a file.
 */
export function macReport(summary, { now, copySpeed = null, startedAt = null, endedAt = null }) {
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
  const { transcripts, kept, room } = summary;
  return {
    version: 1,
    at: iso(now),
    running: Boolean(run?.running),
    startedAt: iso(startedAt),
    endedAt: iso(endedAt),
    lanes: {
      copy: laneReport(run?.copy, copied, copySpeed),
      send: laneReport(run?.send, run?.sentBytes ?? 0, run?.speed ?? null),
    },
    camera: { mounted: summary.camera.mounted, clips: summary.camera.clips, bytes: summary.camera.bytes },
    mac: { clips: summary.mac.clips, bytes: summary.mac.bytes },
    freed: { camera: run?.freed.camera ?? 0, mac: run?.freed.mac ?? 0 },
    skipped: skipped.slice(0, MOST_SKIPPED),
    transcripts: {
      made: transcripts.done,
      waiting: transcripts.waiting + (transcripts.current ? 1 : 0),
      failed: transcripts.failed,
      toSend: transcripts.toSend,
      error: transcripts.error ? cut(transcripts.error, 600) : null,
    },
    kept: { days: kept.days.slice(0, MOST_DAYS), clips: kept.count },
    room: { free: Math.floor(Math.max(0, room.free) / 1e9) * 1e9, keepFree: room.keepFree },
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
 * Looks at the offload every few seconds, cheaply (`running()`), and at its summary (`summary()`, `/api/offload`'s) only
 * when a report could go: then sends it with `post(report)` if it changed. `post` says the site's answer, or null when
 * there's nowhere to send it. Says `{ start, stop, tick }`; `tick` is one look, for tests.
 */
export function macReporter({
  summary,
  running,
  post,
  every = REPORT_EVERY,
  clock = Date.now,
  log = (line) => console.error(`grade: report: ${line}`),
}) {
  /** What the site has: when it was sent, what it said (without its time), and whether a run went. */
  let sent = { at: Number.NEGATIVE_INFINITY, key: null, running: false };
  let lookedAt = Number.NEGATIVE_INFINITY;
  let run = { going: false, startedAt: null, endedAt: null };
  /** The bytes copied off the card at the last look, for how fast they come. */
  let copied = null;
  let failed = null;
  let busy = false;
  let timer = null;

  function follow(going, now) {
    if (going && !run.going) run = { going, startedAt: now, endedAt: null };
    else if (!going && run.going) run = { ...run, going, endedAt: now };
  }
  function copySpeed(summary, now) {
    const copy = summary.run?.copy;
    const bytes = copy?.on ? copy.doneBytes + (copy.current?.sent ?? 0) : null;
    const speed =
      bytes !== null && copied && now > copied.at ? ((bytes - copied.bytes) / (now - copied.at)) * 1000 : null;
    copied = bytes === null ? null : { at: now, bytes };
    return speed !== null && speed >= 0 ? speed : null;
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const now = clock();
      const going = running();
      follow(going, now);
      // A run going, or one the site still thinks goes, is said every 30 seconds; otherwise every 10 minutes.
      const pace = going || sent.running ? every.running : every.idle;
      if (now - sent.at < pace) return;
      if (going === sent.running && now - lookedAt < pace) return;
      lookedAt = now;
      const current = await summary();
      const { startedAt, endedAt } = run;
      const report = macReport(current, { now, copySpeed: copySpeed(current, now), startedAt, endedAt });
      const key = JSON.stringify({ ...report, at: null });
      const alive = going && now - sent.at >= every.alive;
      if (key === sent.key && !alive) return;
      let delivered = false;
      try {
        delivered = Boolean(await post(report));
        failed = null;
      } catch (error) {
        say(error);
      }
      // One that didn't get there is tried again when the next may go.
      sent = { at: now, key: delivered ? key : null, running: going };
    } catch (error) {
      say(error);
    } finally {
      busy = false;
    }
  }
  /** Logs what went wrong, once until something else does. */
  function say(error) {
    if (error.message !== failed) log(error.message);
    failed = error.message;
  }

  return {
    tick,
    start() {
      void tick();
      timer = setInterval(tick, Math.min(5_000, every.running));
    },
    stop() {
      clearInterval(timer);
    },
  };
}
