import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMacReport } from "../../src/lib/publisher/mac.ts";
import { macReport, macReporter, pairedSite, REPORT_EVERY, runShape } from "./report.mjs";

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
  const report = macReport(summary(), { now, heard, every: 30_000 });
  expect(report.lanes.send).toEqual({
    state: "running",
    speed: 887_500,
    left: Math.round((40.1e9 - 1.4e9) / 887_500),
    waiting: null,
    error: null,
    // The upload in flight, with how far it's got.
    current: [{ name: "DJI_8.MP4", sent: 0.1e9, size: 0.3e9 }],
  });
  expect(report.lanes.copy).toEqual({
    state: "done",
    speed: null,
    left: null,
    waiting: null,
    error: null,
    current: [],
  });
  expect(report).toEqual({
    version: 1,
    at: "2026-11-23T12:00:00.000Z",
    // The longest until it says how things stand again, for the tab to tell a Mac gone quiet.
    every: 30_000,
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
  expect(idle.lanes.copy).toEqual({ state: "idle", speed: null, left: null, waiting: null, error: null, current: [] });
  expect(readMacReport(idle)).toEqual(idle);
});

/** A reporter on a clock of its own, against a site that keeps what it's sent, looking every second. */
function harness({ watched = false } = {}) {
  const clock = { now: 1_000_000 };
  const world = {
    running: false,
    summary: summary(null),
    shape: "a",
    watched,
    heard: {},
    down: false,
    unpaired: false,
  };
  const sent = [];
  const tried = [];
  const asked = [];
  const logged = [];
  const looks = { count: 0 };
  const reporter = macReporter({
    summary: async () => {
      looks.count++;
      return world.summary;
    },
    running: () => world.running,
    shape: () => world.shape,
    watched: () => world.watched,
    heard: () => world.heard,
    between: async () => {
      asked.push(clock.now);
    },
    post: async (report) => {
      tried.push(clock.now);
      if (world.down) throw new Error("fetch failed");
      if (world.unpaired) return null;
      sent.push({ at: clock.now, report });
      return true;
    },
    clock: () => clock.now,
    log: (line) => logged.push(line),
  });
  /** Ticks every second for `ms`. */
  const pass = async (ms) => {
    for (const end = clock.now + ms; clock.now < end; ) {
      clock.now += 1_000;
      await reporter.tick();
    }
  };
  /** The gaps between what's been sent, from the `from`th on. */
  const gaps = (from = 0) =>
    sent
      .slice(from)
      .map((one, i, all) => (i ? one.at - all[i - 1].at : null))
      .slice(1);
  return { clock, world, sent, tried, asked, logged, looks, reporter, pass, gaps };
}

test("sends at once, then only what changed: every 30 seconds at most while a run goes", async () => {
  const { world, sent, reporter, pass, gaps } = harness();
  await reporter.tick();
  expect(sent.length).toBe(1);
  expect(sent[0].report).toMatchObject({ running: false, every: REPORT_EVERY.idle });
  // A run starts: it's said at once (2 seconds after the last at most), then every 30 seconds while the numbers move.
  world.running = true;
  world.summary = summary();
  await pass(2_000);
  expect(sent.length).toBe(2);
  expect(sent[1].report).toMatchObject({ running: true, every: REPORT_EVERY.running });
  for (let n = 1; n <= 9; n++) {
    world.summary = summary({ sentBytes: 1.4e9 + n * 2e8 });
    await pass(10_000);
  }
  expect(gaps(1)).toEqual([30_000, 30_000, 30_000]);
  expect(sent.at(-1).report.lanes.send.left).toBe(Math.round((40.1e9 - 1.4e9 - 9 * 2e8) / 887_500));
});

test("while the Footage tab is open, the numbers of a run go every 4 seconds; with none going, every 30", async () => {
  const { world, sent, reporter, pass, gaps } = harness({ watched: true });
  world.running = true;
  world.summary = summary();
  await reporter.tick();
  for (let n = 1; n <= 20; n++) {
    world.summary = summary({ sentBytes: 1.4e9 + n * 1e7 });
    await pass(1_000);
  }
  expect(sent.length).toBe(6);
  expect(gaps().every((gap) => gap === REPORT_EVERY.watched)).toBe(true);
  // How long it goes at most between reports stays as it was, so it's the same whether the tab's open or not.
  expect(sent.at(-1).report.every).toBe(REPORT_EVERY.running);
  // Closed, the run's numbers go at their own pace again.
  world.watched = false;
  const count = sent.length;
  for (let n = 21; n <= 40; n++) {
    world.summary = summary({ sentBytes: 1.4e9 + n * 1e7 });
    await pass(1_000);
  }
  expect(sent.length).toBe(count);
  // With no run, what moves (another app filling the Mac's disk) goes every 30 seconds while the tab's open.
  world.watched = true;
  world.running = false;
  world.summary = summary(null);
  await pass(1_000);
  const idle = sent.length;
  const { space } = world.summary.mac;
  world.summary = summary(null, { mac: { clips: 160, bytes: 38.7e9, sent: 0, space: { ...space, used: 460e9 } } });
  await pass(29_000);
  expect(sent.length).toBe(idle);
  await pass(1_000);
  expect(sent.length).toBe(idle + 1);
});

