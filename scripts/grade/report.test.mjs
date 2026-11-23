import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMacReport } from "../../src/lib/publisher/mac.ts";
import { macReport, macReporter, pairedSite, REPORT_EVERY } from "./report.mjs";

const lane = (change = {}) => ({
  on: true,
  mode: "on",
  total: 167,
  bytes: 40.1e9,
  done: 7,
  doneBytes: 1.3e9,
  current: [],
  waiting: null,
  skipped: [],
  finished: null,
  error: null,
  ...change,
});
/** `/api/offload` as the grade server answers it, with a run going: the card copied, the Mac's clips going up. */
const summary = (run = {}, change = {}) => ({
  camera: { mounted: true, clips: 0, bytes: 0, space: { used: 108.74e9, total: 111.86e9 } },
  mac: { clips: 160, bytes: 38.7e9, sent: 0, space: { used: 454.04e9, total: 494.38e9 } },
  transcripts: { done: 12, total: 16, current: "DJI_1.MP4", waiting: 2, failed: 1, error: "no GPU", toSend: 4 },
  kept: { days: ["2026-11-08"], clips: ["DJI_9.MP4"], count: 228 },
  days: [],
  room: { free: 123.4e9, keepFree: 5e9 },
  clearCardAfter: "copied",
  run: run && {
    running: true,
    unattended: false,
    youtube: true,
    clearCardAfter: "copied",
    paused: null,
    waiting: null,
    sent: 1.4e9,
    finished: null,
    error: null,
    transcripts: { sent: 0, error: null },
    freed: { camera: 40.1e9, mac: 1.4e9 },
    copy: {
      ...lane({ on: false, mode: "off", finished: "done", total: 167, done: 167, doneBytes: 40.1e9 }),
      current: null,
      onCamera: 0,
    },
    send: lane({ current: [{ name: "DJI_8.MP4", sent: 0.1e9, size: 0.3e9 }] }),
    sentBytes: 1.4e9,
    speed: 887_500,
    ...run,
  },
  ...change,
});

test("says each switch's state, what's left for it and the space it has, the transcripts and what's kept", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const heard = { copy: { at: 7, error: null }, send: { at: 9, error: "x".repeat(700) } };
  const report = macReport(summary(), { now, heard });
  expect(report.lanes.send).toEqual({
    state: "running",
    speed: 887_500,
    left: Math.round((40.1e9 - 1.4e9) / 887_500),
    waiting: null,
    error: null,
  });
  expect(report.lanes.copy).toEqual({ state: "done", speed: null, left: null, waiting: null, error: null });
  expect(report).toEqual({
    version: 1,
    at: "2026-11-23T12:00:00.000Z",
    running: true,
    lanes: report.lanes,
    // The card's space in tenths of a GB; the Mac's, which any app writes to, in whole GB.
    camera: { mounted: true, clips: 0, bytes: 0, space: { used: 108.7e9, total: 111.86e9 } },
    mac: { clips: 160, bytes: 38.7e9, space: { used: 454e9, total: 494.38e9 } },
    skipped: [],
    // The one being transcribed waits with the rest.
    transcripts: { waiting: 3, failed: 1, toSend: 4, error: "no GPU" },
    kept: { days: ["2026-11-08"], clips: 228 },
    heard: { copy: { at: 7, error: null }, send: { at: 9, error: `${"x".repeat(599)}…` } },
  });
  expect(readMacReport(report)).toEqual(report);
  // The card unplugged has no space to say; nothing asked yet, nothing's been heard.
  const away = macReport(summary(null, { camera: { mounted: false, clips: 0, bytes: 0, space: null } }), { now });
  expect(away.camera.space).toBeNull();
  expect(away.heard).toEqual({ copy: null, send: null });
  expect(readMacReport(away)).toEqual(away);
});

