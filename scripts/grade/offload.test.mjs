import { expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveResponse } from "../../src/lib/publisher/archive.ts";
import { memoryArchive, memoryMedia } from "../../src/lib/publisher/memory-archive.ts";
import { archiveClient } from "../publisher/archive.mjs";
import { dayManifests, originalsName, startOffload } from "./offload.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The site's archive routes, answered in memory, as the grade app's fetch reaches them; `hold` can answer a request itself,
 * or stall it and then `pass` it on.
 */
function site({ hold = () => null } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("migrations/0002_publisher.sql", "utf8"));
  const db = {
    prepare: (sql) => {
      let values = [];
      const statement = {
        bind: (...v) => {
          values = v;
          return statement;
        },
        first: async () => sqlite.query(sql).get(...values),
        all: async () => ({ results: sqlite.query(sql).all(...values) }),
      };
      return statement;
    },
  };
  const archive = memoryArchive();
  const media = memoryMedia();
  const fetcher = async (url, init = {}) => {
    const rest = new URL(url).pathname.replace(/^\/api\/publisher\/helper\/archive\//, "");
    const pass = () => {
      const headers = new Headers(init.headers);
      if (init.body !== undefined) headers.set("Content-Length", String(Buffer.byteLength(init.body)));
      const request = new Request(url, { method: init.method, headers, body: init.body });
      return archiveResponse(rest, request, { db, media: media.bucket, archive: archive.bucket });
    };
    return hold(rest, init, pass) ?? pass();
  };
  return archiveClient({ origin: "https://post.kualta.dev", token: "token", fetcher });
}

/** A card (DCIM/DJI_001, each clip with its .LRF) and a Movies/Original, with these clips on them. */
async function place(card, mac = []) {
  const root = await mkdtemp(join(tmpdir(), "offload-"));
  const dcim = join(root, "DCIM/DJI_001");
  const original = join(root, "Original");
  await mkdir(dcim, { recursive: true });
  await mkdir(original);
  const make = async (dir, [name, body, day], lrf) => {
    const path = join(dir, name);
    await writeFile(path, body);
    const when = new Date("2026-11-18T12:00:00Z");
    await utimes(path, when, when);
    if (lrf) await writeFile(path.replace(/\.MP4$/, ".LRF"), "low-res");
    return { name, path, size: Buffer.byteLength(body), mtime: when.getTime(), day };
  };
  const camera = [];
  for (const clip of card) camera.push(await make(dcim, clip, true));
  const onMac = [];
  for (const clip of mac) onMac.push(await make(original, clip, false));
  return { root, dcim, original, camera, mac: onMac, done: () => rm(root, { recursive: true, force: true }) };
}

const files = (dir) => readdirSync(dir).sort();
const plenty = async () => 1e12;

test("the card goes to the Mac and the Mac to the archive, each deleted once the next has it, by day", async () => {
  const at = await place(
    [
      ["DJI_20261118203054_0316_D.MP4", "a clip long enough to go in parts", "2026-11-18"],
      ["DJI_20261118203937_0317_D.MP4", "short", "2026-11-18"],
      ["DJI_20261119090000_0318_D.MP4", "the next day", "2026-11-19"],
    ],
    [["DJI_20261117090000_0300_D.MP4", "already on the Mac", "2026-11-17"]],
  );
  try {
    const request = site();
    const landed = [];
    const removed = [];
    const run = startOffload({
      camera: at.camera,
      mac: at.mac,
      dir: at.original,
      request,
      room: plenty,
      keepFree: 0,
      part: 8,
      landed: (clip, sha256) => landed.push([clip.name, sha256]),
      removed: (clip, where) => removed.push([where, clip.name]),
    });
    await run.done;
    expect(run.state).toMatchObject({ running: false, finished: "done", error: null });
    expect(run.state.copy).toMatchObject({ total: 3, done: 3, ended: true, error: null });
    expect(run.state.send).toMatchObject({ total: 4, done: 4, current: [] });
    expect(run.state.freed).toEqual({ camera: 50, mac: 68 });
    expect(Object.fromEntries(landed)).toEqual({
      "DJI_20261118203054_0316_D.MP4": sha("a clip long enough to go in parts"),
      "DJI_20261118203937_0317_D.MP4": sha("short"),
      "DJI_20261119090000_0318_D.MP4": sha("the next day"),
      "DJI_20261117090000_0300_D.MP4": sha("already on the Mac"),
    });
    expect(removed.filter(([where]) => where === "camera").map(([, name]) => name)).toEqual(
      at.camera.map((c) => c.name),
    );
    expect(removed.filter(([where]) => where === "mac")).toHaveLength(4);
    // Nothing left on the card, .LRF included, nor on the Mac, half-copied files included.
    expect(files(at.dcim)).toEqual([]);
    expect(files(at.original)).toEqual([]);

    const day = await request(`projects/${originalsName("2026-11-18")}`);
    expect(day.files.map((f) => [f.path, f.size, f.mtime])).toEqual([
      ["assets/DJI_20261118203054_0316_D.MP4", 33, Date.parse("2026-11-18T12:00:00Z")],
      ["assets/DJI_20261118203937_0317_D.MP4", 5, Date.parse("2026-11-18T12:00:00Z")],
    ]);
    expect((await request(`projects/${originalsName("2026-11-17")}`)).files.map((f) => f.path)).toEqual([
      "assets/DJI_20261117090000_0300_D.MP4",
    ]);
    const blob = await request(`blobs/${sha("a clip long enough to go in parts")}`, { raw: true });
    expect(await blob.text()).toBe("a clip long enough to go in parts");
  } finally {
    await at.done();
  }
});