test("what the tab shows goes at once, at most one every 2 seconds, and only if the report says something new", async () => {
  const { world, sent, looks, reporter, pass, clock } = harness();
  world.running = true;
  world.summary = summary();
  await reporter.tick();
  const start = clock.now;
  // A clip done a second after the last report, then another started: each goes once 2 seconds are up since the last.
  world.shape = "b";
  world.summary = summary({ send: lane({ done: 8, current: [] }) });
  await pass(1_000);
  expect(sent.length).toBe(1);
  await pass(1_000);
  world.shape = "c";
  world.summary = summary({ send: lane({ done: 8, current: [{ name: "DJI_9.MP4", sent: 0, size: 3e8 }] }) });
  await pass(2_000);
  expect(sent.map(({ at }) => at - start)).toEqual([0, 2_000, 4_000]);
  expect(sent[2].report.lanes.send.current).toEqual([{ name: "DJI_9.MP4", sent: 0, size: 3e8 }]);
  // A change the report doesn't show sends nothing, and the summary isn't looked at again for it.
  const looked = looks.count;
  world.shape = "d";
  await pass(5_000);
  expect(sent.length).toBe(3);
  expect(looks.count).toBe(looked + 1);
});

test("the card plugged in or pulled out is said at once, whatever the pace", async () => {
  const { world, sent, reporter, pass } = harness();
  await reporter.tick();
  expect(sent[0].report.camera.mounted).toBe(true);
  // Idle, the next look would be 10 minutes off; the mount watch (mount.mjs) hurries it.
  world.summary = summary(null, { camera: { mounted: false, clips: 0, bytes: 0, space: null } });
  await pass(60_000);
  expect(sent.length).toBe(1);
  reporter.soon();
  await pass(1_000);
  expect(sent.length).toBe(2);
  expect(sent[1].report.camera).toEqual({ mounted: false, clips: 0, bytes: 0, space: null });
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

test("a run that sits still is said again every 30 seconds, an idle Mac every 10 minutes, so one gone quiet shows", async () => {
  const { world, sent, looks, reporter, pass, gaps } = harness();
  world.running = true;
  world.summary = summary({ send: lane({ waiting: { for: "page", why: "No Grade page is open" } }), speed: null });
  await reporter.tick();
  await pass(2 * 60_000);
  expect(sent.length).toBe(5);
  expect(gaps()).toEqual([30_000, 30_000, 30_000, 30_000]);
  expect(sent[1].report.lanes.send.state).toBe("paused");
  // Idle and unchanged, it's said every 10 minutes, and the summary is looked at only that often.
  world.running = false;
  world.summary = summary(null);
  await pass(1_000);
  const [count, looked] = [sent.length, looks.count];
  await pass(60 * 60_000);
  expect(sent.length - count).toBe(6);
  expect(looks.count - looked).toBe(6);
  // A clip more to send (put there by hand) is said at the next look.
  const { space } = world.summary.mac;
  world.summary = summary(null, { mac: { clips: 161, bytes: 39e9, sent: 0, space } });
  await pass(10 * 60_000);
  expect(sent.length - count).toBe(7);
  expect(sent.at(-1).report.mac).toEqual({ clips: 161, bytes: 39e9, space: { used: 454e9, total: 494.38e9 } });
});

test("the end of a run is said at once", async () => {
  const { world, sent, reporter, pass } = harness();
  world.running = true;
  world.summary = summary();
  await reporter.tick();
  await pass(10_000);
  world.running = false;
  world.summary = summary({
    running: false,
    finished: "done",
    send: lane({ on: false, mode: "off", finished: "done", done: 167 }),
  });
  await pass(1_000);
  const last = sent.at(-1).report;
  expect(last.running).toBe(false);
  expect(last.lanes.send.state).toBe("done");
  expect(last.every).toBe(REPORT_EVERY.idle);
});

test("a Start or Pause just taken is said at the next look, whatever the pace, and only once", async () => {
  const { world, sent, reporter, pass } = harness();
  await reporter.tick();
  expect(sent.length).toBe(1);
  world.heard = { send: { at: 42, error: null } };
  // Idle, the next look would be 10 minutes off.
  await pass(60_000);
  expect(sent.length).toBe(1);
  reporter.soon();
  await pass(1_000);
  expect(sent.length).toBe(2);
  expect(sent[1].report.heard.send).toEqual({ at: 42, error: null });
  // Hurried with nothing new, there's nothing to say.
  reporter.soon();
  await pass(5_000);
  expect(sent.length).toBe(2);
});

test("a report that didn't get there is tried again in 5 seconds, then twice as long up to a minute, said once", async () => {
  const { world, sent, tried, logged, looks, reporter, pass, clock } = harness();
  world.running = true;
  world.summary = summary();
  world.down = true;
  await reporter.tick();
  const start = clock.now;
  await pass(3 * 60_000);
  expect(tried.map((at) => at - start)).toEqual([0, 5_000, 15_000, 35_000, 75_000, 135_000]);
  // While it waits, what changes goes with the next try, not before it.
  world.shape = "b";
  await pass(10_000);
  expect(tried.length).toBe(6);
  expect(logged).toEqual(["fetch failed"]);
  // Back, it goes at the next try, and says so once.
  world.down = false;
  await pass(10_000);
  expect(tried.at(-1) - start).toBe(195_000);
  expect(sent.length).toBe(1);
  expect(sent[0].report.running).toBe(true);
  expect(logged).toEqual(["fetch failed", "reports go through again"]);
  // Failing again, it starts again from 5 seconds.
  world.down = true;
  world.shape = "c";
  world.summary = summary({ send: lane({ done: 8 }) });
  await pass(1_000);
  const again = tried.length;
  await pass(5_000);
  expect(tried.length).toBe(again + 1);
  expect(logged.at(-1)).toBe("fetch failed");
  // Back to what the site has before it got there, there's nothing to try again: it's looked at only at its pace.
  world.shape = "d";
  world.summary = summary();
  await pass(10_000);
  const [settled, looked] = [tried.length, looks.count];
  await pass(20_000);
  expect([tried.length, looks.count]).toEqual([settled, looked]);
});

test("an unpaired Mac sends nothing, and goes on when it's paired", async () => {
  const { world, sent, tried, logged, reporter, pass } = harness();
  world.unpaired = true;
  await reporter.tick();
  await pass(60_000);
  expect(sent.length).toBe(0);
  expect(tried.length).toBe(1);
  world.unpaired = false;
  world.running = true;
  world.summary = summary();
  await pass(1_000);
  expect(sent.length).toBe(1);
  expect(logged).toEqual([]);
});

test("a look that sends nothing asks the site instead, so it's asked at most once a look", async () => {
  const { world, sent, asked, reporter, pass, clock } = harness({ watched: true });
  world.running = true;
  world.summary = summary();
  await reporter.tick();
  expect([sent.length, asked.length]).toEqual([1, 0]);
  const start = clock.now;
  await pass(10_000);
  // Nothing changed: every look asks the site instead (pause.mjs says whether it's time to).
  expect(sent.length).toBe(1);
  expect(asked.map((at) => at - start)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => s * 1000));
  // A look that sends asks nothing more: at 11 seconds it asks, at 12 it sends what moved.
  world.summary = summary({ sentBytes: 2e9 });
  await pass(2_000);
  expect(sent.map(({ at }) => at - start)).toEqual([0, 12_000]);
  expect(asked.at(-1) - start).toBe(11_000);
});

test("a run's shape changes as a switch starts, stops, waits or fails and as a clip starts or is done, not as bytes move", () => {
  const run = (change = {}) => summary(change).run;
  const shape = (change) => JSON.stringify(runShape(run(change)));
  const base = shape();
  expect(runShape(null)).toBeNull();
  // Bytes moving, and how fast, aren't in it.
  expect(
    shape({
      sentBytes: 9e9,
      speed: 1,
      send: lane({ doneBytes: 9e9, current: [{ name: "DJI_8.MP4", sent: 2e8, size: 3e8 }] }),
    }),
  ).toBe(base);
  for (const change of [
    { send: lane({ done: 8 }) },
    { send: lane({ current: [] }) },
    { send: lane({ current: [{ name: "DJI_8.MP4" }, { name: "DJI_9.MP4" }] }) },
    { send: lane({ mode: "finishing" }) },
    { send: lane({ waiting: { for: "network", why: "fetch failed", until: "2026-11-25T10:00:00Z" } }) },
    { send: lane({ waiting: { for: "network", why: "fetch failed", until: "2026-11-25T10:01:00Z" } }) },
    { send: lane({ on: false, mode: "off", error: "Cloudflare refused" }) },
    { send: lane({ skipped: [{ name: "DJI_1.MP4", why: "x" }] }) },
    { copy: { ...lane(), current: { name: "DJI_5.MP4", sent: 0, size: 3e8 }, onCamera: 0 } },
    { running: false },
  ])
    expect(shape(change)).not.toBe(base);
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