test("says what a switch waits for, that it's paused, stopping or failed, and the clips passed over", () => {
  const until = "2026-11-23T12:05:00.000Z";
  const at = (run) => macReport(summary(run), { now: 0 });
  const waiting = at({ send: lane({ waiting: { for: "network", why: "fetch failed", until } }) }).lanes.send;
  expect(waiting).toMatchObject({ state: "waiting", waiting: { for: "network", why: "fetch failed", until } });
  // Not moving, it has no speed or time left.
  expect(waiting).toMatchObject({ speed: null, left: null });
  expect(at({ send: lane({ waiting: { for: "page", why: "No Grade page is open" } }) }).lanes.send).toMatchObject({
    state: "paused",
    waiting: { for: "page", why: "No Grade page is open", until: null },
  });
  expect(at({ send: lane({ mode: "finishing" }) }).lanes.send.state).toBe("stopping");
  const failed = at({ running: false, send: { ...lane({ on: false, mode: "off", error: "Pair again" }) } });
  expect(failed.running).toBe(false);
  expect(failed.lanes.send).toMatchObject({ state: "failed", error: "Pair again" });
  const passed = at({
    copy: {
      ...lane({ skipped: [{ name: "DJI_1.MP4", why: "changed while it was read" }] }),
      current: null,
      onCamera: 0,
    },
    send: lane({ skipped: [{ name: "DJI_2.MP4", why: "x".repeat(2000) }] }),
  });
  expect(passed.skipped.map(({ lane, name }) => [lane, name])).toEqual([
    ["copy", "DJI_1.MP4"],
    ["send", "DJI_2.MP4"],
  ]);
  expect(passed.skipped[1].why.length).toBe(600);
  expect(readMacReport(passed)).toEqual(passed);
  // No run yet: every switch idle, with what waits for it.
  const idle = macReport(summary(null), { now: 0 });
  expect(idle.running).toBe(false);
  expect(idle.lanes.copy).toEqual({ state: "idle", speed: null, left: null, waiting: null, error: null });
  expect(readMacReport(idle)).toEqual(idle);
});

/** A reporter on a clock of its own, against a site that keeps what it's sent. */
function harness() {
  const clock = { now: 1_000_000 };
  const world = { running: false, summary: summary(null) };
  const sent = [];
  const looks = { count: 0 };
  const reporter = macReporter({
    summary: async () => {
      looks.count++;
      return world.summary;
    },
    running: () => world.running,
    post: async (report) => {
      if (world.down) throw new Error("The site is down");
      if (world.unpaired) return null;
      sent.push({ at: clock.now, report });
      return true;
    },
    clock: () => clock.now,
    log: () => {},
  });
  /** Ticks every 5 seconds for `ms`. */
  const pass = async (ms) => {
    for (const end = clock.now + ms; clock.now < end; ) {
      clock.now += 5_000;
      await reporter.tick();
    }
  };
  return { clock, world, sent, looks, reporter, pass };
}

test("sends at once, then only what changed: every 30 seconds at most while a run goes", async () => {
  const { world, sent, reporter, pass } = harness();
  await reporter.tick();
  expect(sent.length).toBe(1);
  expect(sent[0].report.running).toBe(false);
  // A run starts: it's said as soon as it may be, and then every 30 seconds while the numbers move.
  world.running = true;
  world.summary = summary();
  await pass(30_000);
  expect(sent.length).toBe(2);
  expect(sent[1].report.running).toBe(true);
  for (let n = 1; n <= 6; n++) {
    world.summary = summary({ sentBytes: 1.4e9 + n * 2e8 });
    await pass(10_000);
  }
  const gaps = sent
    .slice(1)
    .map((one, i, all) => (i ? one.at - all[i - 1].at : null))
    .slice(1);
  expect(gaps.length).toBeGreaterThan(0);
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(REPORT_EVERY.running);
  expect(sent.at(-1).report.lanes.send.left).toBe(Math.round((40.1e9 - 1.4e9 - 6 * 2e8) / 887_500));
});

test("how fast clips come off the card is measured between two looks", async () => {
  const { world, sent, reporter, pass } = harness();
  world.running = true;
  const copying = (doneBytes) =>
    summary({ copy: { ...lane({ doneBytes }), current: { name: "DJI_5.MP4", sent: 0, size: 3e8 }, onCamera: 0 } });
  world.summary = copying(1e9);
  await reporter.tick();
  expect(sent[0].report.lanes.copy).toMatchObject({ state: "running", speed: null, left: null });
  // 3 GB in 30 seconds.
  world.summary = copying(4e9);
  await pass(30_000);
  expect(sent[1].report.lanes.copy).toMatchObject({ speed: 1e8, left: 361 });
});

test("a run that sits still is said again only every 2 minutes, so a Mac gone quiet shows", async () => {
  const { world, sent, reporter, pass } = harness();
  world.running = true;
  world.summary = summary({ send: lane({ waiting: { for: "page", why: "No Grade page is open" } }), speed: null });
  await reporter.tick();
  expect(sent.length).toBe(1);
  await pass(REPORT_EVERY.alive - 5_000);
  expect(sent.length).toBe(1);
  await pass(10_000);
  expect(sent.length).toBe(2);
  expect(sent[1].report.lanes.send.state).toBe("paused");
});

