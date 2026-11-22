import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { writeCube } from "./color.mjs";
import { exportClip, exportFilter, exportFrame, extractAudio, FFPROBE, frameFilter } from "./media.mjs";

// The export's filter graph, and ffmpeg's deflicker in it: off it's the graph exports were always made with; on, a
// flickering clip comes out steady, a steady one comes out as it was, and a frame export is that frame of the export.
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const usable = spawnSync(ffmpeg, ["-version"]).status === 0;
const root = mkdtempSync(join(tmpdir(), "grade-media-test-"));
const cube = join(root, "identity.cube");
const steady = join(root, "steady.mp4");
const flicker = join(root, "flicker.mp4");
const fps = 24;

const run = (args) => execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", ...args]);

/** A still grey ramp, 2 s at 24 fps; `flicker` adds a brightness swing every 3 frames, as 50 Hz light at 30 fps. */
function clip(dst, { flicker = false } = {}) {
  const swing = flicker ? ",eq=brightness='0.05*sin(2*PI*n/3)':eval=frame" : "";
  const ramp = `color=c=black:s=320x180:r=${fps}:d=2,format=yuv420p,geq=lum='40+150*X/W':cb=128:cr=128${swing}`;
  run(["-y", "-f", "lavfi", "-i", ramp, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "1", dst]);
}

