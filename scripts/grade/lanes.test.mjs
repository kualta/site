import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  begin,
  files,
  listed,
  place,
  put,
  readsBlob,
  records,
  savesDay,
  sha,
  site,
  sleep,
  stall,
  until,
} from "./offload.fixture.mjs";
import { archiveDays, bringer, pickClips, withHere } from "./bring.mjs";
import { keepList } from "./keep.mjs";
import { archivedFootage } from "./ledger.mjs";
import { copyClip, dayManifests, sendBlob } from "./offload.mjs";

// The offload's switches: each on its own, stopped, waiting out what's in their way, paused, kept out of, and above all
// deleting nothing that isn't safe somewhere else.
const day = "2026-11-18";
const other = "2026-11-19";
const name = (n) => `DJI_2026111810000${n}_000${n}_D.MP4`;
const [one, two, three, four] = [1, 2, 3, 4].map(name);
const lrf = (clip) => clip.replace(".MP4", ".LRF");
const onCard = (...clips) => clips.flatMap((clip) => [lrf(clip), clip]).sort();
/** When the card's files were written (place). */
const CARD_TIME = Date.parse("2026-11-18T12:00:00Z");
const LONG = "a clip long enough to go in parts of eight bytes";
const failing = () => Promise.reject(new TypeError("fetch failed"));
const uploads = (request) => request.asked.filter((asked) => /^(PUT|POST) (blobs|uploads|projects)/.test(asked));

const places = [];
async function given(...clips) {
  const at = await place(...clips);
  places.push(at);
  return at;
}
afterEach(async () => {
  for (const at of places.splice(0)) await at.done();
});

// ---- each switch alone -------------------------------------------------------------------------------------------------

test("Camera → Mac alone copies, checks and clears the card, and sends nothing", async () => {
  const at = await given(
    [
      [one, "the first", day],
      [two, "the second", other],
    ],
    [[three, "on the Mac already", day]],
  );
  const request = site();
  const run = begin(at, { lanes: ["copy"], request });
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", copy: { total: 2, done: 2 }, send: { on: false, total: 0 } });
  expect(files(at.dcim)).toEqual([]);
  expect(files(at.original)).toEqual([one, two, three]);
  expect(readFileSync(join(at.original, one), "utf8")).toBe("the first");
  expect(request.asked).toEqual([]);
});

test("Mac → Cloudflare alone sends what's on the Mac, and never looks at the card", async () => {
  const at = await given([[one, "on the card", day]], [[two, "on the Mac", day]]);
  const request = site();
  let looks = 0;
  const run = begin(at, { lanes: ["send"], request, camera: async () => looks++ });
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", copy: { on: false, total: 0 }, send: { total: 1, done: 1 } });
  expect(looks).toBe(0);
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(files(at.original)).toEqual([]);
  expect(await listed(request, day)).toEqual({ [`assets/${two}`]: sha("on the Mac") });
});

test("a record says a hash is the card's own only when it was read off the card", async () => {
  const at = await given([[one, "off the card", day]], [[two, "on the Mac", day]]);
  const known = records();
  await begin(at, { request: site(), records: known }).done;
  expect(known.clips).toEqual({
    [one]: { sha256: sha("off the card"), size: 12, day, card: CARD_TIME },
    [two]: { sha256: sha("on the Mac"), size: 10, day },
  });
});

test("a switch started while the other runs works on from there, and stopping one leaves the other on", async () => {
  const at = await given([[one, "on the card", day]], [[two, "on the Mac", day]]);
  const held = stall();
  const request = site({ hold: (rest, init, pass) => (savesDay(rest, init) ? held.hold(init, pass) : null) });
  const run = begin(at, { lanes: ["send"], request });
  await held.reached;
  expect(run.start("copy")).toBe(true);
  expect(run.start("copy")).toBe(false);
  await until(() => run.state.copy.finished);
  expect(files(at.dcim)).toEqual([]);
  run.stop(["copy"]);
  expect(run.state.send).toMatchObject({ on: true, mode: "on" });
  held.go();
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", send: { done: 2, finished: "done" } });
  expect(files(at.original)).toEqual([]);
});

test("a switch turned on again after it was stopped goes on in the same run", async () => {
  const at = await given([
    [one, "the first", day],
    [two, "the second", day],
  ]);
  const held = stall();
  let rooms = 0;
  const request = site({ hold: (rest, init, pass) => (savesDay(rest, init) ? held.hold(init, pass) : null) });
  const run = begin(at, {
    request,
    room: async () => {
      if (++rooms === 1) run.stop(["copy"]);
      return 1e12;
    },
  });
  await until(() => run.state.copy.finished === "stopped");
  expect(run.state.copy).toMatchObject({ total: 2, done: 1, mode: "off" });
  expect(files(at.dcim)).toEqual(onCard(two));
  expect(run.start("copy")).toBe(true);
  held.go();
  await run.done;
  expect(run.state).toMatchObject({ copy: { finished: "done", done: 1 }, send: { done: 2 } });
  expect(files(at.dcim)).toEqual([]);
});

// ---- stopping ----------------------------------------------------------------------------------------------------------

test("Stop sees the two uploads in flight through, their manifest saves and their deletions, and begins no more", async () => {
  const at = await given(
    [],
    [
      [one, LONG, day],
      [two, `${LONG} two`, day],
      [three, "another", day],
    ],
  );
  const held = stall();
  let parts = 0;
  const request = site({
    hold: (rest, init, pass) => (/^uploads\/\w+\/2$/.test(rest) && ++parts <= 2 ? held.hold(init, pass) : null),
  });
  const run = begin(at, { lanes: ["send"], request, part: 8 });
  await until(() => parts === 2);
  run.stop();
  expect(run.state.send).toMatchObject({ on: true, mode: "finishing" });
  held.go();
  await run.done;
  expect(run.state).toMatchObject({ finished: "stopped", send: { mode: "off", done: 2, finished: "stopped" } });
  expect(files(at.original)).toEqual([three]);
  expect(Object.keys(await listed(request, day))).toEqual([`assets/${one}`, `assets/${two}`]);
});

test("Stop sees the clip being copied through, its deletion from the card too, and copies no more", async () => {
  const at = await given([
    [one, "the first", day],
    [two, "the second", day],
  ]);
  const run = begin(at, {
    lanes: ["copy"],
    request: site(),
    room: async () => {
      run.stop(["copy"]);
      expect(run.state.copy.mode).toBe("finishing");
      return 1e12;
    },
  });
  await run.done;
  expect(run.state).toMatchObject({ finished: "stopped", copy: { done: 1, finished: "stopped" } });
  expect(files(at.original)).toEqual([one]);
  expect(files(at.dcim)).toEqual(onCard(two));
});

test("told to stop as it looks for what's next, a switch begins nothing", async () => {
  const at = await given([[one, "on the card", day]], [[two, "on the Mac", day]]);
  const request = site();
  const sending = begin(at, {
    lanes: ["send"],
    request,
    mac: async () => {
      if (sending.state.send.mode === "on") sending.stop(["send"]);
      return at.mac();
    },
  });
  await sending.done;
  const copying = begin(at, {
    lanes: ["copy"],
    request,
    camera: async () => {
      if (copying.state.copy.mode === "on") copying.stop(["copy"]);
      return at.camera();
    },
  });
  await copying.done;
  expect(request.asked).toEqual([]);
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(files(at.original)).toEqual([two]);
});