test("a clip comes off the card only when the Mac has room for it, made by the clips going up", async () => {
  const at = await place([
    ["DJI_20261118100000_0001_D.MP4", "twenty bytes, first.", "2026-11-18"],
    ["DJI_20261118100100_0002_D.MP4", "twenty bytes, second", "2026-11-18"],
    ["DJI_20261118100200_0003_D.MP4", "twenty bytes, third.", "2026-11-18"],
  ]);
  try {
    // Room for one clip at a time: 30 bytes, less what's in Original.
    const used = async () => {
      let total = 0;
      for (const name of files(at.original)) total += (await stat(join(at.original, name))).size;
      return total;
    };
    const most = [];
    let waited = false;
    const run = startOffload({
      camera: at.camera,
      mac: [],
      dir: at.original,
      request: site(),
      room: async () => {
        waited ||= run?.state.waiting === "room";
        return 30 - (await used());
      },
      keepFree: 0,
      landed: async () => most.push(files(at.original).length),
    });
    await run.done;
    expect(run.state).toMatchObject({ finished: "done", error: null });
    expect(run.state.send.done).toBe(3);
    expect(most).toEqual([1, 1, 1]);
    expect(waited).toBe(true);
    expect(files(at.dcim)).toEqual([]);
    expect(files(at.original)).toEqual([]);
  } finally {
    await at.done();
  }
});

test("with no room on the Mac and nothing there to go up, the copy says so and the card keeps its clips", async () => {
  const at = await place([["DJI_20261118100000_0001_D.MP4", "a clip", "2026-11-18"]]);
  try {
    const run = startOffload({ camera: at.camera, mac: [], dir: at.original, request: site(), room: async () => 3e9 });
    await run.done;
    expect(run.state.finished).toBe("done");
    expect(run.state.copy.error).toBe("No room on this Mac for the next clip: 3.0 GB free, 5.0 GB kept free");
    expect(files(at.dcim)).toEqual(["DJI_20261118100000_0001_D.LRF", "DJI_20261118100000_0001_D.MP4"]);
  } finally {
    await at.done();
  }
});

test("what the archive holds already is only deleted; what it's lost goes again", async () => {
  const at = await place(
    [["DJI_20261118100000_0001_D.MP4", "in the archive", "2026-11-18"]],
    [["DJI_20261117100000_0001_D.MP4", "recorded, but the archive lost it", "2026-11-17"]],
  );
  try {
    const request = site();
    await request(`blobs/${sha("in the archive")}`, { method: "PUT", body: "in the archive" });
    const record = {
      "DJI_20261118100000_0001_D.MP4": { sha256: sha("in the archive"), size: 14 },
      "DJI_20261117100000_0001_D.MP4": { sha256: sha("recorded, but the archive lost it"), size: 33 },
    };
    const landed = [];
    const run = startOffload({
      camera: at.camera,
      mac: at.mac,
      record,
      dir: at.original,
      request,
      room: plenty,
      landed: (clip) => landed.push(clip.name),
    });
    await run.done;
    expect(run.state.copy.total).toBe(0);
    expect(landed).toEqual(["DJI_20261117100000_0001_D.MP4"]);
    expect(files(at.dcim)).toEqual([]);
    expect(files(at.original)).toEqual([]);
  } finally {
    await at.done();
  }
});

