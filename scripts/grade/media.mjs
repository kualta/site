// ffmpeg and file work for the grade app: reading a clip's camera metadata, its thumbnail and the small proxy the
// browser previews, baking a grade into a graded copy, and finding clips on the camera's card.
import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { CALIBRATION, blockMeans, profileOf } from "./color.mjs";

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
    audio: info.streams.some((s) => s.codec_type === "audio"),
    still: still ? still.index : null,
  };
}

/** Run ffmpeg; `signal` stops it (the promise then rejects, and writeAtomically removes the half-written file). */
function run(args, { onProgress, duration, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args, ...(onProgress ? ["-progress", "pipe:1", "-nostats"] : [])], { signal });
    let err = "";
    let buf = "";
    child.stderr.on("data", (c) => {
      err = (err + c).slice(-4000);
    });
    child.stdout.on("data", (c) => {
      buf += c;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && duration && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
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
 * Bake a grade into a graded copy, from the 10-bit original at 16-bit precision: the clip's LUT through ffmpeg's
 * tetrahedral lut3d, out as 8-bit H.264 BT.709 near-lossless with a key frame every quarter second, sound copied.
 */
export async function exportClip({ src, dst, cube, matrix = "bt709", duration, onProgress, signal }) {
  await writeAtomically(dst, (tmp) =>
    run(
      [
        "-i", src,
        "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "0",
        "-vf", `scale=in_color_matrix=${matrix}:in_range=tv,format=gbrp16le,lut3d=file='${filterPath(cube)}':interp=tetrahedral,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`,
        "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-force_key_frames", "expr:gte(t,n_forced*0.25)",
        "-c:a", "copy", "-movflags", "+faststart", tmp,
      ],
      { onProgress, duration, signal },
    ),
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