test("a second Stop cuts what's in flight: nothing of it is deleted, and the next run takes it", async () => {
  const at = await given([], [[one, LONG, day]]);
  let holding = true;
  const held = stall();
  const request = site({
    hold: (rest, init, pass) => (holding && /^uploads\/\w+\/3$/.test(rest) ? held.hold(init, pass) : null),
  });
  const run = begin(at, { lanes: ["send"], request, part: 8 });
  await held.reached;
  run.stop(["send"]);
  expect(run.state.send.mode).toBe("finishing");
  run.stop(["send"]);
  expect(run.state.send.mode).toBe("stopping");
  await run.done;
  expect(run.state).toMatchObject({ finished: "stopped", send: { done: 0 } });
  expect(files(at.original)).toEqual([one]);
  holding = false;
  const next = begin(at, { lanes: ["send"], request, part: 8 });
  await next.done;
  expect(next.state.send.done).toBe(1);
  expect(files(at.original)).toEqual([]);
});

test("asked to stop everything, the switches not told yet are told; asked again, they're all cut", async () => {
  const at = await given([[one, "on the card", day]], [[two, "on the Mac", day]]);
  const held = stall();
  const request = site({ hold: (rest, init, pass) => (savesDay(rest, init) ? held.hold(init, pass) : null) });
  const run = begin(at, { request, room: async () => 0 });
  await held.reached;
  await until(() => run.state.waiting === "room");
  run.stop(["send"]);
  run.stop();
  expect(run.state.send.mode).toBe("finishing");
  await until(() => run.state.copy.finished === "stopped");
  run.stop();
  await run.done;
  expect(files(at.original)).toEqual([two]);
  expect(files(at.dcim)).toEqual(onCard(one));
});

test("a copy stopped now leaves nothing half-copied, and the clip on the card", async () => {
  const at = await given([[one, "x".repeat(40 << 20), day]]);
  const run = begin(at, { lanes: ["copy"], request: site() });
  await until(() => run.state.copy.current?.sent > 0);
  run.stop(["copy"], { now: true });
  await run.done;
  expect(files(at.dcim)).toEqual(onCard(one));
  // Done by then, or not there at all.
  if (!run.state.copy.done) expect(files(at.original)).toEqual([]);
});

// ---- picking itself up -------------------------------------------------------------------------------------------------

const TROUBLES = {
  "no network": failing,
  "a request that times out": () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
  "a site that's down": () => Promise.resolve(Response.json({ error: "Busy" }, { status: 503 })),
  "a site refusing everything (403)": () => Promise.resolve(new Response("<html>", { status: 403 })),
  "a site that's had enough (429)": () => Promise.resolve(Response.json({ error: "Slow down" }, { status: 429 })),
};
for (const [what, trouble] of Object.entries(TROUBLES))
  test(`${what}, midway: the upload waits, tries again and goes on, the clip from its beginning`, async () => {
    const at = await given(
      [],
      [
        [one, LONG, day],
        [two, "another", day],
      ],
    );
    let down = false;
    let parts = 0;
    const request = site({
      hold: (rest) => {
        if (/^uploads\/\w+\/3$/.test(rest) && ++parts === 1) down = true;
        return down ? trouble() : null;
      },
    });
    const run = begin(at, { lanes: ["send"], request, part: 8, together: 1 });
    await until(() => run.state.send.waiting?.for === "network");
    expect(run.state.send.waiting.why).toBeTruthy();
    await sleep(120);
    // It's on still, having tried more often than a clip gets tries, and deleted nothing.
    expect(run.state.send).toMatchObject({ on: true, mode: "on", done: 0, skipped: [] });
    expect(files(at.original)).toEqual([one, two]);
    down = false;
    await run.done;
    expect(run.state).toMatchObject({ finished: "done", send: { done: 2, skipped: [], waiting: null } });
    expect(files(at.original)).toEqual([]);
    expect(await listed(request, day)).toEqual({ [`assets/${one}`]: sha(LONG), [`assets/${two}`]: sha("another") });
    expect(request.asked.filter((asked) => asked === `PUT uploads/${sha(LONG)}/1`)).toHaveLength(2);
  });

test("the network lost between a clip's arrival and its manifest loses nothing: it's filed later, and only then goes", async () => {
  const at = await given([], [[one, LONG, day]]);
  let down = false;
  let cut = false;
  const request = site({
    hold: (rest, init) => {
      if (savesDay(rest, init) && !cut) {
        cut = true;
        down = true;
      }
      return down ? failing() : null;
    },
  });
  const run = begin(at, { lanes: ["send"], request, part: 8 });
  await until(() => run.state.send.waiting?.for === "network");
  await sleep(30);
  expect(files(at.original)).toEqual([one]);
  down = false;
  await run.done;
  expect(await listed(request, day)).toEqual({ [`assets/${one}`]: sha(LONG) });
  expect(files(at.original)).toEqual([]);
  // It was in, and only read back.
  expect(request.asked.filter((asked) => asked === "POST uploads")).toHaveLength(1);
});

test("waits grow, and a stop ends one at once", async () => {
  const at = await given([], [[one, "a clip", day]]);
  const request = site({ hold: failing });
  const run = begin(at, { lanes: ["send"], request, retry: { first: 50, most: 100_000, tries: 5 } });
  const waits = [];
  let last = null;
  await until(() => {
    const until = run.state.send.waiting?.until;
    if (until && until !== last) waits.push(Date.parse(until) - Date.now());
    last = until ?? last;
    return waits.length === 5;
  });
  // As long as it says, but for how late a busy machine hears of it.
  for (const [i, ms] of waits.entries()) {
    expect(ms).toBeLessThanOrEqual(50 * 2 ** i + 1);
    expect(ms).toBeGreaterThan(50 * 2 ** i - 45);
  }
  const stopped = Date.now();
  run.stop(["send"]);
  await run.done;
  expect(Date.now() - stopped).toBeLessThan(400);
  expect(files(at.original)).toEqual([one]);
});

test("the camera unplugged midway: the copy waits for it and goes on, and the upload goes on meanwhile", async () => {
  const at = await given([
    [one, "the first", day],
    [two, "the second", day],
    [three, "the third", day],
  ]);
  let rooms = 0;
  const request = site();
  const run = begin(at, {
    request,
    // Were it taken for a failing of the clip's, that would be its one try.
    retry: { first: 5, most: 20, tries: 1 },
    room: async () => {
      // Pulled between being listed and being read.
      if (++rooms === 2) at.unplug();
      return 1e12;
    },
  });
  await until(() => run.state.copy.waiting?.for === "camera");
  expect(run.state.copy.waiting.why).toBe("The camera isn't plugged in");
  await until(() => run.state.send.done === 1);
  await sleep(60);
  expect(run.state).toMatchObject({ running: true, copy: { on: true, done: 1 }, send: { on: true, done: 1 } });
  expect(files(at.original)).toEqual([]);
  expect(files(at.away)).toEqual(onCard(two, three));
  at.plug();
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", copy: { done: 3, skipped: [] }, send: { done: 3 } });
  expect(files(at.dcim)).toEqual([]);
  expect(Object.keys(await listed(request, day))).toHaveLength(3);
});

