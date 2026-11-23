// ffmpeg and file work for the grade app: reading a clip's camera metadata, its thumbnail and the small proxy the
// browser previews, baking a grade into a graded copy, and finding clips on the camera's card.
import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { CALIBRATION, blockMeans, deflickerFrames, profileOf } from "./color.mjs";

const exec = promisify(execFile);
export const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic;
export const FFPROBE = process.env.FFPROBE_PATH || ffprobeStatic.path;

export const VIDEO = /\.(mp4|mov)$/i;

/** What the grade app needs to know about a clip, from ffprobe and the camera's own tags. */
export async function probe(file) {
  const { stdout } = await exec(FFPROBE, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const info = JSON.parse(stdout);
  const v = info.streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!v) throw new Error(`${basename(file)} has no video`);
  // DJI files carry a small JPEG of the clip; reading it is far cheaper than decoding a frame off the card.
  const still = info.streams.find((s) => s.disposition?.attached_pic === 1 && /mjpeg|png/.test(s.codec_name));
  const tags = info.format.tags ?? {};
  const [n, d] = String(v.avg_frame_rate || "0/1").split("/").map(Number);
  const kelvin = Number(tags["com.dji.camera.WhiteBalanceKelvin"]);
  const a = info.streams.find((s) => s.codec_type === "audio");
  const audioBitrate = Number(a?.bit_rate) || 0;
  return {
    width: v.width,
    height: v.height,
    fps: d ? n / d : 0,
    duration: Number(info.format.duration) || 0,
    pixFmt: v.pix_fmt,
    matrix: v.color_space === "bt2020nc" ? "bt2020nc" : "bt709",
    profile: profileOf(tags["com.dji.camera.ColorGammaSxS"], v.color_transfer),
    cameraKelvin: kelvin > 0 ? kelvin : null,
    cameraTint: Number(tags["com.dji.camera.WhiteBalanceTintCc"]) || 0,
    iso: Number(tags["com.dji.camera.ExposureIndexAsa"]) || null,
    lens: tags["com.dji.camera.LensType"] || null,
    created: tags.creation_time || null,
    audio: Boolean(a),
    still: still ? still.index : null,
    // Bits per second, for exporting below full quality at a known size.
    videoBitrate: Number(v.bit_rate) || Math.max(0, (Number(info.format.bit_rate) || 0) - audioBitrate),
    audioBitrate,
  };
}

/** Run ffmpeg; `signal` stops it (the promise then rejects, and writeAtomically removes the half-written file). */
function run(args, { onProgress, duration, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args, ...(onProgress ? ["-progress", "pipe:1", "-nostats"] : [])], { signal });
    let err = "";
    let buf = "";
    // Nothing is said of a run once it's over: output can still be on its way when an abort or a failure ends it.
    let over = false;
    child.stderr.on("data", (c) => {
      err = (err + c).slice(-4000);
    });
    child.stdout.on("data", (c) => {
      if (over) return;
      buf += c;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && duration && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    child.on("error", (error) => {
      over = true;
      reject(error);
    });
    child.on("close", (code) => {
      over = true;
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `ffmpeg exited ${code}`));
    });
  });
}

/** ffmpeg filter-argument escaping for a file path inside a filtergraph. */
const filterPath = (p) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

