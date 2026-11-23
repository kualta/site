import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { parseCube, resolveGrade, writeCube } from "./color.mjs";
import { FFPROBE, gradeStill } from "./media.mjs";
import { AS_MADE, THUMBS_AT_ONCE, thumbKey, thumbSender } from "./thumbs.mjs";

// The ledger's pictures as the archive gets them: a log picture graded through the clip's saved grade or its profile's
// default look, from the cache alone; Rec.709 and what can't be graded sent as made; each sent again only when its grade
// changes, and no more at once than before.
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const usable = spawnSync(ffmpeg, ["-version"]).status === 0;
const root = mkdtempSync(join(tmpdir(), "grade-thumbs-test-"));
const run = (args, input) => execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", ...args], { input });

/** A LUT of size³ from a function of the code values, parsed as the app loads one. */
const lutOf = (size, f) => {
  const data = new Float32Array(size ** 3 * 3);
  for (let b = 0, i = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) data.set(f([r, g, b].map((v) => v / (size - 1))), i++ * 3);
  return parseCube(writeCube(size, data));
};
const INVERT = lutOf(2, ([r, g, b]) => [1 - r, 1 - g, 1 - b]);
const ROTATE = lutOf(2, ([r, g, b]) => [b, r, g]);
const SQUARE = lutOf(33, (c) => c.map((v) => v * v));
const IDENTITY = lutOf(2, (c) => c);

/** Each matrix's red and blue weights. */
const WEIGHTS = { bt601: [0.299, 0.114], bt709: [0.2126, 0.0722] };
/**
 * A flat picture as makeThumb writes one: a JPEG holding `colour`'s Y'CbCr in `matrix`, full range. Worked out here and
 * handed to the encoder as they are: ffmpeg 7.0's scale leaves a JPEG in BT.601 whatever matrix it's asked for.
 */