test("a clip cut short as it's copied leaves no part of it here", async () => {
  const at = await given([[one, "half of it", day]]);
  const [clip] = await at.camera();
  await expect(copyClip({ ...clip, size: 20 }, at.original)).rejects.toThrow("came off the card 10 bytes long, not 20");
  await expect(copyClip({ ...clip, path: join(at.dcim, two) }, at.original)).rejects.toThrow("ENOENT");
  expect(files(at.original)).toEqual([]);
  expect(await copyClip(clip, at.original)).toBe(sha("half of it"));
  expect(files(at.original)).toEqual([one]);
});

test("switched on with the camera unplugged, Camera → Mac waits for it", async () => {
  const at = await given([[one, "a clip", day]]);
  at.unplug();
  const run = begin(at, { request: site() });
  await until(() => run.state.copy.waiting?.for === "camera");
  expect(run.state.send.on).toBe(true);
  at.plug();
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", send: { done: 1 } });
});

test("an empty card is looked at again before it's taken for done: it may be going", async () => {
  const at = await given([[one, "a clip", day]]);
  let looks = 0;
  const run = begin(at, {
    request: site(),
    // Listed as empty once, as a card being pulled is.
    camera: async ({ fresh }) => {
      if (++looks === 1) return [];
      return fresh && looks === 2 ? null : at.camera();
    },
  });
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", copy: { done: 1 }, send: { done: 1 } });
});

test("a clip the site keeps failing on is passed over after its tries, saying why, and the others go on", async () => {
  const at = await given(
    [],
    [
      [one, "the bad one", day],
      [two, "a good one", day],
      [three, "another", day],
    ],
  );
  const logged = [];
  let tries = 0;
  const request = site({
    hold: (rest, init) => {
      if (init.method !== "PUT" || rest !== `blobs/${sha("the bad one")}`) return null;
      tries++;
      return Promise.resolve(Response.json({ error: "Worker threw" }, { status: 500 }));
    },
  });
  const run = begin(at, { lanes: ["send"], request, log: (line) => logged.push(line) });
  await run.done;
  expect(run.state.finished).toBe("done");
  expect(run.state.send).toMatchObject({ done: 2, skipped: [{ name: one, why: "Worker threw" }] });
  // Five times, each the client's own three.
  expect(tries).toBe(15);
  expect(logged).toEqual([`${one} passed over: Worker threw`]);
  expect(files(at.original)).toEqual([one]);
  expect(Object.keys(await listed(request, day))).toEqual([`assets/${two}`, `assets/${three}`]);
});

test("a clip refused as it is, is tried again later with the others not waiting for it, then passed over", async () => {
  const at = await given(
    [],
    [
      [one, "refused", day],
      [two, "a good one", day],
    ],
  );
  const request = site({
    hold: (rest, init) =>
      init.method === "PUT" && rest === `blobs/${sha("refused")}`
        ? Promise.resolve(Response.json({ error: "The file doesn't match its hash" }, { status: 400 }))
        : null,
  });
  const run = begin(at, { lanes: ["send"], request, together: 1 });
  await until(() => run.state.send.done === 1);
  expect(run.state.send).toMatchObject({ on: true, waiting: null });
  await run.done;
  expect(run.state.send.skipped).toEqual([{ name: one, why: "The file doesn't match its hash" }]);
  expect(files(at.original)).toEqual([one]);
});

test("outages don't count as a clip's tries", async () => {
  const at = await given([], [[one, LONG, day]]);
  let down = false;
  let cuts = 0;
  const request = site({
    hold: (rest) => {
      // The network goes as each try of the clip gets to its third part, seven times over.
      if (/^uploads\/\w+\/3$/.test(rest) && cuts < 7 && !down) {
        down = true;
        cuts++;
        setTimeout(() => {
          down = false;
        }, 80);
      }
      return down ? failing() : null;
    },
  });
  const run = begin(at, { lanes: ["send"], request, part: 8, retry: { first: 5, most: 8, tries: 5 } });
  await run.done;
  expect(cuts).toBe(7);
  expect(run.state.send).toMatchObject({ finished: "done", done: 1, skipped: [] });
});

test("a clip that can't be read off the card is passed over, stays there, and holds up no other", async () => {
  const at = await given([
    [one, "longer than it says", day],
    [two, "a good one", day],
  ]);
  const run = begin(at, {
    lanes: ["copy"],
    request: site(),
    camera: async () => (await at.camera()).map((clip) => (clip.name === one ? { ...clip, size: 5 } : clip)),
  });
  await run.done;
  expect(run.state.copy).toMatchObject({ finished: "done", done: 1 });
  expect(run.state.copy.skipped).toEqual([{ name: one, why: `${one} came off the card 19 bytes long, not 5` }]);
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(files(at.original)).toEqual([two]);
});

// ---- the pause gate ----------------------------------------------------------------------------------------------------

test("uploads pause between parts and resume where they were, no part sent twice, while the card goes on", async () => {
  const at = await given([[two, "off card", day]], [[one, LONG, day]]);
  let why = null;
  const request = site({
    hold: (rest) => {
      // The page goes while the second part is on its way: that request is let through.
      if (rest === `uploads/${sha(LONG)}/2`) why = "No Grade page is open";
      return null;
    },
  });
  const run = begin(at, { request, part: 8, paused: () => why });
  await until(() => run.state.paused);
  expect(run.state.paused).toEqual({ for: "page", why: "No Grade page is open" });
  await until(() => run.state.copy.finished === "done");
  const before = [...request.asked];
  expect(before.filter((asked) => asked.startsWith(`PUT uploads/${sha(LONG)}`))).toHaveLength(2);
  await sleep(60);
  expect(request.asked).toEqual(before);
  expect(run.state.send).toMatchObject({ on: true, done: 0 });
  expect(files(at.original)).toEqual([one, two]);
  expect(files(at.dcim)).toEqual([]);
  why = null;
  run.poke();
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", paused: null, send: { done: 2 } });
  const parts = request.asked.filter((asked) => asked.startsWith(`PUT uploads/${sha(LONG)}/`));
  expect(parts).toEqual([...new Set(parts)]);
  expect(parts).toHaveLength(6);
  expect(request.asked.filter((asked) => asked === "POST uploads")).toHaveLength(1);
});

test("a paused run starts no upload, no read back and no transcript", async () => {
  const at = await given([], [[one, "a clip", day]]);
  const request = site();
  let readied = 0;
  const run = begin(at, {
    lanes: ["send"],
    request,
    paused: () => "No Grade page is open",
    transcripts: {
      take: async () => {},
      ready: async () => {
        readied++;
        return [
          { key: `${day}/${one}`, name: one, day, files: [{ path: "transcripts/a.vtt", abs: at.root, mtime: 1 }] },
        ];
      },
      sent: async () => {},
    },
  });
  await until(() => run.state.paused && readied);
  await sleep(40);
  expect(request.asked).toEqual([]);
  // Stopped while paused, with nothing in flight, it ends at once.
  run.stop(["send"]);
  await run.done;
  expect(run.state.send.finished).toBe("stopped");
  expect(files(at.original)).toEqual([one]);

  // Paused once a clip is picked: not a byte of it goes up.
  for (const body of ["short", LONG]) {
    let closed = null;
    const picked = site({
      hold: (rest) => {
        if (rest === "missing") closed ??= "No Grade page is open";
        return null;
      },
    });
    const place = await given([], [[one, body, day]]);
    const waiting = begin(place, { lanes: ["send"], request: picked, part: 8, paused: () => closed || null });
    await until(() => waiting.state.paused);
    await sleep(20);
    expect(uploads(picked)).toEqual([]);
    closed = "";
    await waiting.done;
    expect(files(place.original)).toEqual([]);
  }

  // Paused as the last part lands: the read back waits too.
  let why = null;
  const parted = site({
    hold: (rest) => {
      if (/complete$/.test(rest)) why = "No Grade page is open";
      return null;
    },
  });
  const next = begin(await given([], [[one, LONG, day]]), {
    lanes: ["send"],
    request: parted,
    part: 8,
    paused: () => why,
  });
  await until(() => next.state.paused);
  expect(parted.asked.some((asked) => asked.startsWith("GET blobs"))).toBe(false);
  why = null;
  await next.done;
  expect(parted.asked.filter((asked) => asked.startsWith("GET blobs"))).toHaveLength(1);
});

