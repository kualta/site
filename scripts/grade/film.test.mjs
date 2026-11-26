import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { gradeKey, resolveGrade, writeCube } from "./color.mjs";
import { filmAssets } from "./film.mjs";
import { FFPROBE } from "./media.mjs";
import { dayLabel } from "./ui/dates.mjs";

// A film's assets through the grade server: preview copies of whole clips and trims of them, made in the cache from
// the clips' grades wherever the clips are, stale when a clip is graded again, reused when asked for again, never
// fetched from the archive, never in an export's way, and let go of when long unused.
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const usable = spawnSync(ffmpeg, ["-version"]).status === 0;
const port = 9100 + Math.floor(Math.random() * 90);
const url = (p) => `http://127.0.0.1:${port}${p}`;
const root = mkdtempSync(join(tmpdir(), "grade-film-test-"));
const movies = join(root, "Movies");
const original = join(movies, "Original");
const preexp = join(movies, "Preexp");
const exported = join(movies, "Exported");
const data = join(root, "data");
const cache = join(root, "cache");
const clip = "DJI_20260401100000_0001_D.MP4";
const moved = "DJI_20260402090000_0003_D.MP4";
const slow = "DJI_20260401100100_0002_D.MP4";
const away = "DJI_20260301101500_0099_D.MP4";
const nowhere = "DJI_20200101000000_0001_D.MP4";
const day = "mac:2026-04-01";
let server;

/** The archive, holding one original that isn't on this Mac; what it was asked. */
const asked = [];
const archive = createServer((req, res) => {
  const path = decodeURIComponent(req.url.replace("/api/publisher/helper/archive/", "").split("?")[0]);
  asked.push(`${req.method} ${path}`);
  const reply = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (path === "projects") return reply(200, { projects: [{ name: "_originals-2026-03-01", archivedAt: "2026-03-05T00:00:00.000Z" }] });
  if (path === "projects/_originals-2026-03-01")
    return reply(200, { files: [{ path: `assets/${away}`, sha256: "c".repeat(64), size: 1234, mtime: 1 }] });
  reply(404, { error: "Not found" });
});

/** A D-Log2 clip with sound, `seconds` long: a flat colour, or a moving picture of that size that takes a while to grade. */
function make(dst, { busy = null, seconds = 2 } = {}) {
  const picture = busy ? `testsrc2=s=${busy}:r=24:d=${seconds}` : `color=c=0x507090:s=640x360:r=24:d=${seconds}`;
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", picture, "-f", "lavfi", "-i", `sine=d=${seconds}`,
    "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-metadata", "com.dji.camera.ColorGammaSxS=D-Log2", "-movflags", "use_metadata_tags", dst,
  ]);
}

const api = (p, body, method = "POST") =>
  fetch(url(p), { method, headers: { "X-Grade": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) });
const json = async (p) => (await fetch(url(p))).json();
const previews = (...names) => json(`/api/previews?names=${names.map(encodeURIComponent).join(",")}`);
const askPreviews = async (...names) => (await api("/api/previews", { names })).json();
const jobs = () => json("/api/jobs");
const regrade = (name, grade) => api(`/api/sources/${day}/grades`, { clips: { [name]: grade } }, "PUT");
const records = (file) => JSON.parse(readFileSync(join(data, file), "utf8")).clips;
/** The key of a grade as applied: the bases here are As shot and ACES. */
const keyOf = (grade) => gradeKey(resolveGrade(grade, ["none", "aces"]));
const hashOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 10);
const framesOf = (file) =>
  JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "json", file]))
    .packets.length;
/** The middle of a frame as one RGB pixel. */
const patch = (file) =>
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:v:0", "-frames:v", "1", "-vf", "crop=16:16:200:150,scale=1:1:flags=area+accurate_rnd+full_chroma_int,format=rgb24", "-f", "rawvideo", "-"]);

async function until(check, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}
const ready = (name) => until(async () => (await previews(name))[name].state === "ready" && (await previews(name))[name]);
const trimsOf = async (id) => (await json(`/api/trims?id=${id}`)).trims;
const allReady = (id) => until(async () => (await trimsOf(id)).every((t) => t.state === "ready") && trimsOf(id));

