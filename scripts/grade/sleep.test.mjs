import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sleepWatch } from "./lane.mjs";
import { wakeLock } from "./offload.mjs";
import { begin, files, listed, place, readsBlob, sha, site, sleep, stall, until } from "./offload.fixture.mjs";

// The offload and this Mac's sleep: it's kept awake while a switch is at work, and a try it slept through anyway (its lid
// closed, waking for a moment every quarter of an hour) isn't counted against a clip, nor makes the waits longer.
const day = "2026-11-08";
const one = "DJI_20261108115428_0023_D.MP4";
const two = "DJI_20261108115444_0024_D.MP4";
const LONG = "a clip long enough to go in parts of eight bytes";
const MIN = 60_000;
const failing = () => Promise.reject(new TypeError("fetch failed"));
const timedOut = () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

const cleanup = [];
async function given(...clips) {
  const at = await place(...clips);
  cleanup.push(() => at.done());
  return at;
}
afterEach(async () => {
  for (const done of cleanup.splice(0)) await done();
});

/** This Mac as a run sees it: `nap(ms)` moves its wall clock on as a sleep that long would. */
function mac({ settle = 30 } = {}) {
  let shift = 0;
  const sleeps = sleepWatch({ now: () => Date.now() + shift, every: 5, gap: MIN, settle });
  cleanup.push(() => sleeps.stop());
  return {
    sleeps,
    nap: (ms = 14 * MIN) => {
      shift += ms;
    },
  };
}

/**
 * The site, with each of the first `times` tries of what `matches` outlasting a sleep: the client's three attempts all
 * time out, the Mac having slept through the first. Says the requests that timed out.
 */
function outlasted(matches, nap, times = 1, ms = 14 * MIN) {
  const timeouts = [];
  const request = site({
    hold: (rest, init) => {
      if (!matches(rest, init) || timeouts.length >= times * 3) return null;
      if (timeouts.length % 3 === 0) nap(ms);
      timeouts.push(Date.now());
      return timedOut();
    },
  });
  return Object.assign(request, { timeouts });
}
const part = (n) => (rest) => rest === `uploads/${sha(LONG)}/${n}`;

// ---- noticing a sleep --------------------------------------------------------------------------------------------------

test("a sleep is told by the wall clock leaping past the watch's beat, and by nothing else", () => {
  let wall = 1_000_000;
  const watch = sleepWatch({ now: () => wall, every: 1000, gap: 30_000, settle: 10_000 });
  cleanup.push(() => watch.stop());
  const mark = watch.mark();
  wall += 1000;
  expect(watch.since(mark)).toBe(0);
  // A busy moment, and the clock set back, aren't sleeps.
  wall += 20_000;
  expect(watch.since(mark)).toBe(0);
  wall -= 60_000;
  expect(watch.since(mark)).toBe(0);
  expect(watch.settling()).toBe(0);
  expect(watch.tell()).toBeNull();
  wall += 14 * MIN + 1000;
  expect(watch.since(mark)).toBe(14 * MIN);
  // The network is given a moment after it.
  expect(watch.settling()).toBe(10_000);
  wall += 4000;
  expect(watch.settling()).toBe(6000);
  // Each wake is told once.
  expect(watch.tell()).toBe(14 * MIN);
  expect(watch.tell()).toBeNull();
  const after = watch.mark();
  wall += 1000;
  expect(watch.since(after)).toBe(0);
  wall += 15 * MIN;
  expect(watch.since(mark)).toBe(29 * MIN - 1000);
  expect(watch.tell()).toBe(15 * MIN - 1000);
});

// ---- a try slept through -----------------------------------------------------------------------------------------------

test("a part upload the Mac slept through isn't counted: it's tried again a moment after it wakes, and goes", async () => {
  const at = await given([], [[one, LONG, day]]);
  const { sleeps, nap } = mac({ settle: 150 });
  const logged = [];
  const request = outlasted(part(2), nap);
  // One try a clip: were the sleep counted, it would be passed over.
  const run = begin(at, {
    lanes: ["send"],
    request,
    part: 8,
    sleeps,
    retry: { first: 5, most: 20, tries: 1 },
    log: (line) => logged.push(line),
  });
  await run.done;
  expect(run.state.send).toMatchObject({ finished: "done", done: 1, skipped: [] });
  expect(logged).toEqual(["the Mac slept 14 min; not counted"]);
  expect(files(at.original)).toEqual([]);
  expect(await listed(request, day)).toEqual({ [`assets/${one}`]: sha(LONG) });
  // Sent again from its beginning.
  expect(request.asked.filter((asked) => asked === "POST uploads")).toHaveLength(2);
  expect(request.asked.filter((asked) => asked === `PUT uploads/${sha(LONG)}/2`)).toHaveLength(1);
});