test("paused from the Footage tab, uploads hold between parts and the card between clips, then go on where they were", async () => {
  const at = await given([], [[one, LONG, day]]);
  let held = null;
  const request = site({
    hold: (rest) => {
      // Paused while the second part is on its way: that one lands, and no other goes.
      if (rest === `uploads/${sha(LONG)}/2`) held = "Paused from the Footage tab";
      return null;
    },
  });
  const run = begin(at, { lanes: ["send"], request, part: 8, pausedAll: () => held });
  await until(() => run.state.send.waiting?.for === "owner");
  expect(run.state.paused).toEqual({ for: "owner", why: "Paused from the Footage tab" });
  const before = [...request.asked];
  expect(before.filter((asked) => asked.startsWith(`PUT uploads/${sha(LONG)}`))).toHaveLength(2);
  await sleep(60);
  expect(request.asked).toEqual(before);
  held = null;
  run.poke();
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", paused: null, send: { done: 1 } });
  const parts = request.asked.filter((asked) => asked.startsWith(`PUT uploads/${sha(LONG)}/`));
  expect(parts).toEqual([...new Set(parts)]);
  expect(parts).toHaveLength(6);

  // Paused before the card is read: nothing comes off it until it goes on.
  held = "Paused from the Footage tab";
  const card = await given([[three, "on the card", day]]);
  const copy = begin(card, { lanes: ["copy"], request: site(), pausedAll: () => held });
  await until(() => copy.state.copy.waiting?.for === "owner");
  await sleep(40);
  expect(files(card.original)).toEqual([]);
  expect(files(card.dcim)).toEqual(onCard(three));
  held = null;
  await copy.done;
  expect(copy.state.copy).toMatchObject({ finished: "done", done: 1, waiting: null });
  expect(files(card.original)).toEqual([three]);
});

// ---- what's kept -------------------------------------------------------------------------------------------------------

test("kept days and clips are left alone by both switches, and out of the totals", async () => {
  const at = await given(
    [
      [one, "kept by its day", other],
      [two, "goes", day],
    ],
    [
      [three, "kept by name", day],
      [four, "goes too", day],
    ],
  );
  const request = site();
  const took = [];
  const keeping = async () => (clip) => clip.day === other || clip.name === three;
  const run = begin(at, {
    request,
    keeping,
    transcripts: { take: async (clip) => took.push(clip.name), ready: async () => [], sent: async () => {} },
  });
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", copy: { total: 1, done: 1 }, send: { total: 2, done: 2 } });
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(files(at.original)).toEqual([three]);
  expect(Object.keys(await listed(request, day)).sort()).toEqual([`assets/${two}`, `assets/${four}`].sort());
  expect(took.sort()).toEqual([two, four].sort());
});

test("what's kept stays even when a record says the archive has it", async () => {
  const at = await given([[one, "on the card", day]], [[two, "on the Mac", day]]);
  const request = site();
  const known = {};
  for (const [clip, body] of [
    [one, "on the card"],
    [two, "on the Mac"],
  ]) {
    const { sha256, size } = await put(request, `assets/${clip}`, body);
    known[clip] = { sha256, size, card: CARD_TIME };
  }
  const run = begin(at, { request, records: records(known), keeping: async () => () => true });
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", copy: { total: 0 }, send: { total: 0 } });
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(files(at.original)).toEqual([two]);
});

test("a clip kept while it's being copied or sent isn't deleted from where it is", async () => {
  const at = await given([[one, "on the card", day]], [[two, "on the Mac", day]]);
  const kept = new Set();
  const held = stall();
  const request = site({ hold: (rest, init, pass) => (savesDay(rest, init) ? held.hold(init, pass) : null) });
  const run = begin(at, {
    request,
    keeping: async () => {
      const now = new Set(kept);
      return (clip) => now.has(clip.name);
    },
    room: async () => {
      kept.add(one);
      return 1e12;
    },
  });
  await held.reached;
  await until(() => run.state.copy.finished);
  kept.add(two);
  held.go();
  await run.done;
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(files(at.original)).toEqual([one, two]);
});

test("a list of kept clips that can't be read takes and deletes nothing", async () => {
  const at = await given([[one, "on the card", day]], [[two, "on the Mac", day]]);
  const request = site();
  const run = begin(at, {
    request,
    keeping: async () => {
      throw new Error("keep.json can't be read");
    },
  });
  await until(() => run.state.copy.waiting && run.state.send.waiting);
  expect(run.state.send.waiting).toMatchObject({ for: "trouble", why: "keep.json can't be read" });
  await sleep(30);
  run.stop(undefined, { now: true });
  await run.done;
  expect(request.asked).toEqual([]);
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(files(at.original)).toEqual([two]);
});

// ---- the card cleared once it's sent -----------------------------------------------------------------------------------

const sent = () => "sent";

test("with the card cleared once it's sent, nothing goes from it before Cloudflare is checked; then it goes from both", async () => {
  const at = await given([
    [one, LONG, day],
    [two, "short", day],
  ]);
  const reading = stall();
  const request = site({ hold: (rest, init, pass) => (readsBlob(rest, init) ? reading.hold(init, pass) : null) });
  const removed = [];
  const run = begin(at, {
    request,
    part: 8,
    clearCardAfter: sent,
    removed: (clip, where) => removed.push(`${clip.name} ${where}`),
  });
  // The short one was checked by R2; the long one is being read back.
  await reading.reached;
  await until(() => removed.length === 2);
  expect(removed.sort()).toEqual([`${two} camera`, `${two} mac`]);
  await sleep(30);
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(files(at.original)).toEqual([one]);
  expect(run.state.copy).toMatchObject({ on: true, done: 2, onCamera: 1 });
  await until(() => run.state.copy.waiting?.for === "cloudflare");
  reading.go();
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", copy: { done: 2, onCamera: 0, finished: "done" } });
  expect(files(at.dcim)).toEqual([]);
  expect(files(at.original)).toEqual([]);
});

test("the sending ending as the card is looked over, its last clip is cleared all the same", async () => {
  const at = await given([
    [one, "a clip", day],
    [two, "in the archive, being exported", day],
  ]);
  const held = stall();
  const request = site({ hold: (rest, init, pass) => (savesDay(rest, init) ? held.hold(init, pass) : null) });
  const { sha256, size } = await put(request, `assets/${two}`, "in the archive, being exported");
  let armed = false;
  const run = begin(at, {
    request,
    clearCardAfter: sent,
    records: records({ [two]: { sha256, size, day, card: CARD_TIME } }),
    removable: async (clip) => {
      if (clip.name !== two) return true;
      // Asked with the first still waiting for the archive, and answered once the sending is over.
      if (armed) {
        armed = false;
        held.go();
        await until(() => !run.state.send.on);
      }
      return false;
    },
  });
  await until(() => run.state.copy.waiting?.for === "cloudflare");
  armed = true;
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", send: { done: 1 }, copy: { onCamera: 0 } });
  expect(files(at.dcim)).toEqual(onCard(two));
});