beforeAll(async () => {
  if (!usable) return;
  for (const dir of [original, preexp, join(data, "luts"), join(root, "publisher")]) mkdirSync(dir, { recursive: true });
  make(join(original, clip));
  make(join(preexp, moved), { seconds: 1 });
  make(join(original, slow), { busy: "1280x720", seconds: 30 });
  // An inverting stand-in for the D-Log2 ACES conversion, easy to recognise in a frame.
  const cube = new Float32Array(2 ** 3 * 3);
  for (let b = 0, i = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) cube.set([1 - r, 1 - g, 1 - b], i++ * 3);
  writeFileSync(join(data, "luts/dlog2-to-rec709-aces2.cube"), writeCube(2, cube, "invert"));
  await new Promise((resolve) => archive.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${archive.address().port}`;
  writeFileSync(join(root, "publisher/config.json"), JSON.stringify({ origin, token: "t".repeat(64) }));
  // Left by a server killed as it made a preview copy.
  mkdirSync(join(cache, "previews"), { recursive: true });
  writeFileSync(join(cache, "previews", `.${clip}.part.mp4`), "half of it");
  server = spawn(process.execPath, [join(import.meta.dir, "server.mjs")], {
    env: {
      ...process.env,
      GRADE_ROOT: movies,
      GRADE_DATA: data,
      GRADE_CACHE: cache,
      GRADE_CAMERA: join(root, "card/DCIM"),
      GRADE_PORT: String(port),
      GRADE_PUBLISHER: join(root, "publisher"),
      GRADE_LEDGER_EVERY: "600000",
      GRADE_KEEP_FREE: "1000000",
      GRADE_REMAKE_AFTER: "300",
      GRADE_UVX: join(root, "no-uvx"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => server.stdout.on("data", (said) => String(said).includes("grade:") && resolve()));
}, 120_000);

afterAll(() => {
  server?.kill();
  archive.close();
  rmSync(root, { recursive: true, force: true });
});

// ---- preview copies -------------------------------------------------------------------------------------------------

test.if(usable)("makes a preview copy of a clip by its name, wherever it is, into the cache, with its grade's key", async () => {
  expect(readdirSync(join(cache, "previews"))).toEqual([]);
  const lower = clip.replace(".MP4", ".mp4");
  expect(await previews(lower)).toEqual({ [lower]: { state: "missing", path: null, key: null, error: null } });
  const asked = await askPreviews(lower, moved);
  expect(["queued", "making"]).toContain(asked[lower].state);
  expect(["queued", "making"]).toContain(asked[moved].state);
  const made = await ready(lower);
  const key = keyOf(undefined);
  expect(made).toEqual({ state: "ready", path: join(cache, "previews/DJI_20260401100000_0001_D.mp4"), key, error: null });
  expect((await ready(moved)).path).toBe(join(cache, "previews/DJI_20260402090000_0003_D.mp4"));
  expect(records("previews.json")[clip]).toMatchObject({ file: made.path, key, profile: "dlog2", width: 640, height: 360 });
  // Graded: the stand-in base inverts.
  const [out, src] = [patch(made.path), patch(join(original, clip))];
  for (let k = 0; k < 3; k++) expect(Math.abs(out[k] - (255 - src[k]))).toBeLessThan(8);
  expect(framesOf(made.path)).toBe(48);
  // Nothing in Movies/Exported, and what a killed server left is gone.
  expect(existsSync(exported) ? readdirSync(exported) : []).toEqual([]);
  expect(readdirSync(join(cache, "previews")).sort()).toEqual(["DJI_20260401100000_0001_D.mp4", "DJI_20260402090000_0003_D.mp4"]);
  // Asked again, it's ready as it is.
  const { mtimeMs } = statSync(made.path);
  expect((await askPreviews(clip))[clip].state).toBe("ready");
  expect(statSync(made.path).mtimeMs).toBe(mtimeMs);
}, 60_000);

test.if(usable)("a clip graded since its preview copy was made is stale, until it's asked for again", async () => {
  const grade = { base: "aces", exposure: 1 };
  expect((await regrade(clip, grade)).status).toBe(200);
  const stale = (await previews(clip))[clip];
  expect(stale).toEqual({ state: "stale", path: join(cache, "previews/DJI_20260401100000_0001_D.mp4"), key: keyOf(undefined), error: null });
  // It stays stale: nothing remakes it unasked.
  await new Promise((r) => setTimeout(r, 800));
  expect((await previews(clip))[clip].state).toBe("stale");
  expect(["queued", "making"]).toContain((await askPreviews(clip))[clip].state);
  expect((await ready(clip)).key).toBe(keyOf(grade));
  expect(records("previews.json")[clip].key).toBe(keyOf(grade));
}, 60_000);

test.if(usable)("with autoRemake on, a regrade remakes the preview copy by itself once the grade has been still", async () => {
  expect((await api("/api/previews/options", { autoRemake: "yes" })).status).toBe(400);
  expect(await (await api("/api/previews/options", { autoRemake: true })).json()).toEqual({ autoRemake: true });
  expect((await jobs()).previews.autoRemake).toBe(true);
  const grade = { base: "aces", exposure: -0.5 };
  await regrade(clip, grade);
  expect((await previews(clip))[clip].state).toBe("stale");
  await until(async () => (await previews(clip))[clip].key === keyOf(grade));
  expect((await ready(clip)).key).toBe(keyOf(grade));
  // A clip without a preview copy isn't given one.
  await regrade(slow, grade);
  await new Promise((r) => setTimeout(r, 800));
  expect((await previews(slow))[slow].state).toBe("missing");
  expect(JSON.parse(readFileSync(join(data, "previews.json"), "utf8")).autoRemake).toBe(true);
  expect(await (await api("/api/previews/options", { autoRemake: false })).json()).toEqual({ autoRemake: false });
}, 60_000);

test.if(usable)("a clip that isn't here says where it is, and nothing is fetched to make it", async () => {
  const states = await askPreviews(away, nowhere);
  expect(states[away]).toMatchObject({ state: "missing", path: null });
  // Its day as the app says days: "1 Mar", with the year when it isn't this one.
  expect(states[away].error).toBe(
    `${away} isn't on this Mac: it's in Cloudflare (${dayLabel("2026-03-01")}). Bring it back with Bring to Mac first`,
  );
  expect(states[nowhere].error).toBe(`${nowhere} isn't on this Mac or in Cloudflare, and Pocket 4P isn't connected`);
  const { id, trims } = await (await api("/api/trims", { trims: [{ name: away, start: 0, end: 1 }, { name: nowhere, start: 0, end: 1 }] })).json();
  expect(trims.map((t) => [t.state, t.error])).toEqual([
    ["missing", states[away].error],
    ["missing", states[nowhere].error],
  ]);
  expect((await trimsOf(id)).map((t) => t.state)).toEqual(["missing", "missing"]);
  const { previews: queue, trims: cut } = await jobs();
  expect([queue.queued, cut.queued]).toEqual([[], []]);
  expect(asked.filter((a) => a.includes("blobs"))).toEqual([]);
});

test.if(usable)("refuses what it can't make sense of", async () => {
  for (const bad of [{}, { names: "x" }, { names: ["a/b"] }, { names: [1] }]) expect((await api("/api/previews", bad)).status).toBe(400);
  for (const trims of [undefined, [], [{ name: clip, start: 1, end: 1 }], [{ name: clip, start: -1, end: 1 }], [{ start: 0, end: 1 }], [{ name: clip, start: "0", end: 1 }]])
    expect((await api("/api/trims", { trims })).status).toBe(400);
  expect((await fetch(url("/api/trims?id=nope"))).status).toBe(404);
  expect((await fetch(url("/api/previews"), { method: "POST", body: JSON.stringify({ names: [clip] }) })).status).toBe(403);
});

// ---- trims ------------------------------------------------------------------------------------------------------------

test.if(usable)("cuts trims at full quality into the cache, from the frame at each start, and reuses an identical one", async () => {
  const key = (await previews(clip))[clip].key;
  const asking = { trims: [{ name: clip, start: 0.5, end: 1.25 }, { name: clip.replace(".MP4", ""), start: 1.01, end: 1.5 }] };
  const first = await (await api("/api/trims", asking)).json();
  expect(first.id).toMatch(/^[0-9a-f]{16}$/);
  expect(first.trims.map((t) => [t.name, t.start, t.end])).toEqual([[clip, 0.5, 1.25], [clip.replace(".MP4", ""), 1.01, 1.5]]);
  const made = await allReady(first.id);
  // 1.25 s is where frame 30 starts: the trim ends on frame 29. 1.01 s is in frame 24, which starts at 1 s.
  expect(made).toEqual([
    {
      name: clip, start: 0.5, end: 1.25, state: "ready", error: null, actualStart: 0.5, actualEnd: 29 / 24,
      path: join(cache, `trims/DJI_20260401100000_0001_D-500-1250-${hashOf(key)}.mp4`),
    },
    {
      name: clip.replace(".MP4", ""), start: 1.01, end: 1.5, state: "ready", error: null, actualStart: 1, actualEnd: 35 / 24,
      path: join(cache, `trims/DJI_20260401100000_0001_D-1010-1500-${hashOf(key)}.mp4`),
    },
  ]);
  expect(framesOf(made[0].path)).toBe(18);
  expect(records("trims.json")[`DJI_20260401100000_0001_D-500-1250-${hashOf(key)}.mp4`]).toMatchObject({
    name: clip, startMs: 500, endMs: 1250, quality: 100, key, actualStart: 0.5, actualEnd: 29 / 24,
  });
  expect(existsSync(exported) ? readdirSync(exported) : []).toEqual([]);
  // The very same, asked again: ready at once, the same file.
  const { mtimeMs } = statSync(made[0].path);
  const again = await (await api("/api/trims", { trims: [asking.trims[0]] })).json();
  expect(again.id).not.toBe(first.id);
  expect(again.trims).toEqual([made[0]]);
  expect(statSync(made[0].path).mtimeMs).toBe(mtimeMs);
  // Graded again, it's another trim, named for its grade.
  const grade = { base: "aces", exposure: 0.25 };
  await regrade(clip, grade);
  const regraded = await (await api("/api/trims", { trims: [asking.trims[0]] })).json();
  expect(["queued", "making"]).toContain(regraded.trims[0].state);
  const [other] = await allReady(regraded.id);
  expect(other.path).toBe(join(cache, `trims/DJI_20260401100000_0001_D-500-1250-${hashOf(keyOf(grade))}.mp4`));
  expect(existsSync(made[0].path)).toBe(true);
  // Below full quality, if asked, it's another file again.
  const lower = await (await api("/api/trims", { trims: [asking.trims[0]], quality: 60 })).json();
  const [low] = await allReady(lower.id);
  expect(low.path).not.toBe(other.path);
}, 120_000);

// ---- exports come first -------------------------------------------------------------------------------------------------

test.if(usable)("an export never waits: what's being made gives way, the rest wait, and all of it goes on after", async () => {
  // A preview copy of the long clip, under way.
  await askPreviews(slow);
  await until(async () => (await jobs()).previews.current?.name === slow && (await jobs()).previews.current.progress > 0);
  expect((await api("/api/export", { source: day, names: [slow] })).status).toBe(200);
  // The export starts at once, and the preview copy goes back to the head of its queue.
  const during = await until(async () => {
    const now = await jobs();
    return now.export.current?.name === slow && !now.previews.current && now;
  }, 5000);
  expect(during.previews.queued).toEqual([{ name: slow }]);
  expect(during.previews.waiting).toBe(true);
  // Asked for meanwhile, a trim waits too.
  const { id } = await (await api("/api/trims", { trims: [{ name: slow, start: 2, end: 3 }] })).json();
  const waiting = await jobs();
  expect(waiting.trims).toMatchObject({ current: null, queued: [{ name: slow, start: 2, end: 3 }], waiting: true });
  expect((await trimsOf(id))[0].state).toBe("queued");
  // While anything is made, no export is going.
  const seen = [];
  await until(async () => {
    const now = await jobs();
    seen.push(Boolean(now.export.current) && Boolean(now.previews.current || now.trims.current));
    return !now.export.current && !now.export.queue.length && !now.previews.current && !now.trims.current && !now.previews.queued.length && !now.trims.queued.length && now;
  }, 120_000);
  expect(seen.filter(Boolean)).toEqual([]);
  expect(readdirSync(exported)).toEqual(["DJI_20260401100100_0002_D.mp4"]);
  expect((await previews(slow))[slow].state).toBe("ready");
  expect(framesOf((await previews(slow))[slow].path)).toBe(720);
  expect((await trimsOf(id))[0]).toMatchObject({ state: "ready", actualStart: 2, actualEnd: 71 / 24 });
}, 180_000);

// ---- the cache's housekeeping -------------------------------------------------------------------------------------------

test.if(usable)("lets go of preview copies and trims nobody has asked for in 30 days, and of files with no record", async () => {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60_000);
  const all = JSON.parse(readFileSync(join(data, "previews.json"), "utf8"));
  all.clips[moved].usedAt = old.toISOString();
  writeFileSync(join(data, "previews.json"), JSON.stringify(all));
  const kept = (await previews(clip))[clip].path;
  const stray = join(cache, "trims/DJI_20260401100000_0001_D-1-2-abcdefabcd.mp4");
  writeFileSync(stray, "no record of it");
  utimesSync(stray, old, old);
  const recent = join(cache, "trims/DJI_20260401100000_0001_D-3-4-abcdefabcd.mp4");
  writeFileSync(recent, "nor of this, but it's new");
  // Before it makes anything it looks.
  const { id } = await (await api("/api/trims", { trims: [{ name: clip, start: 0, end: 0.2 }] })).json();
  await allReady(id);
  expect(existsSync(join(cache, "previews/DJI_20260402090000_0003_D.mp4"))).toBe(false);
  expect(records("previews.json")[moved]).toBeUndefined();
  expect((await previews(moved))[moved]).toMatchObject({ state: "missing", path: null });
  expect(existsSync(kept)).toBe(true);
  expect([existsSync(stray), existsSync(recent)]).toEqual([false, true]);
}, 60_000);

test.if(usable)("says how both queues stand in /api/jobs", async () => {
  const { previews: queue, trims } = await jobs();
  expect(queue).toEqual({ current: null, queued: [], failed: [], waiting: false, autoRemake: false });
  expect(trims).toMatchObject({ current: null, queued: [], waiting: false });
});

// ---- room, without the server: what film.mjs does with what it's told ----------------------------------------------------

test("a preview copy or trim that wouldn't leave GRADE_KEEP_FREE free isn't made, saying why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grade-film-room-"));
  try {
    const here = { name: clip, path: join(dir, "none.mp4"), src: {} };
    const assets = filmAssets({
      cache: join(dir, "cache"),
      records: { previews: join(dir, "previews.json"), trims: join(dir, "trims.json") },
      locate: async () => here,
      meta: async () => ({ duration: 60, videoBitrate: 120e6, audioBitrate: 3e5, profile: "dlog2" }),
      elsewhere: async () => "elsewhere",
      graded: async () => {
        throw new Error("nothing should be graded");
      },
      keys: async () => () => "key",
      exporting: () => false,
      encoder: () => "cpu",
      room: async () => 5.5e9,
      keepFree: 5e9,
      claims: async () => [{ by: "the export", bytes: 5e8 }],
    });
    await assets.start();
    await assets.askPreviews([clip]);
    const failed = await until(() => assets.state().previews.failed.length && assets.state().previews.failed, 5000);
    expect(failed).toEqual([
      { name: clip, error: "No room on this Mac: 0.1 GB to write, 5.5 GB free, 5.0 GB of it kept free, 0.5 GB still to come from elsewhere" },
    ]);
    expect((await assets.previewStates([clip]))[clip]).toMatchObject({ state: "failed" });
    // Ten seconds of a 120 Mbit/s clip, at up to four times that.
    const { id } = await assets.askTrims([{ name: clip, start: 0, end: 10 }]);
    await until(async () => (await assets.trimStates(id)).trims[0].state === "failed", 5000);
    expect((await assets.trimStates(id)).trims[0].error).toMatch(/^No room on this Mac: 0\.7 GB to write/);
    expect(assets.state().trims.failed).toMatchObject([{ name: clip, start: 0, end: 10 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