async function writeAtomically(dst, make) {
  await mkdir(dirname(dst), { recursive: true });
  const tmp = join(dirname(dst), `.${basename(dst)}.part${dst.slice(dst.lastIndexOf("."))}`);
  try {
    await make(tmp);
    await rename(tmp, dst);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** How every preview-side video is encoded, so the browser decodes proxies and the calibration clip alike. */
const proxyVideo = (g) => [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", String(g), "-keyint_min", String(g),
  "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", "-color_range", "tv",
];

/**
 * The preview proxy: the clip's own code values (no grade), 1280 px on the long side, 8-bit limited range, a key
 * frame every half second for scrubbing. HLG is moved to the BT.709 matrix here so the browser decodes every proxy
 * the same way. It is tagged with the sRGB transfer so the browser hands the values to WebGL untouched.
 */
export async function makeProxy(src, dst, { matrix = "bt709", fps = 24 } = {}) {
  const g = Math.max(1, Math.round(fps / 2));
  await writeAtomically(dst, (tmp) =>
    run([
      "-i", src,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", `scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)':flags=lanczos:in_color_matrix=${matrix}:out_color_matrix=bt709:in_range=tv:out_range=tv,format=yuv420p`,
      ...proxyVideo(g),
      "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", tmp,
    ]),
  );
}

/**
 * A grey ramp encoded exactly as proxies are, and what ffmpeg decodes each step to. The browser decodes it too and
 * corrects its preview by the difference, since some decoders (software ones especially) land a few levels off.
 */
export async function makeCalibration(dst) {
  const { cols, block, size } = CALIBRATION;
  const v = `floor(X/${block[0]})+${cols}*floor(Y/${block[1]})`;
  await writeAtomically(dst, (tmp) =>
    run([
      "-f", "lavfi", "-i", `color=c=black:s=${size[0]}x${size[1]}:r=24:d=1,format=rgb24,geq=r='${v}':g='${v}':b='${v}'`,
      "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
      ...proxyVideo(12), "-movflags", "+faststart", tmp,
    ]),
  );
  const raw = await new Promise((resolve, reject) => {
    // accurate_rnd: swscale's default 8-bit YUV→RGB path reads limited range about 2 levels low.
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", dst, "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int,format=rgb24", "-f", "rawvideo", "-"]);
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`))));
  });
  return blockMeans(raw, 3);
}

/**
 * A small ungraded still for the clip list (the browser grades it): the file's own embedded JPEG when it has one
 * (`still`, a stream index), else a frame decoded `at` seconds in.
 */
export async function makeThumb(src, dst, { still = null, at = 1 } = {}) {
  const scale = "scale='if(gt(iw,ih),320,-2)':'if(gt(iw,ih),-2,320)'";
  const input = still === null ? ["-ss", String(at), "-i", src, "-map", "0:v:0"] : ["-i", src, "-map", `0:${still}`];
  await writeAtomically(dst, (tmp) => run([...input, "-frames:v", "1", "-vf", scale, "-q:v", "3", tmp]));
}

/**
 * A clip's sound alone, as it is in the file (encoded only when an .m4a can't hold it), for Whisper to hear once the clip
 * has gone. Says whether the clip has any.
 */
export async function extractAudio(src, dst, { signal } = {}) {
  const ask = ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", src];
  const { stdout } = await exec(FFPROBE, ask, { signal });
  const [codec] = stdout.trim().split(/[\s,]/);
  if (!codec) return false;
  const sound = codec === "aac" || codec === "alac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"];
  await writeAtomically(dst, (tmp) => run(["-i", src, "-map", "0:a:0", "-vn", ...sound, tmp], { signal }));
  return true;
}

/**
 * Bake a grade into a graded copy, from the 10-bit original at 16-bit precision: the clip's LUT through ffmpeg's
 * tetrahedral lut3d, out as 8-bit H.264 BT.709 with a key frame every quarter second, sound copied: near lossless at
 * full `quality`, or a known share of the original's `videoBitrate` below it (exportRate). `deflicker`, the grade's
 * level, evens out each frame's brightness with the frames after it (exportFilter).
 *
 * `encoder` is what's to encode it, the GPU only from GPU_FROM up; decoding and the filters are the CPU's either way.
 * A clip the GPU can't encode (no VideoToolbox in this ffmpeg, a size it doesn't take, an error midway) is encoded on the
 * CPU from the start, and `onFallback` hears why. Says what encoded it, and that reason as `fallback`.
 */
export async function exportClip({
  src, dst, cube, matrix = "bt709", deflicker = null, duration, width, height, fps, quality = 100, videoBitrate = 0,
  encoder = "gpu", onProgress, onFallback, signal,
}) {
  const encode = (on) =>
    writeAtomically(dst, (tmp) =>
      run(
        [
          "-i", src,
          "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "0",
          "-vf", exportFilter({ matrix, cube, deflicker }),
          ...exportVideo(on, { quality, videoBitrate, width, height, fps }), "-force_key_frames", "expr:gte(t,n_forced*0.25)",
          "-c:a", "copy", "-movflags", "+faststart", tmp,
        ],
        { onProgress, duration, signal },
      ),
    );
  return onGpuOrCpu(quality < GPU_FROM ? "cpu" : encoder, encode, { signal, onFallback });
}

/**
 * Runs `encode(on)` on the GPU, or on the CPU when that's what's asked. A GPU that can't encode it gives way to the CPU
 * from the start, and `onFallback` hears why. Says what encoded it, and that reason as `fallback`.
 */
async function onGpuOrCpu(encoder, encode, { signal, onFallback }) {
  if (encoder === "cpu") {
    await encode("cpu");
    return { encoder: "cpu" };
  }
  try {
    await encode("gpu");
    return { encoder: "gpu" };
  } catch (e) {
    // Stopped, or no room to write it: nothing the CPU would do better.
    if (signal?.aborted || /No space left/.test(e.message)) throw e;
    const [why] = e.message.replace(/ @ 0x[0-9a-f]+/g, "").split("\n");
    onFallback?.(why);
    await encode("cpu");
    return { encoder: "cpu", fallback: why };
  }
}

/**
 * The original's code values, read as limited range at 16 bits, through a clip's grade LUT. `size`, scale's own
 * arguments, makes it smaller first.
 */
const gradeFilter = (matrix, cube, size = "") =>
  `scale=${size ? `${size}:` : ""}in_color_matrix=${matrix}:in_range=tv,format=gbrp16le,lut3d=file='${filterPath(cube)}':interp=tetrahedral`;

/**
 * ffmpeg's deflicker, after the grade: each frame's luma scaled by one factor, so its mean matches the mean over it
 * and the next `frames - 1` frames. It goes after the LUT, not on the log original, because it scales: a change in
 * light is an offset in log code values, so scaling them would leave the shadows flickering and overshoot the
 * highlights, while in the graded Rec.709 picture it's close to a scale, and the brightness evened out is the one
 * the viewer sees. It runs on that picture as the export is written, BT.709 limited-range YUV, but at 16 bits
 * (`pixFmt`), so it loses no levels; the scale after it reads it back as such, and `out` adds what that scale makes.
 * (Full range would keep black exactly still as it scales, but here black moves less than a level, and on x86
 * swscale's full-to-limited step lands about a third of a level high in every plane, where cutting limited range from
 * 16 to 8 bits doesn't.)
 */
const deflickerFilter = (frames, pixFmt, out = "") =>
  `scale=out_color_matrix=bt709:out_range=tv,format=${pixFmt},deflicker=size=${frames}:mode=am,` +
  `scale=in_color_matrix=bt709:in_range=tv${out}`;

const exportTail = "format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";

/**
 * The export's whole filter graph. With `deflicker` off it is the grade alone, as it always was. `size` (scale's
 * arguments) makes the picture smaller before it's graded, as preview copies are.
 */
export function exportFilter({ matrix = "bt709", cube, deflicker = null, size = "" }) {
  const frames = deflickerFrames(deflicker);
  const grade = gradeFilter(matrix, cube, size);
  if (!frames) return `${grade},scale=out_color_matrix=bt709:out_range=tv,${exportTail}`;
  // 4:2:0, as the export ends up: deflicker only touches luma, it holds that many frames at a time, and what's left
  // is to cut it to 8 bits.
  return `${grade},${deflickerFilter(frames, "yuv420p16le", ":out_range=tv")},${exportTail}`;
}

/**
 * A frame export's filter graph. With `deflicker` it reads that frame and the ones after it the export averages it
 * with, so the still is the export's frame, not the flickering original's.
 */
export function frameFilter({ matrix = "bt709", cube, deflicker = null }) {
  const frames = deflickerFrames(deflicker);
  const grade = gradeFilter(matrix, cube);
  if (!frames) return `${grade},format=rgb24`;
  // 4:4:4 here: a still keeps its full colour resolution.
  return `${grade},${deflickerFilter(frames, "yuv444p16le")},format=rgb24`;
}

/** What an export can be encoded on: the Mac's GPU (its media engine, through VideoToolbox), or the CPU (x264). */
export const ENCODERS = ["gpu", "cpu"];
/** The quality the GPU encodes from: at a set size below it x264 keeps visibly more of a grainy picture (README). */
export const GPU_FROM = 50;

/**
 * An export's bitrate below full quality: that share of the original's, so the file's size is known before it's made
 * (50 ≈ half the original). Null at full quality (100), near lossless whatever size that takes.
 */
export const exportRate = (quality, videoBitrate) =>
  quality >= 100 || !videoBitrate ? null : Math.round((videoBitrate * quality) / 100);

/**
 * The encoder and its rate, as ffmpeg's arguments. `-g 250` leaves the GPU's key frames to -force_key_frames, as x264's
 * are: by default it adds one every 12 frames. It's given no ceiling over its bitrate: it keeps to that as closely
 * without, and with one a clip's first frames come out worse.
 */
export function exportVideo(encoder, { quality = 100, videoBitrate = 0, width = 0, height = 0, fps = 0 } = {}) {
  const rate = exportRate(quality, videoBitrate);
  if (encoder === "gpu") {
    const how = rate ? ["-b:v", String(rate)] : ["-q:v", String(gpuQuality({ width, height, fps }))];
    // It names the level by the frame's size alone: above 4K30's pixels a second that's one too low.
    const level = width * height * fps > 3840 * 2176 * 30 ? ["-level", "5.2"] : [];
    return ["-c:v", "h264_videotoolbox", "-profile:v", "high", ...level, "-g", "250", ...how];
  }
  const how = rate ? ["-b:v", String(rate), "-maxrate", String(Math.round(rate * 1.5)), "-bufsize", String(rate * 2)] : ["-crf", "12"];
  return ["-c:v", "libx264", "-preset", "medium", ...how];
}

/**
 * The GPU's constant quality (0-100) for a full quality export: the least that came out at least as close to the graded
 * frames as x264's CRF 12 on every clip measured (README, How exports are encoded). A clip above 1080p has more grain in
 * each pixel, which CRF spends less on. And x264's QP rises by 2.4 for each doubling of the frame rate, each frame being
 * on screen for less; that's about 4 of these.
 */
export function gpuQuality({ width = 0, height = 0, fps = 0 } = {}) {
  const full = width * height > 1920 * 1088 ? 88 : 90;
  return Math.max(78, Math.round(full - 4 * Math.log2(Math.max(25, fps || 0) / 25)));
}

/**
 * One frame of a clip, graded, as a full-size 8-bit PNG: `time` in seconds lands on the frame it's in. With
 * `deflicker` it's deflickered as that frame of the export is (frameFilter).
 */
export async function exportFrame({ src, dst, cube, matrix = "bt709", deflicker = null, time }) {
  await writeAtomically(dst, (tmp) =>
    run(["-ss", time.toFixed(6), "-i", src, "-map", "0:v:0", "-frames:v", "1", "-vf", frameFilter({ matrix, cube, deflicker }), tmp]),
  );
}

// ---- a film's assets: preview copies while it's made, trims when it's rendered ----------------------------------------

/**
 * A preview copy's long side, video bitrate, and how often it has a key frame (seconds). 12 Mbit/s: on 4K60 D-Log2
 * (carved stone under string lights) it came to VMAF 95 against the graded frames at that size, 8 Mbit/s to 92.5; on 4K24
 * foliage walked through, 81 and 70, with 8 visibly smearing the leaves. The grade reads true either way; it's not for
 * keeping.
 */
export const PREVIEW_SIDE = 1920;
export const PREVIEW_RATE = 12e6;
export const PREVIEW_KEYS = 0.5;

/**
 * scale's arguments for a preview copy: PREVIEW_SIDE on the long side, never larger than the original, sides even. It
 * scales the original's code values before the grade, where the export grades first: four times fewer pixels through the
 * LUT, twice as fast on 4K60, and the frames come out within 56.8 dB (PSNR) of grading first.
 */
const previewScale = `w='if(gte(iw,ih),min(${PREVIEW_SIDE},iw),-2)':h='if(gte(iw,ih),-2,min(${PREVIEW_SIDE},ih))':flags=lanczos`;

/** A preview copy's filter graph: the export's, grade and deflicker, on the picture made smaller first. */
export const previewFilter = ({ matrix = "bt709", cube, deflicker = null }) =>
  exportFilter({ matrix, cube, deflicker, size: previewScale });

/** The size a preview copy of a `width` × `height` clip comes out at, as previewScale makes it. */
export function previewDims(width, height) {
  const long = Math.max(width, height);
  if (long <= PREVIEW_SIDE) return { width, height };
  const short = 2 * Math.round((Math.min(width, height) * PREVIEW_SIDE) / long / 2);
  return width >= height ? { width: PREVIEW_SIDE, height: short } : { width: short, height: PREVIEW_SIDE };
}

/**
 * The H.264 level a picture's size and frame rate take, when it's more than 4.0's: VideoToolbox names it by the frame's
 * size alone, 4.0 for 1080p at any rate.
 */
function h264Level(width, height, fps) {
  const blocks = Math.ceil(width / 16) * Math.ceil(height / 16) * fps;
  const level = [[245_760, null], [522_240, "4.2"], [983_040, "5.1"]].find(([most]) => blocks <= most)?.[1] ?? "5.2";
  return level ? ["-level", level] : [];
}

/** A preview copy's encoder and rate, as ffmpeg's arguments. */
export function previewVideo(encoder, { width = 0, height = 0, fps = 0 } = {}) {
  const rate = String(PREVIEW_RATE);
  if (encoder === "gpu")
    return ["-c:v", "h264_videotoolbox", "-profile:v", "high", ...h264Level(width, height, fps), "-g", "250", "-b:v", rate];
  const most = ["-maxrate", String(PREVIEW_RATE * 1.5), "-bufsize", String(PREVIEW_RATE * 2)];
  return ["-c:v", "libx264", "-preset", "veryfast", "-b:v", rate, ...most];
}

/**
 * A preview copy: the clip through its grade, deflicker and all, PREVIEW_SIDE on its long side, 8-bit H.264 BT.709 at
 * PREVIEW_RATE with a key frame every PREVIEW_KEYS seconds, the sound copied. On the GPU, or the CPU when it's asked
 * for or the GPU can't (exportClip). Says what encoded it, and its size.
 */
export async function makePreview({
  src, dst, cube, matrix = "bt709", deflicker = null, duration, width, height, fps, encoder = "gpu", onProgress,
  onFallback, signal,
}) {
  const size = previewDims(width, height);
  const encode = (on) =>
    writeAtomically(dst, (tmp) =>
      run(
        [
          "-i", src,
          "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "0",
          "-vf", previewFilter({ matrix, cube, deflicker }),
          ...previewVideo(on, { ...size, fps }), "-force_key_frames", `expr:gte(t,n_forced*${PREVIEW_KEYS})`,
          "-c:a", "copy", "-movflags", "+faststart", tmp,
        ],
        { onProgress, duration, signal },
      ),
    );
  return { ...(await onGpuOrCpu(encoder, encode, { signal, onFallback })), ...size };
}

/** A trim's sound: encoded again, so it starts and ends where its picture does. AAC, so a film's <audio> plays it. */
export const TRIM_AUDIO = ["-c:a", "aac", "-b:a", "320k"];

/**
 * The frames a trim of [start, end) seconds holds: from the one on screen at `start` to the last that starts before
 * `end`. Times come rounded to the millisecond, so a frame starting within half of one after `start` counts as at it,
 * and one starting within half of one before `end` as at it too. Says the first frame's time and the last's, when the
 * last leaves the screen (`until`), half the shortest time a frame is on screen (`slack`), and the stream's time base.
 * Read off the file's own packets around both ends, so a clip is cut on its own frames, at whatever rate, steady or not.
 */
export async function trimFrames(src, start, end) {
  const around = (t) => `${Math.max(0, t - 2).toFixed(6)}%${(t + 1).toFixed(6)}`;
  const ask = ["-v", "error", "-select_streams", "v:0", "-read_intervals", `${around(start)},${around(end)}`];
  const entries = ["-show_entries", "packet=pts,duration:stream=time_base", "-of", "json"];
  const { stdout } = await exec(FFPROBE, [...ask, ...entries, src], { maxBuffer: 64 * 1024 * 1024 });
  const { packets = [], streams = [] } = JSON.parse(stdout);
  // In the stream's own time base, so a time is the very number ffmpeg has for it.
  const [num, den] = String(streams[0]?.time_base ?? "1/1").split("/").map(Number);
  const time = (pts) => (pts * num) / den;
  const lengths = new Map(packets.filter((p) => Number.isInteger(p.pts)).map((p) => [p.pts, p.duration]));
  const all = [...lengths.keys()].sort((a, b) => a - b);
  const gaps = all.slice(1).map((pts, i) => pts - all[i]);
  const shortest = gaps.length ? Math.min(...gaps) : lengths.get(all[0]) || den / num / 24;
  const us = (t) => Math.round(t * 1e6);
  const first = all.findLast((pts) => us(time(pts)) <= us(start) + 500) ?? all[0];
  const last = all.findLast((pts) => us(time(pts)) < us(end) - 500);
  if (first === undefined || last === undefined || last < first) throw new Error(`no frames from ${start} s to ${end} s`);
  const until = all.find((pts) => pts > last) ?? last + (lengths.get(last) || shortest);
  const timeBase = `${num}/${den}`;
  return { first: time(first), last: time(last), until: time(until), slack: time(shortest) / 2, timeBase };
}

/** When a clip's sound starts, and its sample rate; null when it has none. */
async function soundOf(src) {
  const ask = ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=start_time,sample_rate", "-of", "json", src];
  const [sound] = JSON.parse((await exec(FFPROBE, ask)).stdout).streams ?? [];
  return sound ? { start: Number(sound.start_time) || 0, rate: Number(sound.sample_rate) || 48_000 } : null;
}

/**
 * A full-quality graded export of part of a clip, [start, end) seconds of it (trimFrames), encoded as exports are
 * (exportVideo, at `quality`, on `encoder`). The first frame is the one on screen at `start`, at time 0; the sound
 * (TRIM_AUDIO) starts on the same sample and lasts as long as the picture. It's graded from a little before and, for
 * deflicker, which evens each frame out with the ones after it, a little past the end, then cut, so each frame comes
 * out as it does in the clip's whole export. Says the first and last frame's times in the original (`actualStart`,
 * `actualEnd`), and what encoded it.
 */
export async function exportTrim({
  src, dst, cube, matrix = "bt709", deflicker = null, start, end, duration, width, height, fps, quality = 100,
  videoBitrate = 0, encoder = "gpu", onProgress, onFallback, signal,
}) {
  const stop = Math.min(end, duration || end);
  if (start >= stop) throw new Error(`no frames from ${start} s to ${end} s: the clip ends at ${duration} s`);
  const { first, last, until, slack, timeBase } = await trimFrames(src, start, stop);
  const sound = await soundOf(src);
  // Only the frames from `from` on are graded: those before it are decoded and dropped.
  const from = Math.max(0, first - 0.1);
  const ahead = (deflickerFrames(deflicker) + 2) / (fps || 24) + 0.1;
  const s = (t) => Math.max(0, t).toFixed(6);
  // The frames keep their times in the original through the graph (-copyts), and the file's times start at the first
  // frame's (-output_ts_offset). Not setpts: after it ffmpeg 7 knows no frame rate, and makes the picture 25 fps,
  // dropping frames, or leaves the last frame no time on screen.
  const picture = `[0:v:0]${exportFilter({ matrix, cube, deflicker })},trim=start=${s(first - slack)}:end=${s(last + slack)}[v]`;
  // A clip whose sound starts after its first frame has it start that much later in the file.
  const heard = sound && Math.max(first, sound.start);
  const audio = sound && `;[0:a:0]atrim=start=${s(first)}:end=${s(until)},apad=whole_dur=${s(until - heard)}[a]`;
  const encode = (on) =>
    writeAtomically(dst, (tmp) =>
      run(
        [
          "-ss", s(from), "-t", s(until + ahead - from), "-copyts", "-i", src,
          "-filter_complex", picture + (audio || ""),
          "-map", "[v]", ...(audio ? ["-map", "[a]"] : []), "-map_metadata", "0",
          // Every frame as it comes, at its own time: no frames made or dropped to a rate, none rounded to another.
          "-fps_mode:v", "passthrough", "-enc_time_base:v", timeBase,
          ...exportVideo(on, { quality, videoBitrate, width, height, fps }),
          // A key frame every quarter second from the first, which is at its time in the original here.
          "-force_key_frames", "expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+0.25))",
          // Its length counted in samples, where by default it's in milliseconds.
          ...(audio ? [...TRIM_AUDIO, "-movie_timescale", String(sound.rate)] : []),
          "-output_ts_offset", `-${s(first)}`, "-movflags", "+faststart", tmp,
        ],
        { onProgress, duration: until - first, signal },
      ),
    );
  const made = await onGpuOrCpu(quality < GPU_FROM ? "cpu" : encoder, encode, { signal, onFallback });
  return { ...made, actualStart: first, actualEnd: last };
}

/**
 * Every clip on the camera's card, by shoot day: DJI names start with the recording time (DJI_YYYYMMDDhhmmss_…),
 * so a day is the clips recorded on it. Null when the camera isn't mounted. Read only: nothing is written to the card.
 */
export async function cameraDays(cameraDir) {
  let folders;
  try {
    folders = (await readdir(cameraDir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith("."));
  } catch {
    return null;
  }
  const days = new Map();
  for (const f of folders) {
    const names = await readdir(join(cameraDir, f.name)).catch(() => []);
    for (const name of names) {
      const m = /^DJI_(\d{4})(\d{2})(\d{2})\d{6}_.+\.(mp4|mov)$/i.exec(name);
      if (!m) continue;
      const day = `${m[1]}-${m[2]}-${m[3]}`;
      if (!days.has(day)) days.set(day, []);
      days.get(day).push({ name, path: join(cameraDir, f.name, name), folder: f.name });
    }
  }
  for (const list of days.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return days;
}