test("a clip brought as the sending looks for the last time is sent all the same", async () => {
  const at = await given([[one, "a clip", day]]);
  let hooked = false;
  const run = begin(at, {
    request: site(),
    mac: async () => {
      const was = await at.mac();
      // Listed before the copy lands, and said once the copying is over.
      if (!hooked && !was.length) {
        hooked = true;
        await until(() => !run.state.copy.on);
      }
      return was;
    },
    together: 1,
  });
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", copy: { done: 1 }, send: { done: 1 } });
  expect(files(at.original)).toEqual([]);
});

test("a clip that doesn't read back stays on the card and on the Mac", async () => {
  const at = await given([[one, LONG, day]]);
  const request = site({
    hold: (rest, init) => (readsBlob(rest, init) ? Promise.resolve(new Response("not it")) : null),
  });
  const kept = records();
  const run = begin(at, { request, part: 8, clearCardAfter: sent, records: kept });
  await run.done;
  expect(run.state.send.skipped).toHaveLength(1);
  expect(run.state.copy).toMatchObject({ onCamera: 1, finished: "done" });
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(files(at.original)).toEqual([one]);
  expect(kept.clips).toEqual({});
});

test("a clip the manifest won't list, or the record can't keep, stays on the card and on the Mac", async () => {
  const unlisted = await given([[one, "a clip", day]]);
  const refusing = site({
    hold: (rest, init) => (savesDay(rest, init) ? Promise.resolve(Response.json({}, { status: 201 })) : null),
  });
  const first = begin(unlisted, { request: refusing, clearCardAfter: sent });
  await first.done;
  expect(files(unlisted.dcim)).toEqual(onCard(one));
  expect(files(unlisted.original)).toEqual([one]);

  const unrecorded = await given([[one, "a clip", day]]);
  const full = { ...records(), add: () => Promise.reject(new Error("ENOSPC: no space left on device")) };
  const second = begin(unrecorded, { request: site(), clearCardAfter: sent, records: full });
  await second.done;
  expect(second.state.send.skipped).toEqual([{ name: one, why: "ENOSPC: no space left on device" }]);
  expect(files(unrecorded.dcim)).toEqual(onCard(one));
  expect(files(unrecorded.original)).toEqual([one]);
});

test("Camera → Mac alone, to be cleared once it's sent, leaves the card as it is, and doesn't copy a clip twice", async () => {
  const at = await given([
    [one, "the first", day],
    [two, "the second", day],
  ]);
  const run = begin(at, { lanes: ["copy"], request: site(), clearCardAfter: sent });
  await run.done;
  expect(run.state.copy).toMatchObject({ finished: "done", done: 2, onCamera: 2 });
  expect(files(at.dcim)).toEqual(onCard(one, two));
  expect(files(at.original)).toEqual([one, two]);
});

test("a run that ended in between: the next deletes from the card what was checked, and copies and sends the rest", async () => {
  const at = await given([
    [one, "checked, then the crash", day],
    [two, "copied, not sent", day],
    [three, "not copied", day],
  ]);
  const request = site();
  // The first is in the archive, filed and recorded, and gone from the Mac; the second is on both.
  const file = await put(request, `assets/${one}`, "checked, then the crash");
  await dayManifests()(request, day, [file]);
  const known = records({ [one]: { sha256: file.sha256, size: file.size, day, card: CARD_TIME } });
  await at.put(at.original, [two, "copied, not sent", day]);
  const asked = request.asked.length;
  const run = begin(at, { request, clearCardAfter: sent, records: known });
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", send: { done: 2 } });
  expect(files(at.dcim)).toEqual([]);
  expect(files(at.original)).toEqual([]);
  // The archive was asked whether it still holds the first.
  expect(request.asked.slice(asked)).toContain("POST missing");
  expect(request.asked.filter((what) => what === `PUT blobs/${file.sha256}`)).toHaveLength(1);
  expect(Object.keys(await listed(request, day)).sort()).toEqual([`assets/${one}`, `assets/${two}`, `assets/${three}`]);
});

test("stopped before it's checked, everything stays on the card; run again, it's checked and cleared", async () => {
  const at = await given([[one, LONG, day]]);
  let holding = true;
  const reading = stall();
  const request = site({
    hold: (rest, init, pass) => (holding && readsBlob(rest, init) ? reading.hold(init, pass) : null),
  });
  const known = records();
  const options = { request, part: 8, clearCardAfter: sent, records: known };
  const run = begin(at, options);
  await reading.reached;
  run.stop(undefined, { now: true });
  await run.done;
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(files(at.original)).toEqual([one]);
  expect(known.clips).toEqual({});
  holding = false;
  const next = begin(at, options);
  await next.done;
  expect(files(at.dcim)).toEqual([]);
  expect(files(at.original)).toEqual([]);
  // It was only read back: what had gone up wasn't sent again.
  expect(request.asked.filter((what) => what === "POST uploads")).toHaveLength(1);
});

test("the camera away as its clips are checked: they're deleted from it once it's back", async () => {
  const at = await given([[one, "a clip", day]]);
  const held = stall();
  const request = site({ hold: (rest, init, pass) => (savesDay(rest, init) ? held.hold(init, pass) : null) });
  const run = begin(at, { request, clearCardAfter: sent });
  await held.reached;
  at.unplug();
  held.go();
  await until(() => run.state.send.finished === "done" && run.state.copy.waiting?.for === "camera");
  expect(files(at.away)).toEqual(onCard(one));
  at.plug();
  await run.done;
  expect(files(at.dcim)).toEqual([]);
});

test("what a record says the archive has, and it hasn't, isn't deleted from the card: it's copied and sent again", async () => {
  const at = await given([[one, "lost up there", day]]);
  const request = site();
  const known = records({ [one]: { sha256: sha("lost up there"), size: 13, day, card: CARD_TIME } });
  const order = [];
  const run = begin(at, {
    request,
    records: known,
    clearCardAfter: sent,
    removed: (clip, where) => order.push([where, request.asked.includes(`PUT blobs/${sha("lost up there")}`)]),
  });
  await run.done;
  expect(order.sort()).toEqual([
    ["camera", true],
    ["mac", true],
  ]);
  expect(files(at.dcim)).toEqual([]);
});

test("a card file written to since it was sent, its size the same, is read before it's let go, and stays", async () => {
  const at = await given([[one, "as it was sent", day]]);
  const request = site();
  const known = records();
  const reading = () => request.asked.filter((what) => what.startsWith("GET blobs")).length;
  const first = begin(at, {
    request,
    records: known,
    clearCardAfter: sent,
    removable: (clip) => !clip.path.startsWith(at.dcim),
  });
  await first.done;
  expect(known.clips[one]).toMatchObject({ card: CARD_TIME });
  expect(files(at.dcim)).toEqual(onCard(one));
  await writeFile(join(at.dcim, one), "as it's now on");
  const run = begin(at, { lanes: ["copy"], request, records: known, clearCardAfter: sent });
  await run.done;
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(readFileSync(join(at.dcim, one), "utf8")).toBe("as it's now on");
  expect(reading()).toBe(0);
  // As it was when it was sent, it goes without being read again.
  await at.put(at.dcim, [one, "as it was sent", day], true);
  await begin(at, { lanes: ["copy"], request, records: known, clearCardAfter: sent }).done;
  expect(files(at.dcim)).toEqual([]);
});