test("a read back the Mac slept through isn't counted either: it's read again and the clip goes", async () => {
  const at = await given([], [[one, LONG, day]]);
  const { sleeps, nap } = mac();
  const logged = [];
  const request = outlasted(readsBlob, nap);
  const run = begin(at, {
    lanes: ["send"],
    request,
    part: 8,
    sleeps,
    retry: { first: 5, most: 20, tries: 1 },
    log: (line) => logged.push(line),
  });
  await run.done;
  expect(run.state.send).toMatchObject({ finished: "done", done: 1, skipped: [] });
  expect(request.timeouts).toHaveLength(3);
  expect(logged).toEqual(["the Mac slept 14 min; not counted"]);
  expect(files(at.original)).toEqual([]);
  // It was in already: only read again, not sent again.
  expect(request.asked.filter((asked) => asked === "POST uploads")).toHaveLength(1);
  expect(request.asked.filter((asked) => asked === `GET blobs/${sha(LONG)}`)).toHaveLength(1);
});

test("after a try slept through, it's tried again only once the network has had its moment", async () => {
  const at = await given([], [[one, LONG, day]]);
  const { sleeps, nap } = mac({ settle: 200 });
  const request = outlasted(part(2), nap);
  const run = begin(at, { lanes: ["send"], request, part: 8, sleeps, retry: { first: 5, most: 20, tries: 5 } });
  await until(() => request.timeouts.length === 3);
  const failed = Date.now();
  await until(() => request.asked.filter((asked) => asked === "POST uploads").length === 2);
  expect(Date.now() - failed).toBeGreaterThanOrEqual(190);
  await run.done;
  expect(run.state.send).toMatchObject({ done: 1, skipped: [] });
});

test("sleeping again and again, as Power Nap wakes it every quarter of an hour, never passes a clip over", async () => {
  const at = await given(
    [],
    [
      [one, LONG, day],
      [two, "another", day],
    ],
  );
  const { sleeps, nap } = mac();
  const logged = [];
  const request = outlasted(part(2), nap, 7, 15 * MIN);
  const run = begin(at, { lanes: ["send"], request, part: 8, sleeps, together: 1, log: (line) => logged.push(line) });
  await run.done;
  expect(request.timeouts).toHaveLength(21);
  expect(run.state.send).toMatchObject({ finished: "done", done: 2, skipped: [] });
  // Once a wake.
  expect(logged).toEqual(Array(7).fill("the Mac slept 15 min; not counted"));
  expect(files(at.original)).toEqual([]);
});

test("a clip's real failures still count, the one it slept through doesn't", async () => {
  const at = await given(
    [],
    [
      [one, "the bad one", day],
      [two, "a good one", day],
    ],
  );
  const { sleeps, nap } = mac();
  const logged = [];
  let puts = 0;
  const request = site({
    hold: (rest, init) => {
      if (init.method !== "PUT" || rest !== `blobs/${sha("the bad one")}`) return null;
      if (puts++ === 0) nap();
      return Promise.resolve(Response.json({ error: "Worker threw" }, { status: 500 }));
    },
  });
  const run = begin(at, {
    lanes: ["send"],
    request,
    sleeps,
    retry: { first: 5, most: 20, tries: 2 },
    log: (line) => logged.push(line),
  });
  await run.done;
  // Three tries, each the client's own three: the one slept through, and the two it has.
  expect(puts).toBe(9);
  expect(run.state.send).toMatchObject({ done: 1, skipped: [{ name: one, why: "Worker threw" }] });
  expect(logged).toEqual(["the Mac slept 14 min; not counted", `${one} passed over: Worker threw`]);
  expect(files(at.original)).toEqual([one]);
});