function still(colour, matrix = "bt601") {
  const [kr, kb] = WEIGHTS[matrix];
  const [r, g, b] = [16, 8, 0].map((shift) => ((colour >> shift) & 255) / 255);
  const y = kr * r + (1 - kr - kb) * g + kb * b;
  const levels = [255 * y, 128 + (255 * (b - y)) / (2 * (1 - kb)), 128 + (255 * (r - y)) / (2 * (1 - kr))];
  const frame = Buffer.concat(levels.map((level) => Buffer.alloc(320 * 180, Math.round(level))));
  const raw = ["-f", "rawvideo", "-pix_fmt", "yuvj444p", "-s", "320x180", "-i", "-"];
  return run([...raw, "-q:v", "3", "-f", "image2pipe", "-c:v", "mjpeg", "-"], frame);
}
/** The middle of a picture as a browser reads a JPEG (BT.601, full range), 0-255 a channel. */
const middle = (jpeg) => [
  ...run(
    [
      "-f",
      "image2pipe",
      "-i",
      "-",
      "-vf",
      "crop=32:32:144:74,scale=1:1:flags=area+accurate_rnd+full_chroma_int:in_color_matrix=bt601:in_range=pc,format=rgb24",
      "-f",
      "rawvideo",
      "-",
    ],
    jpeg,
  ),
];
const dims = (jpeg) =>
  execFileSync(FFPROBE, ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", "-"], { input: jpeg })
    .toString()
    .trim();
const near = (actual, expected, by = 3) =>
  expect(actual.map((v, k) => Math.abs(v - expected[k]) <= by)).toEqual([true, true, true]);

test.if(usable)(
  "a graded picture is the log one through the LUT, the same size, read in the clip's matrix",
  async () => {
    const log = still(0x305080);
    const before = middle(log);
    const inverted = await gradeStill(log, INVERT, { matrix: "bt601" });
    expect(inverted.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    near(
      middle(inverted),
      before.map((v) => 255 - v),
    );
    near(middle(await gradeStill(log, ROTATE, { matrix: "bt601" })), [before[2], before[0], before[1]]);
    near(
      middle(await gradeStill(log, SQUARE, { matrix: "bt601" })),
      before.map((v) => (v * v) / 255),
    );
    expect(dims(inverted)).toBe(dims(log));
    // A DJI still holds its clip's own BT.709 Y'CbCr: read in that, it's the colour it was; read as BT.601, it isn't.
    const dji = still(0x30a050, "bt709");
    near(middle(await gradeStill(dji, IDENTITY, { matrix: "bt709" })), [0x30, 0xa0, 0x50]);
    const misread = middle(await gradeStill(dji, IDENTITY, { matrix: "bt601" }));
    expect(misread.reduce((sum, v, k) => sum + Math.abs(v - [0x30, 0xa0, 0x50][k]), 0)).toBeGreaterThan(15);
  },
);

// The cache as the sender sees it: a log picture per clip, and what each clip's original was probed as, at a path that's
// gone (the clip has left this Mac).
const files = new Map();
const probed = {};
const bases = {
  dlog2: [
    { id: "none", file: null },
    { id: "aces", file: "aces.cube" },
    { id: "opendrt-colorful", file: "opendrt.cube" },
    { id: "p4p-01", file: "p4p.cube" },
  ],
  dlog: [{ id: "none", file: null }],
  rec709: [{ id: "none", file: null }],
};
const cubes = { "aces.cube": ROTATE, "opendrt.cube": INVERT, "p4p.cube": ROTATE };
const loadCube = async (file) => cubes[file];
const LOG = 0x406080;

function clip(name, profile) {
  const path = join(root, `${name}.jpg`);
  writeFileSync(path, still(LOG));
  files.set(name.toLowerCase(), path);
  probed[`/Volumes/gone/Original/${name}.MP4`] = {
    size: 1,
    mtimeMs: 1,
    meta: { profile, cameraKelvin: 5300, matrix: "bt601" },
  };
  return name;
}
/** A sender with a fake archive: what it was sent, by clip, and what it logged. */
function archive() {
  const sent = [];
  const warned = [];
  const sender = thumbSender({ lutSize: 17, warn: (message) => warned.push(message) });
  const send = (clips, { grades = {}, copies = new Set(), at } = {}) =>
    sender.send({
      clips,
      files,
      copies,
      probed,
      grades,
      bases,
      loadCube,
      put: async (c, bytes) => sent.push([c, bytes]),
      at,
    });
  return { sent, warned, send };
}
/** The key a clip of `profile` with the saved grade `saved` is recorded under. */
const keyFor = (saved, profile = "dlog2") =>
  thumbKey(
    resolveGrade(
      saved,
      bases[profile].map((b) => b.id),
    ),
  );
/** A clip's log picture in the cache. */
const picture = (name) => readFileSync(files.get(name.toLowerCase()));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test.if(usable)(
  "grades a log picture with its profile's default look, from the cache after its original is gone",
  async () => {
    const name = clip("DJI_20261108121231_0063_D", "dlog2");
    const clips = { [name]: {} };
    const { sent, send } = archive();
    expect(await send(clips)).toEqual({ more: false, error: null });
    expect(sent.map(([c]) => c)).toEqual([name]);
    // The default is OpenDRT Colorful, an inverter here.
    near(
      middle(sent[0][1]),
      middle(picture(name)).map((v) => 255 - v),
    );
    expect(clips[name].thumb).toBe(keyFor(undefined));
    expect(clips[name].thumb).toMatch(/^[0-9a-f]{12}$/);
  },
);

test.if(usable)("a saved grade wins over the default look", async () => {
  const name = clip("DJI_20261108121303_0064_D", "dlog2");
  const clips = { [name]: { thumb: AS_MADE } };
  const { sent, send } = archive();
  const grades = { [`${name}.MP4`]: { base: "p4p-01" } };
  await send(clips, { grades });
  const log = middle(picture(name));
  near(middle(sent[0][1]), [log[2], log[0], log[1]]);
  expect(clips[name].thumb).toBe(keyFor({ base: "p4p-01" }));
  expect(clips[name].thumb).not.toBe(keyFor(undefined));
});

test.if(usable)("Rec.709 goes as it was made: never graded, and not sent again", async () => {
  const name = clip("DJI_20261108121319_0065_D", "rec709");
  const old = clip("DJI_20261108121338_0066_D", "rec709");
  const clips = { [name]: {}, [old]: { thumb: AS_MADE } };
  const { sent, send } = archive();
  await send(clips);
  expect(sent.map(([c]) => c)).toEqual([name]);
  expect(sent[0][1]).toEqual(picture(name));
  expect(clips[name].thumb).toBe(AS_MADE);
  // Graded by hand, it's graded as it would export.
  await send(clips, { grades: { [`${old}.MP4`]: { exposure: 1 } } });
  expect(sent.map(([c]) => c)).toEqual([name, old]);
  expect(clips[old].thumb).toBe(keyFor({ exposure: 1 }, "rec709"));
});

test.if(usable)("sent again when its grade changes, and only then", async () => {
  const name = clip("DJI_20261108121432_0067_D", "dlog2");
  const clips = { [name]: {} };
  const { sent, send } = archive();
  await send(clips);
  await send(clips);
  expect(sent.length).toBe(1);
  // Saved as the default it already went through: the same grade.
  await send(clips, { grades: { [`${name}.MP4`]: { base: "opendrt-colorful", exposure: 0 } } });
  expect(sent.length).toBe(1);
  await send(clips, { grades: { [`${name}.MP4`]: { base: "opendrt-colorful", exposure: 0.5 } } });
  expect(sent.length).toBe(2);
  const brighter = clips[name].thumb;
  // Deflicker is the export's alone: a still doesn't change with it.
  await send(clips, { grades: { [`${name}.MP4`]: { base: "opendrt-colorful", exposure: 0.5, deflicker: "strong" } } });
  expect(sent.length).toBe(2);
  expect(clips[name].thumb).toBe(brighter);
  // Back to no grade: the default look again.
  await send(clips);
  expect(sent.length).toBe(3);
  expect(clips[name].thumb).toBe(keyFor(undefined));
});

test.if(usable)("the first pass sends what went ungraded before a look's worth at a time", async () => {
  const clips = {};
  for (let i = 0; i < 30; i++)
    clips[clip(`DJI_20261108130000_${String(100 + i).padStart(4, "0")}_D`, "dlog2")] = { thumb: AS_MADE };
  const { sent, send } = archive();
  expect(await send(clips)).toEqual({ more: true, error: null });
  expect(sent.length).toBe(THUMBS_AT_ONCE);
  expect(await send(clips)).toEqual({ more: false, error: null });
  expect(sent.length).toBe(30);
  expect(new Set(sent.map(([c]) => c)).size).toBe(30);
  await send(clips);
  expect(sent.length).toBe(30);
}, 30_000);

test.if(usable)(
  "what can't be graded goes as made: no LUT for its look (logged once), or made from the graded copy",
  async () => {
    const bare = clip("DJI_20261108121507_0068_D", "dlog");
    const copy = clip("DJI_20261108121528_0069_D", "dlog2");
    const clips = { [bare]: {}, [copy]: {} };
    const { sent, warned, send } = archive();
    const copies = new Set([copy.toLowerCase()]);
    await send(clips, { copies });
    await send(clips, { copies });
    expect(sent.map(([c]) => c).sort()).toEqual([bare, copy]);
    for (const [c, bytes] of sent) expect(bytes).toEqual(picture(c));
    expect(clips[bare].thumb).toBe(AS_MADE);
    expect(clips[copy].thumb).toBe(AS_MADE);
    expect(warned).toEqual([`${bare}: no LUT for its look, so its picture goes ungraded`]);
  },
);

test.if(usable)("a send that fails stops the batch, and says why", async () => {
  const name = clip("DJI_20261108121636_0072_D", "dlog2");
  const clips = { [name]: {} };
  const sender = thumbSender({ lutSize: 17, warn: () => {} });
  const put = async () => {
    throw new Error("Sending a picture failed (503)");
  };
  const result = await sender.send({ clips, files, copies: new Set(), probed, grades: {}, bases, loadCube, put });
  expect(result).toEqual({ more: false, error: "Sending a picture failed (503)" });
  expect(clips[name].thumb).toBeUndefined();
});