test("a hash that doesn't read back as its clip is vouched for by no record from then on", async () => {
  // The same clip under two names: the one recorded on the card, the other sent from the Mac and read back.
  const at = await given([[one, LONG, day]], [[two, LONG, day]]);
  let spoiling = true;
  const request = site({
    hold: (rest, init, pass) => {
      if (spoiling && rest.startsWith("uploads/") && init.method === "PUT")
        init.body = Buffer.from(Buffer.from(init.body).map((byte) => byte ^ 1));
      return pass();
    },
  });
  await request.archive.bucket.put(`blobs/${sha(LONG)}`, "something else by now");
  const known = records({ [one]: { sha256: sha(LONG), size: LONG.length, day, card: CARD_TIME } });
  const options = { request, part: 8, records: known };
  await begin(at, { ...options, lanes: ["send"] }).done;
  expect(known.clips).toEqual({});
  const run = begin(at, { ...options, lanes: ["copy"], clearCardAfter: sent });
  await run.done;
  expect(run.state.copy).toMatchObject({ done: 1, onCamera: 1 });
  expect(files(at.dcim)).toEqual(onCard(one));
  // Read back right at last, it's all cleared.
  spoiling = false;
  await begin(at, { ...options, clearCardAfter: sent }).done;
  expect(files(at.dcim)).toEqual([]);
  expect(files(at.original)).toEqual([]);
  expect(await (await request(`blobs/${sha(LONG)}`, { raw: true })).text()).toBe(LONG);
});

test("a recorded clip the archive lost, sent again and cut before it's read back, isn't taken for checked after", async () => {
  for (const where of ["card", "mac"]) {
    const clip = [one, LONG, day];
    const at = await (where === "card" ? given([clip]) : given([], [clip]));
    let holding = true;
    const reading = stall();
    const request = site({
      hold: (rest, init, pass) => (holding && readsBlob(rest, init) ? reading.hold(init, pass) : null),
    });
    const known = records({ [one]: { sha256: sha(LONG), size: LONG.length, day, card: CARD_TIME } });
    const gone = [];
    const options = { request, part: 8, records: known, clearCardAfter: sent, removed: (_, from) => gone.push(from) };
    const run = begin(at, options);
    await reading.reached;
    run.stop(undefined, { now: true });
    await run.done;
    expect(known.clips).toEqual({});
    expect(gone).toEqual([]);
    holding = false;
    const asked = request.asked.length;
    const next = begin(at, {
      ...options,
      removed: (_, from) => {
        expect(request.asked.slice(asked)).toContain(`GET blobs/${sha(LONG)}`);
        gone.push(from);
      },
    });
    await next.done;
    expect(gone.sort()).toEqual(where === "card" ? ["camera", "mac"] : ["mac"]);
  }
});

test("the sending waits for a card clip that's to be tried again, recorded or not", async () => {
  const at = await given([[one, "the card's own clip", day]]);
  const request = site();
  // Recorded as something else of its size, and unreadable at first.
  const { sha256, size } = await put(request, `assets/${one}`, "what the Mac had on");
  expect(size).toBe(19);
  chmodSync(join(at.dcim, one), 0o000);
  const run = begin(at, {
    request,
    records: records({ [one]: { sha256, size, day } }),
    retry: { first: 120, most: 200, tries: 5 },
  });
  await sleep(50);
  expect(run.state).toMatchObject({ copy: { on: true, current: null }, send: { on: true } });
  chmodSync(join(at.dcim, one), 0o644);
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", copy: { done: 1 }, send: { done: 1 } });
  expect(files(at.dcim)).toEqual([]);
  expect(files(at.original)).toEqual([]);
});

test("with the archive out of reach, what a record says it has stays on the card till it can be asked", async () => {
  const at = await given([
    [one, "sent before", day],
    [two, "new", day],
  ]);
  let down = true;
  const request = site({ hold: () => (down ? failing() : null) });
  down = false;
  const { sha256, size } = await put(request, `assets/${one}`, "sent before");
  down = true;
  const run = begin(at, { lanes: ["copy"], request, records: records({ [one]: { sha256, size, card: CARD_TIME } }) });
  // The new one is copied all the same.
  await until(() => run.state.copy.done === 1 && run.state.copy.waiting?.for === "network");
  expect(files(at.dcim)).toEqual(onCard(one));
  down = false;
  await run.done;
  expect(files(at.dcim)).toEqual([]);
  expect(files(at.original)).toEqual([two]);
});

test("a card clip of a recorded one's name and size that isn't it, isn't deleted: it's copied and sent as well", async () => {
  const at = await given([[one, "this one's the card's", day]]);
  const request = site();
  const mac = await put(request, `assets/${one}`, "the Mac's, once, here");
  expect(mac.size).toBe(21);
  const known = records({ [one]: { sha256: mac.sha256, size: mac.size, day } });
  const run = begin(at, { request, records: known, clearCardAfter: sent });
  await run.done;
  expect(known.clips[one]).toMatchObject({ sha256: sha("this one's the card's"), card: CARD_TIME });
  expect(files(at.dcim)).toEqual([]);
  expect(await listed(request, day)).toEqual({ [`assets/${one}`]: sha("this one's the card's") });
});

test("the Mac's copy changed before it was sent: the card keeps its own, which isn't in the archive", async () => {
  const at = await given([[one, "the card's bytes", day]]);
  const request = site();
  let edited = false;
  let looked = false;
  const cleared = [];
  const known = records();
  const options = {
    request,
    clearCardAfter: sent,
    records: known,
    // The card is next looked at once what was made of the copy is in the archive.
    camera: async () => {
      if (edited && !looked) {
        looked = true;
        await until(() => known.clips[one] && !files(at.original).length);
      }
      return at.camera();
    },
    copied: (clip) => {
      // Before it's sent, and of the same size.
      if (!edited) writeFileSync(clip.path, "someone's edits!");
      edited = true;
    },
    removed: (clip, where) => where === "camera" && cleared.push(clip.name),
  };
  await begin(at, options).done;
  for (let n = 0; n < 2; n++) await begin(at, { ...options, camera: at.camera }).done;
  expect(cleared).toEqual([]);
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(await listed(request, day)).toEqual({ [`assets/${one}`]: sha("someone's edits!") });
});

test("a copy changed on the Mac since an earlier run isn't taken for the card's", async () => {
  const at = await given([[one, "the card's bytes", day]]);
  const request = site();
  const first = begin(at, { lanes: ["copy"], request, clearCardAfter: sent });
  await first.done;
  await at.put(at.original, [one, "someone's edits!", day]);
  const known = records();
  const run = begin(at, { lanes: ["send"], request, records: known });
  await run.done;
  expect(known.clips[one]).toEqual({ sha256: sha("someone's edits!"), size: 16, day });
  // Camera → Mac finds one of its name and size recorded, and reads the card to see it isn't that one.
  const next = begin(at, { lanes: ["copy"], request, records: known, clearCardAfter: sent });
  await next.done;
  expect(next.state.copy).toMatchObject({ done: 1, onCamera: 1 });
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(readFileSync(join(at.original, one), "utf8")).toBe("the card's bytes");
});

// ---- nothing that isn't safe is deleted ----------------------------------------------------------------------------------