test("a sleep doesn't make the waits longer: after it they go on from where they were", async () => {
  const at = await given([], [[one, "a clip", day]]);
  const { sleeps, nap } = mac({ settle: 40 });
  let reaches = 0;
  const request = site({
    hold: (rest, init) => {
      // The Mac sleeps through the second look at whether the site can be reached.
      if (rest === "missing" && JSON.parse(init.body).blobs.length === 0 && ++reaches === 4) nap();
      return failing();
    },
  });
  const run = begin(at, { lanes: ["send"], request, sleeps, retry: { first: 50, most: 100_000, tries: 5 } });
  const waits = [];
  let last = null;
  await until(() => {
    const until = run.state.send.waiting?.until;
    if (until && until !== last) waits.push(Date.parse(until) - Date.now());
    last = until ?? last;
    return waits.length === 5;
  });
  run.stop(["send"]);
  await run.done;
  // 50, 100, the network's moment after the wake, then 200 and 400 as they'd have been: not 200, 400, 800.
  const near = (ms, expected) => ms <= expected + 1 && ms > expected - 45;
  expect(waits.map((ms, i) => (i === 2 ? ms <= 41 : near(ms, [50, 100, 0, 200, 400][i])))).toEqual(Array(5).fill(true));
  expect(files(at.original)).toEqual([one]);
});

test("a copy off the card the Mac slept through isn't counted either", async () => {
  const at = await given([[one, "the first", day]]);
  const { sleeps, nap } = mac();
  const logged = [];
  let looks = 0;
  let napped = false;
  const run = begin(at, {
    lanes: ["copy"],
    request: site(),
    sleeps,
    retry: { first: 5, most: 20, tries: 1 },
    log: (line) => logged.push(line),
    // Read short the first time, as it was going to sleep.
    camera: async () => (await at.camera()).map((clip) => (looks++ ? clip : { ...clip, size: clip.size + 1 })),
    room: async () => {
      if (!napped) nap();
      napped = true;
      return 1e12;
    },
  });
  await run.done;
  expect(run.state.copy).toMatchObject({ finished: "done", done: 1, skipped: [] });
  expect(logged).toEqual(["the Mac slept 14 min; not counted"]);
  expect(files(at.original)).toEqual([one]);
});

test("a clip passed over is tried again the next time the switch is started", async () => {
  const at = await given([], [[one, "the bad one", day]]);
  let refusing = true;
  const request = site({
    hold: (rest, init) =>
      refusing && init.method === "PUT" && rest.startsWith("blobs/")
        ? Promise.resolve(Response.json({ error: "Worker threw" }, { status: 500 }))
        : null,
  });
  const first = begin(at, { lanes: ["send"], request });
  await first.done;
  expect(first.state.send.skipped).toEqual([{ name: one, why: "Worker threw" }]);
  refusing = false;
  const next = begin(at, { lanes: ["send"], request });
  await next.done;
  expect(next.state.send).toMatchObject({ done: 1, skipped: [] });
  expect(files(at.original)).toEqual([]);
});

// ---- kept awake --------------------------------------------------------------------------------------------------------

test("kept awake while sending, and let sleep while paused, while it waits out the network, and once it's done", async () => {
  const at = await given([], [[one, LONG, day]]);
  const said = [];
  const held = stall();
  let stalled = false;
  let why = null;
  let down = false;
  const request = site({
    hold: (rest, init, pass) => {
      if (down) return failing();
      if (rest === `uploads/${sha(LONG)}/2` && !stalled) {
        stalled = true;
        return held.hold(init, pass);
      }
      return null;
    },
  });
  const run = begin(at, { lanes: ["send"], request, part: 8, paused: () => why, awake: (on) => said.push(on) });
  const now = () => said.at(-1) ?? false;
  await held.reached;
  await until(now);
  // Paused between parts.
  why = "No Grade page is open";
  held.go();
  await until(() => run.state.paused);
  await until(() => !now());
  await sleep(40);
  expect(now()).toBe(false);
  // Going on, then waiting out the network.
  down = true;
  why = null;
  run.poke();
  await until(() => run.state.send.waiting?.for === "network");
  await until(() => !now());
  await sleep(40);
  expect(now()).toBe(false);
  down = false;
  await run.done;
  expect(run.state.send).toMatchObject({ done: 1, skipped: [] });
  expect(now()).toBe(false);
  // Never told the same twice in a row.
  expect(said.every((on, i) => on !== said[i - 1])).toBe(true);
  const told = said.length;
  await sleep(40);
  expect(said).toHaveLength(told);
});

