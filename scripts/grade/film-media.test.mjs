import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { writeCube } from "./color.mjs";
import { exportClip, exportTrim, FFPROBE, makePreview, PREVIEW_KEYS, PREVIEW_RATE, previewDims, trimFrames } from "./media.mjs";

// A film's assets as ffmpeg makes them: a preview copy is the clip graded as its export is, small, with key frames for
// seeking and its sound as it was; a trim is that part of the clip's export, frame for frame, its sound cut with it.
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const usable = spawnSync(ffmpeg, ["-version"]).status === 0;
const root = mkdtempSync(join(tmpdir(), "grade-film-media-test-"));
const cube = join(root, "curve.cube");
/** 59.94 fps, as the Pocket 4P's 4K60: frame k is at k × 1001/60000 s. */
const FPS = 60000 / 1001;
const at = (k) => (k * 1001) / 60000;
const source = join(root, "source.mp4");
const SECONDS = 4;
/** When the source's beep starts. */
const BEEP = 1.5;
const flicker = join(root, "flicker.mp4");

const run = (args) => execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", ...args], { maxBuffer: 1 << 28 });
const probed = (file, select, entries) =>
  JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-select_streams", select, "-show_entries", entries, "-of", "json", file]));
/** Every frame's time, and whether it's a key frame. */
const framesOf = (file) =>
  probed(file, "v:0", "packet=pts_time,flags")
    .packets.map((p) => ({ at: Number(p.pts_time), key: p.flags.startsWith("K") }))
    .sort((a, b) => a.at - b.at);