test("a file on the Mac that isn't the card's is never written over, and both stay", async () => {
  for (const body of ["shorter", "just as long as it is"]) {
    const at = await given([[one, "the card's own clip!!", day]], [[one, body, day]]);
    const run = begin(at, { lanes: ["copy"], request: site() });
    await run.done;
    expect(run.state.copy.skipped).toEqual([
      { name: one, why: `${one} is on this Mac already and isn't the card's: both stay where they are` },
    ]);
    expect(readFileSync(join(at.original, one), "utf8")).toBe(body);
    expect(files(at.dcim)).toEqual(onCard(one));
  }
});

test("a copy written to before the card's clip could go isn't taken for it any more: both stay", async () => {
  const at = await given([[one, "the card's bytes", day]]);
  const run = begin(at, {
    lanes: ["copy"],
    request: site(),
    // Of the same size.
    copied: (clip) => writeFileSync(clip.path, "someone's edits!"),
  });
  await run.done;
  expect(run.state.copy.skipped).toMatchObject([{ name: one }]);
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(readFileSync(join(at.original, one), "utf8")).toBe("someone's edits!");
});

test("a copy written to at the last moment isn't what the card's clip goes on the strength of", async () => {
  for (const look of ["at once", "later"]) {
    const at = await given([[one, "the card's bytes", day]]);
    let asked = 0;
    const run = begin(at, {
      lanes: ["copy"],
      request: site(),
      // Asked just before it's deleted: right after it's copied, or (being exported then) on a later look.
      removable: async (clip) => {
        if (++asked === 1 && look === "later") return false;
        writeFileSync(join(at.original, clip.name), "someone's edits!");
        return true;
      },
    });
    await run.done;
    expect(files(at.dcim)).toEqual(onCard(one));
    expect(readFileSync(join(at.dcim, one), "utf8")).toBe("the card's bytes");
  }
});

test("the card told to keep its clips till they're sent, as one is about to go, keeps it", async () => {
  const at = await given([[one, "a clip", day]]);
  let after = "copied";
  const run = begin(at, {
    lanes: ["copy"],
    request: site(),
    clearCardAfter: () => after,
    removable: async () => {
      after = "sent";
      return true;
    },
  });
  await run.done;
  expect(run.state.copy).toMatchObject({ done: 1, onCamera: 1 });
  expect(files(at.dcim)).toEqual(onCard(one));
});

test("a clip the archive turns out not to have, as its sound is waited for, isn't deleted from the Mac", async () => {
  // Two names for one clip: the first is in, its sound being taken, as the second finds what's there isn't it.
  const at = await given(
    [],
    [
      [one, LONG, day],
      [three, "keeps the other upload busy", day],
    ],
  );
  let take;
  const taking = new Promise((resolve) => {
    take = resolve;
  });
  const busy = stall();
  let spoiling = false;
  const request = site({
    hold: (rest, init, pass) => {
      if (rest === `uploads/${sha("keeps the other upload busy")}/1`) return busy.hold(init, pass);
      if (spoiling && readsBlob(rest, init)) return Promise.resolve(new Response("not it"));
      return pass();
    },
  });
  const run = begin(at, {
    lanes: ["send"],
    request,
    part: 8,
    transcripts: {
      take: (clip) => (clip.name === one ? taking : Promise.resolve()),
      ready: async () => [],
      sent: async () => {},
    },
  });
  await until(() => run.state.send.done === 1);
  spoiling = true;
  await at.put(at.original, [two, LONG, day]);
  busy.go();
  await until(() => run.state.send.skipped.some((clip) => clip.name === two));
  take();
  await run.done;
  expect(files(at.original)).toContain(one);
  expect(files(at.original)).toContain(two);
});

test("a file of a card clip's name and size on the Mac isn't taken for its copy, whatever a record made of either", async () => {
  // Recorded as what the Mac has; the card's own, hashed to see whether it's that, isn't, and others are copied first.
  const [mine, theirs] = ["what the card has of it", "what the Mac has of it!"];
  const at = await given(
    [
      [one, "copied first", day],
      [two, mine, day],
      [three, "copied next", day],
    ],
    [[two, theirs, day]],
  );
  const request = site();
  const { sha256, size } = await put(request, `assets/${two}`, theirs);
  expect(size).toBe(mine.length);
  const run = begin(at, { lanes: ["copy"], request, records: records({ [two]: { sha256, size, day } }) });
  await run.done;
  expect(run.state.copy).toMatchObject({ done: 2, skipped: [{ name: two }] });
  expect(files(at.dcim)).toEqual(onCard(two));
  expect(readFileSync(join(at.original, two), "utf8")).toBe(theirs);
});

test("a clip that's on the Mac already is checked against the card, not copied, before the card's goes", async () => {
  const at = await given([[one, "the same clip", day]], [[one, "the same clip", day]]);
  const run = begin(at, { lanes: ["copy"], request: site(), room: async () => 0, keepFree: 0 });
  await run.done;
  expect(run.state.copy).toMatchObject({ done: 1, skipped: [] });
  expect(files(at.dcim)).toEqual([]);
  expect(files(at.original)).toEqual([one]);
});

test("a copy that doesn't read back as the card was read is thrown away, and the card keeps its clip", async () => {
  const at = await given([[one, "x".repeat(9 << 20), day]]);
  const [clip] = await at.camera();
  const partial = join(at.original, `.${one}.part`);
  let read = 0;
  const copying = copyClip(clip, at.original, {
    onBytes: (n) => {
      read += n;
      if (read < clip.size) return;
      // The last of it read, what's been written of it is spoilt.
      const end = Date.now() + 2000;
      while (statSync(partial).size < 8 << 20 && Date.now() < end);
      const file = openSync(partial, "r+");
      writeSync(file, "spoilt", 100);
      closeSync(file);
    },
  });
  await expect(copying).rejects.toThrow("copy on this Mac doesn't match the card");
  expect(files(at.original)).toEqual([]);
  expect(files(at.dcim)).toEqual(onCard(one));
});

test("a file that changes as it's sent in parts is never put together in the archive", async () => {
  const at = await given([], [[one, LONG, day]]);
  const request = site();
  const [clip] = await at.mac();
  await at.put(at.original, [one, LONG.toUpperCase(), day]);
  // Sent as what it was when it was hashed.
  const sending = sendBlob(request, { abs: clip.path, size: clip.size }, sha(LONG), { part: 8 });
  await expect(sending).rejects.toThrow("changed while it was being sent");
  expect(request.asked.some((what) => what.endsWith("/complete"))).toBe(false);
  expect(request.archive.objects.size).toBe(0);
  expect(request.archive.uploads.size).toBe(0);
});

test("a clip written to since it was sent isn't deleted: it stays, and doesn't take the other's place, nor go up", async () => {
  const at = await given([], [[one, "before", day]]);
  const held = stall();
  let saves = 0;
  const request = site({
    hold: (rest, init, pass) => (savesDay(rest, init) && ++saves === 1 ? held.hold(init, pass) : null),
  });
  const run = begin(at, { lanes: ["send"], request });
  await held.reached;
  await writeFile(join(at.original, one), "after!");
  held.go();
  await run.done;
  expect(run.state.send).toMatchObject({
    done: 1,
    skipped: [{ name: one, why: `Another ${one}, no smaller, is in Cloudflare already: this one stays where it is` }],
  });
  expect(await listed(request, day)).toEqual({ [`assets/${one}`]: sha("before") });
  expect(files(at.original)).toEqual([one]);
  expect(request.asked).not.toContain(`PUT blobs/${sha("after!")}`);
});