/** Each frame's mean luma (8-bit levels). */
const lumas = (file) => {
  const vf = "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-";
  const stats = run(["-i", file, "-vf", vf, "-f", "null", "-"]);
  return [...stats.toString().matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
};
/**
 * Frame `k` of a video as small RGB, read as the export writes it (BT.709, limited range). accurate_rnd: swscale's
 * default 8-bit YUV→RGB path reads limited range about 2 levels low.
 */
const frameAt = (file, k) => {
  const scale = "scale=160:90:flags=area+accurate_rnd+full_chroma_int:in_color_matrix=bt709:in_range=tv";
  const vf = `select=eq(n\\,${k}),${scale},format=rgb24`;
  return run(["-i", file, "-vf", vf, "-frames:v", "1", "-f", "rawvideo", "-"]);
};
const still = (png) => run(["-i", png, "-vf", "scale=160:90:flags=area,format=rgb24", "-f", "rawvideo", "-"]);
/** Frame `k` of a video as its own 8-bit Y, Cb and Cr planes. */
const planesAt = (file, k) => {
  const raw = run(["-i", file, "-vf", `select=eq(n\\,${k})`, "-frames:v", "1", "-pix_fmt", "yuv420p", "-f", "rawvideo", "-"]);
  const n = 320 * 180;
  return { y: raw.subarray(0, n), cb: raw.subarray(n, n * 1.25), cr: raw.subarray(n * 1.25) };
};
const meanDiff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
const meanShift = (a, b) => a.reduce((s, v, i) => s + (b[i] - v), 0) / a.length;
const spread = (values) => Math.max(...values) - Math.min(...values);

beforeAll(() => {
  if (!usable) return;
  const id = new Float32Array(2 ** 3 * 3);
  for (let b = 0, i = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) id.set([r, g, b], i++ * 3);
  writeFileSync(cube, writeCube(2, id, "identity"));
  clip(steady);
  clip(flicker, { flicker: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("off, the export's filter graph is the grade alone, as exports were always made", () => {
  const grade = [
    "scale=in_color_matrix=bt2020nc:in_range=tv",
    "format=gbrp16le",
    "lut3d=file='/tmp/a\\:b.cube':interp=tetrahedral",
  ].join(",");
  const old = [
    grade,
    "scale=out_color_matrix=bt709:out_range=tv",
    "format=yuv420p",
    "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
  ].join(",");
  for (const deflicker of [undefined, null, "", "nonsense"]) {
    expect(exportFilter({ matrix: "bt2020nc", cube: "/tmp/a:b.cube", deflicker })).toBe(old);
    expect(frameFilter({ matrix: "bt2020nc", cube: "/tmp/a:b.cube", deflicker })).toBe(`${grade},format=rgb24`);
  }
});

test("on, deflicker comes after the grade LUT, in limited-range 16-bit YUV read back as such", () => {
  const deflickered = (pixFmt, size) =>
    [
      "lut3d=file='/tmp/x.cube':interp=tetrahedral",
      "scale=out_color_matrix=bt709:out_range=tv",
      `format=${pixFmt}`,
      `deflicker=size=${size}:mode=am`,
      "scale=in_color_matrix=bt709:in_range=tv",
    ].join(",");
  const tv = ":out_range=tv,format=yuv420p,setparams=";
  const graph = (filter, deflicker) => filter({ cube: "/tmp/x.cube", deflicker });
  expect(graph(exportFilter, "light")).toContain(`${deflickered("yuv420p16le", 6)}${tv}`);
  expect(graph(exportFilter, "strong")).toContain(`${deflickered("yuv420p16le", 12)}${tv}`);
  expect(graph(frameFilter, "light")).toEndWith(`${deflickered("yuv444p16le", 6)},format=rgb24`);
});

test.if(usable)("deflicker evens out a flickering clip, every frame kept", async () => {
  const off = join(root, "flicker-off.mp4");
  const on = join(root, "flicker-light.mp4");
  await exportClip({ src: flicker, dst: off, cube, duration: 2 });
  await exportClip({ src: flicker, dst: on, cube, deflicker: "light", duration: 2 });
  const [before, after] = [lumas(off), lumas(on)];
  expect(after.length).toBe(before.length);
  expect(after.length).toBe(2 * fps);
  // Away from the end, where the window runs out of frames to look ahead to.
  const middle = (values) => values.slice(0, -12);
  expect(spread(middle(before))).toBeGreaterThan(15);
  expect(spread(middle(after))).toBeLessThan(1.5);
  // Evened out to the clip's own average, not brightened or darkened overall.
  const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;
  expect(Math.abs(mean(middle(after)) - mean(middle(before)))).toBeLessThan(1.5);
}, 60_000);

test.if(usable)("deflicker leaves a clip that doesn't flicker as it was", async () => {
  const off = join(root, "steady-off.mp4");
  const on = join(root, "steady-strong.mp4");
  await exportClip({ src: steady, dst: off, cube, duration: 2 });
  await exportClip({ src: steady, dst: on, cube, deflicker: "strong", duration: 2 });
  const [a, b] = [lumas(off), lumas(on)];
  expect(b.length).toBe(a.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(0.5);
  // No shift in brightness or colour, to an eighth of a level: what differs is the dither of the 16-bit step.
  const [p, q] = [planesAt(off, 10), planesAt(on, 10)];
  const planes = ["y", "cb", "cr"];
  const shifts = Object.fromEntries(planes.map((k) => [k, Math.round(meanShift(p[k], q[k]) * 8) / 8 || 0]));
  expect({ shifts, noise: Object.fromEntries(planes.map((k) => [k, meanDiff(p[k], q[k]) < 2])) }).toEqual({
    shifts: { y: 0, cb: 0, cr: 0 },
    noise: { y: true, cb: true, cr: true },
  });
}, 60_000);

test.if(usable)("a frame export with deflicker is that frame of the deflickered export", async () => {
  const video = join(root, "frame-source-light.mp4");
  await exportClip({ src: flicker, dst: video, cube, deflicker: "light", duration: 2 });
  const k = 10;
  const time = (k - 0.25) / fps;
  const on = join(root, "frame-light.png");
  const off = join(root, "frame-off.png");
  await exportFrame({ src: flicker, dst: on, cube, deflicker: "light", time });
  await exportFrame({ src: flicker, dst: off, cube, time });
  const exported = frameAt(video, k);
  expect(meanDiff(still(on), exported)).toBeLessThan(2);
  // Frame 10 is on a bright swing: without deflicker the still is that much brighter than the export's frame.
  expect(meanDiff(still(off), exported)).toBeGreaterThan(5);
}, 60_000);

/** The codecs a file's streams are in. */
const codecs = (file) => {
  const ask = ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file];
  return execFileSync(FFPROBE, ask).toString().trim().split(/[\s,]+/);
};
/** A digest of a file's sound as it's encoded. */
const soundOf = (file) => run(["-i", file, "-map", "0:a:0", "-c", "copy", "-f", "md5", "-"]).toString();
/** A second of picture with `sound` on it, if any. */
function withSound(name, sound) {
  const file = join(root, name);
  const tone = sound ? ["-f", "lavfi", "-i", "sine=d=1:r=48000"] : [];
  const codec = sound ? ["-c:a", sound, "-shortest"] : [];
  run(["-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=1", ...tone, "-c:v", "libx264", ...codec, file]);
  return file;
}

test.if(usable)("takes a clip's sound as it is, or as AAC when an .m4a can't hold it", async () => {
  const aac = withSound("sound.mp4", "aac");
  const out = join(root, "audio/2026-11-18/sound.mp4.m4a");
  expect(await extractAudio(aac, out)).toBe(true);
  expect(codecs(out)).toEqual(["aac"]);
  expect(soundOf(out)).toBe(soundOf(aac));
  const pcm = join(root, "audio/pcm.mov.m4a");
  expect(await extractAudio(withSound("pcm.mov", "pcm_s16le"), pcm)).toBe(true);
  expect(codecs(pcm)).toEqual(["aac"]);
});

test.if(usable)("a clip without sound has none to take, and one cut short leaves nothing", async () => {
  const none = join(root, "audio/none.mp4.m4a");
  expect(await extractAudio(withSound("none.mp4", null), none)).toBe(false);
  expect(existsSync(none)).toBe(false);
  const clipWithSound = withSound("cut.mp4", "aac");
  await expect(
    extractAudio(clipWithSound, join(root, "cut/cut.m4a"), { signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  await expect(extractAudio(join(root, "missing.mp4"), join(root, "cut/missing.m4a"))).rejects.toThrow();
  expect(existsSync(join(root, "cut")) ? readdirSync(join(root, "cut")) : []).toEqual([]);
});