test("stopping cuts the part in flight, keeps what's in, and keeps the clip on the Mac", async () => {
  const at = await place([], [["DJI_20261117100000_0001_D.MP4", "a clip long enough to go in parts", "2026-11-17"]]);
  try {
    let stalled = null;
    const request = site({
      hold: (rest, init) => {
        if (!/^uploads\/\w+\/2$/.test(rest)) return null;
        return new Promise((_, reject) => {
          stalled?.();
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      },
    });
    const run = startOffload({ camera: at.camera, mac: at.mac, dir: at.original, request, room: plenty, part: 8 });
    await new Promise((resolve) => {
      stalled = resolve;
    });
    expect(run.state.send.current).toMatchObject([{ name: "DJI_20261117100000_0001_D.MP4", sent: 8 }]);
    run.stop();
    await run.done;
    expect(run.state).toMatchObject({ finished: "stopped", error: null, running: false });
    expect(run.state.send.done).toBe(0);
    expect(files(at.original)).toEqual(["DJI_20261117100000_0001_D.MP4"]);
  } finally {
    await at.done();
  }
});

test("a clip sent in parts that doesn't read back is sent once more, and stays on the Mac if it still doesn't", async () => {
  for (const [bad, finished] of [
    [1, "done"],
    [2, null],
  ]) {
    const at = await place([], [["DJI_20261117100000_0001_D.MP4", "a clip long enough to go in parts", "2026-11-17"]]);
    try {
      let reads = 0;
      let begun = 0;
      const request = site({
        hold: (rest, init) => {
          if (rest === "uploads") begun++;
          if (!rest.startsWith("blobs/") || (init.method ?? "GET") !== "GET") return null;
          return ++reads <= bad ? new Response("not the clip") : null;
        },
      });
      const run = startOffload({ camera: [], mac: at.mac, dir: at.original, request, room: plenty, part: 8 });
      await run.done;
      expect(begun).toBe(2);
      expect(run.state.finished).toBe(finished);
      expect(run.state.send.done).toBe(finished ? 1 : 0);
      if (finished) expect(files(at.original)).toEqual([]);
      else {
        expect(run.state.error).toMatch(/doesn't read back from Cloudflare/);
        expect(files(at.original)).toEqual(["DJI_20261117100000_0001_D.MP4"]);
      }
    } finally {
      await at.done();
    }
  }
});

test("a file the archive already has, but no record vouches for, is read back before the Mac's copy goes", async () => {
  const at = await place([], [["DJI_20261117100000_0001_D.MP4", "here already", "2026-11-17"]]);
  try {
    let reads = 0;
    const request = site({
      hold: (rest, init) => {
        if (rest.startsWith("blobs/") && (init.method ?? "GET") === "GET") reads++;
        return null;
      },
    });
    await request(`blobs/${sha("here already")}`, { method: "PUT", body: "here already" });
    const run = startOffload({ camera: [], mac: at.mac, dir: at.original, request, room: plenty });
    await run.done;
    expect(reads).toBe(1);
    expect(run.state.finished).toBe("done");
    expect(files(at.original)).toEqual([]);
  } finally {
    await at.done();
  }
});

test("a request that fails stops it all, saying why, and nothing is deleted that isn't in", async () => {
  const at = await place(
    [["DJI_20261118100000_0001_D.MP4", "off the card", "2026-11-18"]],
    [["DJI_20261117100000_0001_D.MP4", "on the Mac", "2026-11-17"]],
  );
  try {
    const request = site({
      hold: (rest) => (rest === "missing" ? Response.json({ error: "Archive unavailable" }, { status: 400 }) : null),
    });
    const run = startOffload({ camera: at.camera, mac: at.mac, dir: at.original, request, room: plenty, together: 1 });
    await run.done;
    expect(run.state).toMatchObject({ finished: null, error: "Archive unavailable", running: false });
    expect(run.state.send.done).toBe(0);
    expect(files(at.original).filter((f) => f.endsWith(".MP4")).length).toBeGreaterThanOrEqual(1);
  } finally {
    await at.done();
  }
});

const day = "2026-11-18";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** What a day's manifest lists, path → hash. */
const listed = async (request, on = day) =>
  Object.fromEntries((await request(`projects/${originalsName(on)}`)).files.map((f) => [f.path, f.sha256]));
/** Puts a file in the archive, as a manifest names it. */
async function put(request, path, body, extra = {}) {
  await request(`blobs/${sha(body)}`, { method: "PUT", body });
  return { path, sha256: sha(body), size: Buffer.byteLength(body), mtime: 1_700_000_000_000, ...extra };
}
const savesDay = (rest, init) => rest.startsWith("projects/_originals-") && init.method === "PUT";

test("a day's saves keep each other's files, however they're asked for at once, and after a restart", async () => {
  // Saves not made in turn would each read the day as it was before any of them, and land over the one before.
  let out = 0;
  const request = site({
    hold(rest, init, pass) {
      if (!savesDay(rest, init)) return null;
      return sleep(4 * ++out)
        .then(pass)
        .finally(() => out--);
    },
  });
  const filed = {};
  const save = async (fileInDay, on, path) => {
    const entry = await put(request, path, `${on} ${path}`);
    filed[on] ??= {};
    filed[on][path] = entry.sha256;
    return fileInDay(request, on, [entry]);
  };
  const fileInDay = dayManifests();
  const saves = [];
  for (let i = 0; i < 8; i++)
    for (const on of [day, "2026-11-19"])
      for (const path of [`assets/${i}.MP4`, `transcripts/${i}.vtt`, `transcripts/${i}.json`])
        saves.push(save(fileInDay, on, path));
  await Promise.all(saves);
  for (const on of [day, "2026-11-19"]) expect(await listed(request, on)).toEqual(filed[on]);
  expect(Object.keys(filed[day])).toHaveLength(24);

  // A server started since knows nothing of the day but what the archive has.
  const restarted = dayManifests();
  await Promise.all([save(restarted, day, "transcripts/late.vtt"), save(restarted, day, "assets/late.MP4")]);
  expect(await listed(request)).toEqual(filed[day]);
  expect(Object.keys(filed[day])).toHaveLength(26);
});

test("a save that fails doesn't hold up the next, nor lose what's there", async () => {
  let failing = false;
  const request = site({
    hold: (rest, init) => (failing && savesDay(rest, init) ? Response.json({ error: "Busy" }, { status: 400 }) : null),
  });
  const fileInDay = dayManifests();
  const [one, two, three] = await Promise.all(
    ["one", "two", "three"].map((name) => put(request, `assets/${name}.MP4`, name)),
  );
  await fileInDay(request, day, [one]);
  failing = true;
  await expect(fileInDay(request, day, [two])).rejects.toThrow("Busy");
  failing = false;
  await fileInDay(request, day, [three]);
  expect(Object.keys(await listed(request))).toEqual(["assets/one.MP4", "assets/three.MP4"]);
});

test("a save that comes out dated before the last one, or isn't kept, is made again", async () => {
  let saves = 0;
  let lost = 0;
  const request = site({
    hold: (rest, init, pass) => {
      if (!savesDay(rest, init)) return null;
      if (++saves === 2) {
        // Dated by a Worker whose clock is behind: the archive still takes the first as the latest.
        setSystemTime(new Date(Date.now() - 60_000));
        return pass().finally(() => setSystemTime());
      }
      return saves > 3 && lost-- > 0 ? Response.json({ ok: true }, { status: 201 }) : null;
    },
  });
  const fileInDay = dayManifests();
  await fileInDay(request, day, [await put(request, "assets/one.MP4", "one")]);
  await fileInDay(request, day, [await put(request, "assets/two.MP4", "two")]);
  expect(saves).toBe(3);
  expect(Object.keys(await listed(request))).toEqual(["assets/one.MP4", "assets/two.MP4"]);

  lost = 1;
  await fileInDay(request, day, [await put(request, "assets/three.MP4", "three")]);
  expect(Object.keys(await listed(request))).toHaveLength(3);
  // One it never lists is a failure: what waits on it isn't deleted.
  lost = 99;
  await expect(fileInDay(request, day, [await put(request, "assets/four.MP4", "four")])).rejects.toThrow(
    "_originals-2026-11-18 doesn't list what was filed in it",
  );
});

test("a clip the day's manifest won't list stays on the Mac", async () => {
  const at = await place([], [["DJI_20261118100000_0001_D.MP4", "a clip", day]]);
  try {
    const request = site({
      hold: (rest, init) => (savesDay(rest, init) ? Response.json({ ok: true }, { status: 201 }) : null),
    });
    const run = startOffload({ camera: [], mac: at.mac, dir: at.original, request, room: plenty });
    await run.done;
    expect(run.state.error).toMatch(/doesn't list what was filed/);
    expect(files(at.original)).toEqual(["DJI_20261118100000_0001_D.MP4"]);
  } finally {
    await at.done();
  }
});

/**
 * A transcriber as a run sees it: it makes a clip's transcript when the test says, and has it ready once the clip has
 * `landed`. `took` is what it does as a clip's sound is taken.
 */
function speech(root, { took = async () => {} } = {}) {
  const made = new Map();
  const landed = new Set();
  const sent = [];
  const taken = [];
  return {
    taken,
    sentKeys: sent,
    landed: (clip) => landed.add(clip.name),
    async make({ name, day: on }) {
      const stem = name.replace(/\.\w+$/, "");
      const list = [];
      for (const ext of ["vtt", "json"]) {
        const abs = join(root, `${stem}.${ext}`);
        await writeFile(abs, `${ext} of ${name}`);
        list.push({ path: `transcripts/${stem}.${ext}`, abs, mtime: 1_700_000_000_000 });
      }
      made.set(name, { key: `${on}/${name}`, name, day: on, files: list });
    },
    transcripts: {
      take: async (clip, signal) => {
        taken.push(clip.name);
        await took(clip, signal);
      },
      ready: async () => [...made.values()].filter(({ key, name }) => landed.has(name) && !sent.includes(key)),
      sent: async (keys) => {
        sent.push(...keys);
      },
    },
  };
}
const [first, second, third] = [1, 2, 3].map((n) => `DJI_2026111810000${n}_000${n}_D.MP4`);
const pathsOf = (name) => [
  `assets/${name}`,
  ...["json", "vtt"].map((ext) => `transcripts/${name.slice(0, -4)}.${ext}`),
];

test("transcripts go up beside their clips while a run goes, and the later ones with the next run", async () => {
  const at = await place(
    [[first, "off the card", day]],
    [
      [second, "on the Mac", day],
      [third, "there too", day],
    ],
  );
  try {
    let saves = 0;
    const request = site({
      hold: (rest, init, pass) => {
        if (savesDay(rest, init)) saves++;
        return rest.startsWith("projects/") ? sleep(saves % 3).then(pass) : null;
      },
    });
    const fileInDay = dayManifests();
    const said = speech(at.root);
    const options = { dir: at.original, request, room: plenty, keepFree: 0, fileInDay, ...said };
    // The second's transcript is made before it lands, the first's a little after, the third's only once the run is over.
    await said.make({ name: second, day });
    const run = startOffload({
      ...options,
      camera: at.camera,
      mac: at.mac,
      landed: async (clip) => {
        said.landed(clip);
        if (clip.name !== first) return;
        await sleep(5);
        await said.make(clip);
        run.poke();
      },
    });
    await run.done;
    expect(run.state).toMatchObject({ finished: "done", error: null, transcripts: { error: null } });
    expect(said.taken.sort()).toEqual([first, second, third]);
    expect(files(at.original)).toEqual([]);
    expect(Object.keys(await listed(request))).toEqual(expect.arrayContaining(pathsOf(second)));
    for (const name of [first, third]) expect(Object.keys(await listed(request))).toContain(`assets/${name}`);

    // Made after the run: nothing goes up until the next, which has nothing else to do.
    await said.make({ name: first, day });
    await said.make({ name: third, day });
    const before = await listed(request);
    await sleep(30);
    expect(await listed(request)).toEqual(before);
    const next = startOffload({ ...options, camera: [], mac: [] });
    await next.done;
    expect(next.state).toMatchObject({ finished: "done", error: null, send: { total: 0 } });
    expect(next.state.transcripts.sent + run.state.transcripts.sent).toBe(3);
    const all = await listed(request);
    expect(Object.keys(all).sort()).toEqual([first, second, third].flatMap(pathsOf).sort());
    expect(all[`assets/${first}`]).toBe(sha("off the card"));
    expect(all[`transcripts/${third.slice(0, -4)}.vtt`]).toBe(sha(`vtt of ${third}`));
    const blob = await request(`blobs/${sha(`json of ${first}`)}`, { raw: true });
    expect(await blob.text()).toBe(`json of ${first}`);

    // Sent once.
    const again = startOffload({ ...options, camera: [], mac: [] });
    await again.done;
    expect(again.state.transcripts.sent).toBe(0);
  } finally {
    await at.done();
  }
});

test("a run stopped as it saves the day, and the one after it, lose nothing either filed", async () => {
  const at = await place(
    [],
    [
      [first, "the first", day],
      [second, "the second", day],
    ],
  );
  try {
    let stall = true;
    let reached = null;
    const saving = new Promise((resolve) => {
      reached = resolve;
    });
    const request = site({
      hold: (rest, init, pass) => {
        if (!stall || !savesDay(rest, init)) return null;
        // The archive keeps it, but the answer never comes.
        return pass().then(
          () =>
            new Promise((_, reject) => {
              init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
              reached();
            }),
        );
      },
    });
    const fileInDay = dayManifests();
    const said = speech(at.root);
    const options = { camera: [], dir: at.original, request, room: plenty, fileInDay, ...said };
    const stopped = startOffload({ ...options, mac: at.mac, together: 1 });
    await saving;
    // The next run starts with the last one's save still out.
    stopped.stop();
    stall = false;
    await said.make({ name: first, day });
    await said.make({ name: second, day });
    const next = startOffload({ ...options, mac: at.mac });
    await Promise.all([stopped.done, next.done]);
    expect(stopped.state.finished).toBe("stopped");
    expect(next.state).toMatchObject({ finished: "done", error: null, transcripts: { sent: 2, error: null } });
    expect(Object.keys(await listed(request)).sort()).toEqual([first, second].flatMap(pathsOf).sort());
    expect(files(at.original)).toEqual([]);
  } finally {
    await at.done();
  }
});

test("a clip's Mac copy waits for its sound, and for nothing else: one that can't be taken doesn't keep it", async () => {
  const at = await place(
    [],
    [
      [first, "a clip", day],
      [second, "another", day],
    ],
  );
  try {
    const request = site();
    let take = null;
    const said = speech(at.root, {
      took: (clip) =>
        clip.name === first
          ? new Promise((resolve) => {
              take = resolve;
            })
          : Promise.reject(new Error("no such codec")),
    });
    const run = startOffload({ camera: [], mac: at.mac, dir: at.original, request, room: plenty, ...said });
    while (run.state.send.done < 2) await sleep(5);
    // Both are in and filed; the Mac still has them, the first's sound not taken and the second's after it.
    expect(Object.keys(await listed(request)).sort()).toEqual([`assets/${first}`, `assets/${second}`]);
    await sleep(20);
    expect(files(at.original)).toEqual([first, second]);
    take();
    await run.done;
    expect(run.state).toMatchObject({ finished: "done", error: null });
    expect(files(at.original)).toEqual([]);
  } finally {
    await at.done();
  }
});

test("a run stopped before a clip's sound is taken leaves the clip on the Mac; the next takes it, then deletes it", async () => {
  const at = await place([], [[first, "a clip", day]]);
  try {
    const request = site();
    const cut = speech(at.root, {
      took: (_clip, signal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    });
    const record = {};
    const options = { camera: [], mac: at.mac, dir: at.original, request, room: plenty, record };
    const run = startOffload({
      ...options,
      ...cut,
      landed: (clip, sha256) => {
        record[clip.name] = { sha256, size: clip.size };
      },
    });
    while (run.state.send.done < 1) await sleep(5);
    run.stop();
    await run.done;
    expect(run.state.finished).toBe("stopped");
    expect(files(at.original)).toEqual([first]);

    // In the archive already, it's only deleted, but its sound is taken first.
    const order = [];
    const said = speech(at.root, {
      took: async () => {
        await sleep(10);
        order.push(`taken, ${files(at.original).length} on the Mac`);
      },
    });
    const next = startOffload({ ...options, ...said, removed: () => order.push("removed") });
    await next.done;
    expect(next.state.send.total).toBe(0);
    expect(order).toEqual(["taken, 1 on the Mac", "removed"]);
    expect(files(at.original)).toEqual([]);
  } finally {
    await at.done();
  }
});

test("a transcript that can't be sent waits for the next run, and the clips go on", async () => {
  const at = await place([], [[first, "a clip", day]]);
  try {
    let refusing = true;
    const request = site({
      hold: (rest, init) =>
        refusing && init.method === "PUT" && rest === `blobs/${sha(`json of ${first}`)}`
          ? Response.json({ error: "Archive unavailable" }, { status: 400 })
          : null,
    });
    const said = speech(at.root);
    await said.make({ name: first, day });
    const options = { camera: [], dir: at.original, request, room: plenty, fileInDay: dayManifests(), ...said };
    const run = startOffload({ ...options, mac: at.mac });
    await run.done;
    expect(run.state).toMatchObject({
      finished: "done",
      error: null,
      transcripts: { sent: 0, error: "Archive unavailable" },
    });
    expect(files(at.original)).toEqual([]);
    expect(said.sentKeys).toEqual([]);
    expect(Object.keys(await listed(request))).toEqual([`assets/${first}`]);

    refusing = false;
    const next = startOffload({ ...options, mac: [] });
    await next.done;
    expect(next.state.transcripts).toEqual({ sent: 1, error: null });
    expect(Object.keys(await listed(request)).sort()).toEqual(pathsOf(first).sort());
  } finally {
    await at.done();
  }
});

test("two runs at once over the same manifests drop nothing of each other's", async () => {
  const at = await Promise.all([first, second].map((name) => place([], [[name, `the clip ${name}`, day]])));
  try {
    // The first save has been read back by the time the second lands: one that hadn't waited would land over it.
    let saves = 0;
    const request = site({
      hold: (rest, init, pass) => (savesDay(rest, init) ? sleep(40 * ++saves).then(pass) : null),
    });
    const fileInDay = dayManifests();
    const runs = at.map(({ mac, original }) =>
      startOffload({ camera: [], mac, dir: original, request, room: plenty, fileInDay }),
    );
    await Promise.all(runs.map((run) => run.done));
    for (const run of runs) expect(run.state).toMatchObject({ finished: "done", error: null });
    expect(Object.keys(await listed(request)).sort()).toEqual([`assets/${first}`, `assets/${second}`]);
    for (const { original } of at) expect(files(original)).toEqual([]);
  } finally {
    for (const { done } of at) await done();
  }
});

test("a clip that stays on the Mac, being exported, has its transcript sent all the same, its run's last thing", async () => {
  const at = await place([], [[first, "a clip", day]]);
  try {
    const request = site();
    const said = speech(at.root);
    await said.make({ name: first, day });
    const run = startOffload({
      ...{ camera: [], mac: at.mac, dir: at.original, request, room: plenty, ...said },
      removable: () => false,
    });
    await run.done;
    expect(run.state).toMatchObject({ finished: "done", transcripts: { sent: 1, error: null } });
    expect(files(at.original)).toEqual([first]);
    expect(Object.keys(await listed(request)).sort()).toEqual(pathsOf(first).sort());
  } finally {
    await at.done();
  }
});

test("a transcript is filed only beside its clip", async () => {
  const at = await place([]);
  try {
    const request = site();
    const fileInDay = dayManifests();
    await fileInDay(request, day, [await put(request, `assets/${first}`, "a clip")]);
    const said = speech(at.root);
    for (const name of [first, second]) {
      await said.make({ name, day });
      said.landed({ name });
    }
    const run = startOffload({ camera: [], mac: [], dir: at.original, request, room: plenty, fileInDay, ...said });
    await run.done;
    expect(run.state.transcripts).toEqual({ sent: 1, error: null });
    expect(said.sentKeys).toEqual([`${day}/${first}`]);
    expect(Object.keys(await listed(request)).sort()).toEqual(pathsOf(first).sort());
  } finally {
    await at.done();
  }
});