/** Frame `k` as small RGB, read as exports are written (BT.709, limited range). */
const frameAt = (file, k) => {
  const scale = "scale=160:90:flags=area+accurate_rnd+full_chroma_int:in_color_matrix=bt709:in_range=tv";
  return run(["-i", file, "-vf", `select=eq(n\\,${k}),${scale},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"]);
};
const meanDiff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
/** Each frame's mean luma. */
const lumas = (file) => {
  const vf = "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-";
  return [...run(["-i", file, "-vf", vf, "-f", "null", "-"]).toString().matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
};
/** A file's first sound, as 48 kHz mono samples. */
const samples = (file) => {
  const raw = run(["-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"]);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
};
/** When a sound first gets loud, in seconds. */
const onset = (sound) => sound.findIndex((v) => Math.abs(v) > 0.25) / 48000;
const rms = (sound) => Math.sqrt(sound.reduce((sum, v) => sum + v * v, 0) / (sound.length || 1));
const soundDigest = (file) => run(["-i", file, "-map", "0:a:0", "-c", "copy", "-f", "md5", "-"]).toString();

/** A noisy, moving clip of that size, with sound. */
function moving(name, size, rate, seconds) {
  const file = join(root, name);
  run([
    "-y", "-f", "lavfi", "-i", `testsrc2=s=${size}:r=${rate}:d=${seconds},noise=alls=10:allf=t`,
    "-f", "lavfi", "-i", `sine=d=${seconds}:r=48000`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file,
  ]);
  return file;
}

beforeAll(() => {
  if (!usable) return;
  const size = 17;
  const lut = new Float32Array(size ** 3 * 3);
  const curve = (v, power) => (v / (size - 1)) ** power;
  for (let b = 0, i = 0; b < size; b++)
    for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) lut.set([curve(r, 0.8), curve(g, 1.1), curve(b, 0.9)], i++ * 3);
  writeFileSync(cube, writeCube(size, lut, "curve"));
  // Every frame its own colours (the hue turns), as 10-bit HEVC; a quiet hum throughout, and a beep from BEEP to
  // BEEP + 0.2 s.
  const sound = `0.1*sin(2*PI*300*t)+if(between(t,${BEEP},${BEEP + 0.2}),0.5*sin(2*PI*1000*t),0)`;
  run([
    "-y",
    "-f", "lavfi", "-i", `testsrc2=s=640x360:r=60000/1001:d=${SECONDS},hue=h=n*23,format=yuv420p10le`,
    "-f", "lavfi", "-i", `aevalsrc='${sound}':s=48000:d=${SECONDS}`,
    "-c:v", "libx265", "-preset", "ultrafast", "-crf", "10", "-x265-params", "log-level=error", "-tag:v", "hvc1",
    "-c:a", "aac", "-b:a", "256k", source,
  ]);
  // Flat grey whose brightness swings every 3 frames, as 50 Hz light at 30 fps does, at 24 fps.
  const swing = "eq=brightness='0.05*sin(2*PI*n/3)':eval=frame";
  run(["-y", "-f", "lavfi", "-i", `color=c=0x707070:s=320x180:r=24:d=3,format=yuv420p,${swing}`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "1", flicker]);
}, 120_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const clip = { src: source, cube, duration: SECONDS, width: 640, height: 360, fps: FPS };
let whole = null;
/** The source's whole export, made once. */
async function wholeExport() {
  whole ??= exportClip({ ...clip, dst: join(root, "whole.mp4") }).then(() => join(root, "whole.mp4"));
  return whole;
}

// ---- trims ----------------------------------------------------------------------------------------------------------

test("a trim holds the frame on screen at its start to the last that starts before its end", async () => {
  if (!usable) return;
  // 1.2 s is in frame 71; 2.5 s in frame 149, which starts before it.
  expect(await trimFrames(source, 1.2, 2.5)).toEqual({ first: at(71), last: at(149), until: at(150), slack: at(1) / 2, timeBase: "1/60000" });
  // A time rounded to the millisecond lands on the frame it was: frame 30 starts at 0.5005 s.
  expect((await trimFrames(source, 0.5, 1.001)).first).toBe(at(30));
  expect((await trimFrames(source, 0.501, 1.001)).first).toBe(at(30));
  // An end on a frame's start leaves that frame out: frame 60 starts at 1.001 s.
  expect((await trimFrames(source, 0.5, 1.001)).last).toBe(at(59));
  expect((await trimFrames(source, 0.5, 1.0005)).last).toBe(at(59));
  expect((await trimFrames(source, 0.5, 1.002)).last).toBe(at(60));
  // From the clip's start to its end.
  expect(await trimFrames(source, 0, SECONDS)).toMatchObject({ first: 0, last: at(239), until: at(240) });
});

test.if(usable)("a trim's first and last frames are the whole export's at those times, and it lasts as long as they're on screen", async () => {
  const full = await wholeExport();
  const dst = join(root, "trim.mp4");
  const made = await exportTrim({ ...clip, dst, start: 1.2, end: 2.5 });
  expect(made).toMatchObject({ actualStart: at(71), actualEnd: at(149) });
  expect(["gpu", "cpu"]).toContain(made.encoder);
  const frames = framesOf(dst);
  expect(frames).toHaveLength(149 - 71 + 1);
  // Its own frames start at 0, at the original's spacing, a key frame every quarter second.
  for (const [i, frame] of frames.entries()) expect(frame.at).toBeCloseTo(at(i), 5);
  expect(frames.filter((f) => f.key).map((f) => Math.round(f.at * 4))).toEqual([0, 1, 2, 3, 4, 5]);
  const { duration } = probed(dst, "v:0", "stream=duration").streams[0];
  expect(Number(duration)).toBeCloseTo(at(79), 4);
  // Each end is that very frame of the export: every frame has colours of its own, so a neighbour is far off.
  const ends = [[0, 71], [78, 149]];
  for (const [k, of] of ends) {
    const mine = frameAt(dst, k);
    expect(meanDiff(mine, frameAt(full, of))).toBeLessThan(1.5);
    for (const next of [of - 1, of + 1]) expect(meanDiff(mine, frameAt(full, next))).toBeGreaterThan(6);
  }
}, 120_000);

test.if(usable)("a trim's sound starts on its first frame, in step with the original, and lasts as long as the picture", async () => {
  const dst = join(root, "trim-sound.mp4");
  const made = await exportTrim({ ...clip, dst, start: 1.2, end: 2.5 });
  expect(probed(dst, "a:0", "stream=codec_name,sample_rate").streams[0]).toEqual({ codec_name: "aac", sample_rate: "48000" });
  const [original, trimmed] = [samples(source), samples(dst)];
  // The beep comes where it was, counted from the first frame: to well within a millisecond.
  expect(Math.abs(onset(trimmed) + made.actualStart - onset(original))).toBeLessThan(0.0005);
  expect(Math.abs(onset(original) - BEEP)).toBeLessThan(0.002);
  // As long as 79 frames are on screen: so the file says, and the hum runs to the cut and no further. AAC comes in
  // blocks of 1024 samples, and a decoder that doesn't read the file's edit list plays the last one's padding, silence.
  const { duration } = probed(dst, "a:0", "stream=duration").streams[0];
  expect(Math.abs(Number(duration) - at(79))).toBeLessThan(1 / 48000);
  const cut = Math.round(at(79) * 48000);
  expect(trimmed.length - cut).toBeGreaterThanOrEqual(-1);
  expect(trimmed.length - cut).toBeLessThan(1024);
  expect(rms(trimmed.subarray(cut - 480, cut))).toBeCloseTo(0.1 / Math.SQRT2, 2);
  expect(rms(trimmed.subarray(cut + 48))).toBeLessThan(0.005);
}, 120_000);

test.if(usable)("a trim from a clip's very start, and one running past its end, keep to the clip's frames and sound", async () => {
  const head = join(root, "trim-head.mp4");
  const tail = join(root, "trim-tail.mp4");
  expect(await exportTrim({ ...clip, dst: head, start: 0, end: 0.3 })).toMatchObject({ actualStart: 0, actualEnd: at(17) });
  expect(framesOf(head)).toHaveLength(18);
  expect(await exportTrim({ ...clip, dst: tail, start: 3.5, end: 9 })).toMatchObject({ actualStart: at(209), actualEnd: at(239) });
  expect(framesOf(tail)).toHaveLength(31);
  const { duration } = probed(tail, "a:0", "stream=duration").streams[0];
  expect(Math.abs(Number(duration) - at(31))).toBeLessThan(1 / 48000);
  const full = await wholeExport();
  expect(meanDiff(frameAt(tail, 30), frameAt(full, 239))).toBeLessThan(1.5);
}, 120_000);

test.if(usable)("deflicker inside a trim evens each frame out with the frames after it, as the whole export does", async () => {
  const full = join(root, "flicker-whole.mp4");
  const dst = join(root, "flicker-trim.mp4");
  const asked = { src: flicker, cube, duration: 3, width: 320, height: 180, fps: 24, deflicker: "strong" };
  await exportClip({ ...asked, dst: full });
  // Frames 24 to 35: deflicker looks 11 past the last of them.
  expect(await exportTrim({ ...asked, dst, start: 1, end: 1.5 })).toMatchObject({ actualStart: 1, actualEnd: 35 / 24 });
  const [whole, part] = [lumas(full), lumas(dst)];
  expect(part).toHaveLength(12);
  for (const [i, luma] of part.entries()) expect(Math.abs(luma - whole[24 + i])).toBeLessThan(0.5);
  // The flicker is gone in both, so the match isn't by chance.
  expect(Math.max(...part) - Math.min(...part)).toBeLessThan(1.5);
}, 120_000);

test.if(usable)("an identical trim is the same frames, and one of no frames is refused", async () => {
  const [a, b] = [join(root, "same-a.mp4"), join(root, "same-b.mp4")];
  await exportTrim({ ...clip, dst: a, start: 2, end: 2.2, encoder: "cpu" });
  await exportTrim({ ...clip, dst: b, start: 2, end: 2.2, encoder: "cpu" });
  expect(framesOf(a)).toEqual(framesOf(b));
  await expect(exportTrim({ ...clip, dst: join(root, "none.mp4"), start: 5, end: 6 })).rejects.toThrow("no frames");
  expect(readdirSync(root).filter((f) => f.startsWith("."))).toEqual([]);
}, 120_000);

// ---- preview copies -------------------------------------------------------------------------------------------------

test("a preview copy is 1920 on its long side, either way up, and never larger than its clip", () => {
  expect(previewDims(3840, 2160)).toEqual({ width: 1920, height: 1080 });
  expect(previewDims(1728, 3072)).toEqual({ width: 1080, height: 1920 });
  expect(previewDims(1080, 1920)).toEqual({ width: 1080, height: 1920 });
  expect(previewDims(1280, 720)).toEqual({ width: 1280, height: 720 });
  expect(previewDims(4096, 2160)).toEqual({ width: 1920, height: 1012 });
});

test.if(usable)("a preview copy is the export's picture made small, its bitrate as set, key frames every half second, sound as it was", async () => {
  const wide = moving("wide.mp4", "2560x1440", 30, 3);
  const dst = join(root, "preview-wide.mp4");
  const made = await makePreview({ src: wide, dst, cube, duration: 3, width: 2560, height: 1440, fps: 30 });
  expect(made).toMatchObject({ width: 1920, height: 1080 });
  const stream = probed(dst, "v:0", "stream=width,height,codec_name,pix_fmt,color_range,color_space,color_transfer,color_primaries");
  expect(stream.streams[0]).toEqual({
    codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p",
    color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709",
  });
  const frames = framesOf(dst);
  expect(frames).toHaveLength(90);
  const keys = frames.filter((f) => f.key).map((f) => f.at);
  expect(keys).toEqual([0, 0.5, 1, 1.5, 2, 2.5]);
  for (const [i, t] of keys.entries()) expect(t - (keys[i - 1] ?? 0)).toBeLessThanOrEqual(PREVIEW_KEYS);
  expect(soundDigest(dst)).toBe(soundDigest(wide));
  // Small: about PREVIEW_RATE, where the export at full quality is many times that.
  const bits = (statSync(dst).size * 8) / 3;
  expect(bits).toBeLessThan(PREVIEW_RATE * 1.35);
  expect(bits).toBeGreaterThan(PREVIEW_RATE * 0.4);
  // Graded as the export is: a frame of each, made as small, is the same picture.
  const full = join(root, "wide-export.mp4");
  await exportClip({ src: wide, dst: full, cube, duration: 3, width: 2560, height: 1440, fps: 30 });
  expect(meanDiff(frameAt(dst, 40), frameAt(full, 40))).toBeLessThan(3);
}, 120_000);

test.if(usable)("an upright clip's preview copy stays upright, and one already small keeps its size", async () => {
  const tall = moving("tall.mp4", "1440x2560", 25, 1);
  const dst = join(root, "preview-tall.mp4");
  expect(await makePreview({ src: tall, dst, cube, duration: 1, width: 1440, height: 2560, fps: 25 })).toMatchObject({ width: 1080, height: 1920 });
  expect(probed(dst, "v:0", "stream=width,height").streams[0]).toEqual({ width: 1080, height: 1920 });
  const small = join(root, "preview-small.mp4");
  await makePreview({ ...clip, dst: small });
  expect(probed(small, "v:0", "stream=width,height").streams[0]).toEqual({ width: 640, height: 360 });
  // 59.94 fps keeps its every frame.
  expect(framesOf(small)).toHaveLength(240);
}, 120_000);