test("part of a clip never takes its place in the archive, and the whole takes a part's", async () => {
  const request = site();
  const part = await given([], [[one, LONG.slice(0, 20), day]]);
  const whole = await given([], [[one, LONG, day]]);
  await begin(part, { lanes: ["send"], request, part: 8 }).done;
  expect(await listed(request, day)).toEqual({ [`assets/${one}`]: sha(LONG.slice(0, 20)) });
  await begin(whole, { lanes: ["send"], request, part: 8 }).done;
  const partOf = sha(LONG.slice(0, 20));
  // The part stays listed, where nothing takes it for the clip.
  const manifest = { [`assets/${one}`]: sha(LONG), [`replaced/${partOf.slice(0, 12)}/${one}`]: partOf };
  expect(await listed(request, day)).toEqual(manifest);
  expect((await archivedFootage(request)).map(({ name: file, sha256 }) => [file, sha256])).toEqual([[one, sha(LONG)]]);
  expect((await archiveDays().read(request)).clips.map((clip) => clip.sha256)).toEqual([sha(LONG)]);
  expect(files(whole.original)).toEqual([]);
  // From a Mac that knows nothing of it.
  const again = await given([], [[one, LONG.slice(0, 20), day]]);
  const run = begin(again, { lanes: ["send"], request, part: 8 });
  await run.done;
  expect(run.state.send).toMatchObject({ done: 0, skipped: [{ name: one }] });
  expect(files(again.original)).toEqual([one]);
  expect(await listed(request, day)).toEqual(manifest);
});

test("a recorded clip on the Mac is deleted only if it's what was recorded, and the archive holds it", async () => {
  const at = await given(
    [],
    [
      [one, "as recorded", day],
      [two, "not as it was", day],
      [three, "lost up there", day],
    ],
  );
  const request = site();
  const known = { [three]: { sha256: sha("lost up there"), size: 13 } };
  for (const [clip, body] of [
    [one, "as recorded"],
    [two, "what it was.."],
  ]) {
    const { sha256, size } = await put(request, `assets/${clip}`, body);
    known[clip] = { sha256, size };
  }
  const before = request.asked.length;
  const run = begin(at, { lanes: ["send"], request, records: records(known) });
  await run.done;
  expect(run.state.send).toMatchObject({ total: 2, done: 2 });
  expect(files(at.original)).toEqual([]);
  const asked = request.asked.slice(before);
  for (const body of ["not as it was", "lost up there"]) expect(asked).toContain(`PUT blobs/${sha(body)}`);
  expect(asked).not.toContain(`PUT blobs/${sha("as recorded")}`);
});

test("a clip that may still be being written is left until it's settled", async () => {
  const at = await given([], [[one, "half", day]]);
  const settles = Date.now() + 60;
  const run = begin(at, {
    lanes: ["send"],
    request: site(),
    mac: async () => (await at.mac()).map((clip) => ({ ...clip, settles })),
  });
  await sleep(20);
  expect(run.state.send).toMatchObject({ done: 0, total: 1, current: [] });
  await run.done;
  expect(Date.now()).toBeGreaterThanOrEqual(settles);
  expect(run.state.send.done).toBe(1);
});

test("a clip being exported stays on the card and on the Mac, and goes once it isn't", async () => {
  const at = await given([[one, "on the card", day]], [[two, "on the Mac", day]]);
  let exporting = true;
  const options = { request: site(), removable: () => !exporting, records: records() };
  const run = begin(at, options);
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", copy: { done: 1 }, send: { done: 2 } });
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(files(at.original)).toEqual([one, two]);
  exporting = false;
  const next = begin(at, options);
  await next.done;
  expect(next.state).toMatchObject({ copy: { total: 0 }, send: { total: 0 } });
  expect(files(at.dcim)).toEqual([]);
  expect(files(at.original)).toEqual([]);
});

test("a card clip written to since it was listed isn't deleted", async () => {
  const at = await given([[one, "before", day]]);
  let written = false;
  const run = begin(at, {
    lanes: ["copy"],
    request: site(),
    // Asked just before it's deleted.
    removable: async (clip) => {
      if (!written) writeFileSync(clip.path, "after, and longer");
      written = true;
      return true;
    },
  });
  await run.done;
  expect(files(at.dcim)).toEqual(onCard(one));
  expect(readFileSync(join(at.dcim, one), "utf8")).toBe("after, and longer");
  // The Mac's copy of what it was isn't written over, so the card keeps what it is.
  expect(run.state.copy).toMatchObject({ done: 1, skipped: [{ name: one }] });
  expect(readFileSync(join(at.original, one), "utf8")).toBe("before");
});

test("a Mac copy that's gone before the card's could be deleted: the card's is copied again", async () => {
  const at = await given([[one, "a clip", day]]);
  let trashed = false;
  const run = begin(at, {
    lanes: ["copy"],
    request: site(),
    copied: (clip) => {
      if (!trashed) unlinkSync(clip.path);
      trashed = true;
    },
  });
  await run.done;
  expect(run.state.copy.done).toBe(2);
  expect(files(at.original)).toEqual([one]);
  expect(files(at.dcim)).toEqual([]);
});

// ---- what's brought back -----------------------------------------------------------------------------------------------

test("an original brought back stays through the offloads after it, till it's let go", async () => {
  const at = await given([], [[one, "graded, then offloaded", day]]);
  const request = site();
  const known = records();
  const keep = keepList(join(at.root, "keep.json"));
  const options = { request, records: known, keeping: keep.keeping };
  await begin(at, options).done;
  expect(files(at.original)).toEqual([]);

  const brought = bringer({ dir: at.original, room: async () => 1e12, placing: (clip) => keep.add(clip.name) });
  const { clips } = await archiveDays().read(request);
  await brought.add(request, pickClips(await withHere(clips, at.original), { day }));
  await brought.settled();
  const run = begin(at, options);
  await run.done;
  expect(run.state).toMatchObject({ finished: "done", send: { total: 0 }, freed: { mac: 0 } });
  expect(files(at.original)).toEqual([one]);
  await keep.set({ clips: [] });
  await begin(at, options).done;
  expect(files(at.original)).toEqual([]);
});

// ---- what it costs -----------------------------------------------------------------------------------------------------

test("a clip costs one manifest save, and none lists the archive's projects", async () => {
  const at = await given([
    [one, "the first", day],
    [two, "the second", day],
    [three, "the third", day],
  ]);
  const request = site();
  const run = begin(at, { request, clearCardAfter: sent, together: 1 });
  await run.done;
  const saves = request.asked.filter((asked) => asked.startsWith("PUT projects/"));
  expect(saves).toHaveLength(3);
  expect(request.asked).not.toContain("GET projects");
  // One asking what's missing a clip, and the card cleared on what's known of it.
  expect(request.asked.filter((asked) => asked === "POST missing")).toHaveLength(3);
});

test("times on the files as they came off the card are kept in the archive", async () => {
  const at = await given([[one, "a clip", day]]);
  const when = new Date("2026-11-18T09:08:07Z");
  await utimes(join(at.dcim, one), when, when);
  const request = site();
  const run = begin(at, { request, clearCardAfter: sent });
  await run.done;
  const [file] = (await request(`projects/_originals-${day}`)).files;
  expect(file.mtime).toBe(when.getTime());
});