test("waiting for the camera, with nothing else at work, lets the Mac sleep; once it's back, it's kept awake", async () => {
  const at = await given([[one, "a clip", day]]);
  at.unplug();
  const said = [];
  const held = stall();
  const request = site({ hold: (rest, init, pass) => (init.method === "PUT" ? held.hold(init, pass) : null) });
  const run = begin(at, { request, awake: (on) => said.push(on) });
  await until(() => run.state.copy.waiting?.for === "camera");
  await sleep(60);
  // Mac → Cloudflare is on, waiting on the camera too.
  expect(run.state.send.on).toBe(true);
  expect(said).toEqual([]);
  at.plug();
  await held.reached;
  await until(() => said.at(-1) === true);
  held.go();
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", copy: { done: 1 }, send: { done: 1 } });
  expect(said.at(-1)).toBe(false);
});

test("told not to, it never keeps the Mac awake; told to again as it works, it does", async () => {
  const at = await given([], [[one, LONG, day]]);
  const said = [];
  const held = stall();
  let keep = false;
  const request = site({ hold: (rest, init, pass) => (part(2)(rest) ? held.hold(init, pass) : null) });
  const run = begin(at, { lanes: ["send"], request, part: 8, stayAwake: () => keep, awake: (on) => said.push(on) });
  await held.reached;
  await sleep(60);
  expect(said).toEqual([]);
  keep = true;
  await until(() => said.at(-1) === true);
  keep = false;
  await until(() => said.at(-1) === false);
  held.go();
  await run.done;
  expect(said).toEqual([true, false]);
});

// ---- the assertion itself ----------------------------------------------------------------------------------------------

/** A stand-in for `caffeinate -i -w <pid>`: it notes itself and lasts while <pid> does. */
function standIn() {
  const dir = mkdtempSync(join(tmpdir(), "caffeinate-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const command = join(dir, "caffeinate");
  writeFileSync(
    command,
    `#!/bin/sh\necho "$$ $*" >> "${dir}/started"\nwhile kill -0 "$3" 2>/dev/null; do sleep 0.02; done\n`,
    { mode: 0o755 },
  );
  const started = () => {
    try {
      return readFileSync(join(dir, "started"), "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  return { command, started };
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("one caffeinate at most, tied to this process, gone once it isn't wanted", async () => {
  const { command, started } = standIn();
  const lock = wakeLock({ command });
  expect(lock.held).toBe(false);
  lock.hold(true);
  lock.hold(true);
  expect(lock.held).toBe(true);
  await until(() => started().length === 1);
  const [first] = started();
  expect(first).toBe(`${first.split(" ")[0]} -i -w ${process.pid}`);
  const pid = Number(first.split(" ")[0]);
  await sleep(50);
  expect(started()).toHaveLength(1);
  // Let go and wanted again at once: a new one starts only once the old one's gone.
  lock.hold(false);
  expect(lock.held).toBe(false);
  lock.hold(true);
  await until(() => started().length === 2);
  expect(alive(pid)).toBe(false);
  await sleep(50);
  expect(started()).toHaveLength(2);
  expect(lock.held).toBe(true);
  lock.hold(false);
  expect(lock.held).toBe(false);
  const second = Number(started()[1].split(" ")[0]);
  await until(() => !alive(second));
});

test("without caffeinate it says so once and doesn't keep trying", async () => {
  const logged = [];
  const lock = wakeLock({ command: "/nonexistent/caffeinate", log: (line) => logged.push(line) });
  lock.hold(true);
  await until(() => logged.length === 1);
  expect(logged[0]).toStartWith("can't keep this Mac awake: ");
  expect(lock.held).toBe(false);
  lock.hold(false);
  lock.hold(true);
  await sleep(50);
  expect(logged).toHaveLength(1);
  expect(lock.held).toBe(false);
});

test.if(process.platform === "darwin")("a server killed outright leaves no caffeinate behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grade-awake-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "server.mjs");
  const offload = pathToFileURL(join(import.meta.dir, "offload.mjs")).href;
  writeFileSync(
    script,
    `import { wakeLock } from "${offload}";\nwakeLock().hold(true);\nsetInterval(() => {}, 1000);\n`,
  );
  const server = spawn(process.execPath, [script], { stdio: "ignore" });
  cleanup.push(() => server.kill("SIGKILL"));
  const children = () => {
    try {
      return execFileSync("pgrep", ["-P", String(server.pid), "caffeinate"], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const caffeinate = Number(await until(children));
  // The system has it: no idle sleep while it's there.
  const assertions = execFileSync("pmset", ["-g", "assertions"], { encoding: "utf8" });
  expect(assertions).toMatch(new RegExp(`pid ${caffeinate}\\(caffeinate\\).*PreventUserIdleSystemSleep`));
  server.kill("SIGKILL");
  await until(() => !alive(caffeinate), 3000);
});
