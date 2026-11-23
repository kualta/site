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
  if (encoder === "cpu" || quality < GPU_FROM) {
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

/** The original's code values, read as limited range at 16 bits, through a clip's grade LUT. */
const gradeFilter = (matrix, cube) => `scale=in_color_matrix=${matrix}:in_range=tv,format=gbrp16le,lut3d=file='${filterPath(cube)}':interp=tetrahedral`;

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

/** The export's whole filter graph. With `deflicker` off it is the grade alone, as it always was. */
export function exportFilter({ matrix = "bt709", cube, deflicker = null }) {
  const frames = deflickerFrames(deflicker);
  const grade = gradeFilter(matrix, cube);
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