test("idle and unchanged, nothing is sent, and the summary is looked at only every 10 minutes", async () => {
  const { world, sent, looks, reporter, pass } = harness();
  await reporter.tick();
  expect(sent.length).toBe(1);
  const looked = looks.count;
  await pass(60 * 60_000);
  expect(sent.length).toBe(1);
  expect(looks.count - looked).toBeLessThanOrEqual(6);
  // A change shows at the next look, within 10 minutes, and the Mac's space moving within a GB isn't one.
  const { space } = world.summary.mac;
  world.summary = summary(null, { mac: { clips: 160, bytes: 38.7e9, sent: 0, space: { ...space, used: 454.3e9 } } });
  await pass(10 * 60_000);
  expect(sent.length).toBe(1);
  world.summary = summary(null, { mac: { clips: 4, bytes: 1.1e9, sent: 0, space } });
  await pass(10 * 60_000);
  expect(sent.length).toBe(2);
  expect(sent[1].report.mac).toEqual({ clips: 4, bytes: 1.1e9, space: { used: 454e9, total: 494.38e9 } });
});

test("the end of a run is said within 30 seconds", async () => {
  const { world, sent, reporter, pass } = harness();
  world.running = true;
  world.summary = summary();
  await reporter.tick();
  await pass(60_000);
  world.running = false;
  world.summary = summary({
    running: false,
    finished: "done",
    send: lane({ on: false, mode: "off", finished: "done", done: 167 }),
  });
  await pass(30_000);
  const last = sent.at(-1).report;
  expect(last.running).toBe(false);
  expect(last.lanes.send.state).toBe("done");
  // Then it's idle: nothing more while nothing changes.
  const count = sent.length;
  await pass(30 * 60_000);
  expect(sent.length).toBe(count);
});

test("a Start or Pause just taken is said at the next look, whatever the pace, and only once", async () => {
  const { world, sent } = harness();
  const heard = {};
  const quick = macReporter({
    summary: async () => world.summary,
    running: () => world.running,
    heard: () => heard,
    post: async (report) => sent.push({ report }),
    clock: () => 0,
    log: () => {},
  });
  await quick.tick();
  expect(sent.length).toBe(1);
  heard.send = { at: 42, error: null };
  // Idle, the next look would be 10 minutes off.
  await quick.tick();
  expect(sent.length).toBe(1);
  quick.soon();
  await quick.tick();
  expect(sent.length).toBe(2);
  expect(sent[1].report.heard.send).toEqual({ at: 42, error: null });
  // Hurried with nothing new, there's nothing to say.
  quick.soon();
  await quick.tick();
  expect(sent.length).toBe(2);
});

test("a report that didn't get there is tried again when the next may go, and an unpaired Mac sends nothing", async () => {
  const { world, sent, reporter, pass } = harness();
  world.unpaired = true;
  await reporter.tick();
  await pass(60_000);
  expect(sent.length).toBe(0);
  world.unpaired = false;
  world.down = true;
  world.running = true;
  world.summary = summary();
  await pass(60_000);
  expect(sent.length).toBe(0);
  world.down = false;
  await pass(30_000);
  expect(sent.length).toBe(1);
  expect(sent[0].report.running).toBe(true);
});

test("asks the site on the helper's pairing, posting with a type, and says why the site refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "report-"));
  try {
    const calls = [];
    const answer = { status: 200, body: { ok: true, paused: { since: 7 } } };
    const fetcher = async (url, init) => {
      calls.push({ url, init });
      return Response.json(answer.body, { status: answer.status });
    };
    const site = pairedSite(dir, fetcher);
    expect(await site("footage/mac", { version: 1 })).toBeNull();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ origin: "https://post.kualta.dev", token: "t" }));
    expect(await site("footage/mac", { version: 1 })).toEqual({ ok: true, paused: { since: 7 } });
    expect(calls[0].url).toBe("https://post.kualta.dev/api/publisher/helper/footage/mac");
    expect(calls[0].init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    });
    expect(JSON.parse(calls[0].init.body)).toEqual({ version: 1 });
    // Asked, it's a GET with nothing to send.
    await site("footage");
    expect(calls[1].url).toBe("https://post.kualta.dev/api/publisher/helper/footage");
    expect(calls[1].init).toMatchObject({ method: "GET", headers: { Authorization: "Bearer t" }, body: undefined });
    Object.assign(answer, { status: 400, body: { error: "The offload report isn't one the Footage tab can read" } });
    await expect(site("footage/mac", { version: 1 })).rejects.toThrow(
      "The offload report isn't one the Footage tab can read",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
