import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { writeCube } from "./color.mjs";
import { exportClip, exportFilter, exportRate, exportVideo, FFPROBE, GPU_FROM, gpuQuality } from "./media.mjs";

// What encodes an export: the Mac's GPU, or the CPU when it's chosen or the GPU can't. With ffmpegs of the tests' own,
// which of them runs and what's left behind; with the GPU itself, where there is one, that its exports are tagged, timed
// and as close to the graded frames as the CPU's.
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const usable = spawnSync(ffmpeg, ["-version"]).status === 0;
const GPU_TRY = ["-f", "lavfi", "-i", "color=s=320x180:d=0.2", "-c:v", "h264_videotoolbox", "-f", "null", "-"];
const gpu = usable && spawnSync(ffmpeg, ["-loglevel", "quiet", ...GPU_TRY]).status === 0;
const root = mkdtempSync(join(tmpdir(), "grade-export-test-"));
const cube = join(root, "curve.cube");
const source = join(root, "source.mp4");
const seconds = 3;
const fps = 24;
const FRAMES = seconds * fps;

const run = (args) => execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", ...args], { maxBuffer: 1 << 28 });

beforeAll(() => {
  if (!usable) return;
  // A curve per channel, so the LUT does something.
  const size = 17;
  const lut = new Float32Array(size ** 3 * 3);
  const at = (v, power) => (v / (size - 1)) ** power;
  for (let b = 0, i = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) lut.set([at(r, 0.8), at(g, 1.1), at(b, 0.9)], i++ * 3);
  writeFileSync(cube, writeCube(size, lut, "curve"));
  // Moving, with grain, as 10-bit HEVC with sound: what a camera makes.
  run([
    "-y",
    "-f", "lavfi", "-i", `testsrc2=s=640x360:r=${fps}:d=${seconds},noise=alls=6:allf=t,format=yuv420p10le`,
    "-f", "lavfi", "-i", `sine=d=${seconds}:r=48000`,
    "-c:v", "libx265", "-preset", "ultrafast", "-crf", "8", "-x265-params", "log-level=error", "-tag:v", "hvc1",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-c:a", "aac", source,
  ]);
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the CPU's arguments are what exports were always made with, and the GPU's differ only in encoder and full quality", () => {
  const clip = { videoBitrate: 90e6, width: 3840, height: 2160, fps: 60 };
  expect(exportVideo("cpu", { quality: 100, ...clip })).toEqual([
    "-c:v", "libx264", "-preset", "medium", "-crf", "12",
  ]);
  const half = ["-b:v", "45000000"];
  expect(exportVideo("cpu", { quality: 50, ...clip })).toEqual([
    "-c:v", "libx264", "-preset", "medium", ...half, "-maxrate", "67500000", "-bufsize", "90000000",
  ]);
  const onGpu = ["-c:v", "h264_videotoolbox", "-profile:v", "high", "-g", "250"];
  const on4k60 = [...onGpu.slice(0, 4), "-level", "5.2", ...onGpu.slice(4)];
  expect(exportVideo("gpu", { quality: 100, ...clip })).toEqual([...on4k60, "-q:v", "83"]);
  expect(exportVideo("gpu", { quality: 50, ...clip })).toEqual([...on4k60, ...half]);
  expect(exportVideo("gpu", { quality: 50, ...clip, fps: 30 })).toEqual([...onGpu, ...half]);
  // Without the original's bitrate there's no share of it to take.
  expect(exportVideo("gpu", { quality: 50 })).toEqual([...onGpu, "-q:v", "90"]);
  expect(exportVideo("cpu", { quality: 50 })).toEqual(["-c:v", "libx264", "-preset", "medium", "-crf", "12"]);
});

test("below full quality the bitrate is that share of the original's, whatever encodes it", () => {
  for (const quality of [10, 30, 60, 95]) {
    expect(exportRate(quality, 25e6)).toBe(25e4 * quality);
    for (const encoder of ["gpu", "cpu"])
      expect(exportVideo(encoder, { quality, videoBitrate: 25e6 }).join(" ")).toContain(` -b:v ${25e4 * quality}`);
  }
  expect(exportRate(100, 25e6)).toBeNull();
  expect(exportRate(60, 0)).toBeNull();
});

test("the GPU's full quality follows the size and the frame rate, as x264's does, down to a floor", () => {
  const at = (width, height) => [24000 / 1001, 25, 30, 50, 60000 / 1001, 120, 240].map((fps) => gpuQuality({ width, height, fps }));
  expect(at(1080, 1920)).toEqual([90, 90, 89, 86, 85, 81, 78]);
  expect(at(1728, 3072)).toEqual([88, 88, 87, 84, 83, 79, 78]);
  expect(at(3840, 2160)).toEqual(at(1728, 3072));
  // Not knowing is no reason to spend less.
  for (const fps of [0, undefined, Number.NaN]) expect(gpuQuality({ fps })).toBe(90);
  expect(gpuQuality()).toBe(90);
});

// ---- which encoder runs: ffmpegs of the tests' own ------------------------------------------------------------------

/**
 * A stand-in for ffmpeg: it notes the arguments of each run, does `gpuRun` (shell) when asked for the GPU's encoder, with
 * the file it's to write in $out, and is the real one otherwise.
 */
function standIn(name, gpuRun) {
  const dir = join(root, name);
  mkdirSync(dir);
  const bin = join(dir, "ffmpeg");
  const log = join(dir, "runs");
  writeFileSync(log, "");
  const script = `#!/bin/sh
for a in "$@"; do case "$a" in h264_videotoolbox|libx264) on=$a ;; *.part.mp4) out=$a ;; esac; done
echo "$on $$" >> "${log}"
printf '%s\\n' "$@" > "${dir}/$on"
if [ "$on" = h264_videotoolbox ]; then
${gpuRun}
fi
exec "${ffmpeg}" "$@"
`;
  writeFileSync(bin, script, { mode: 0o755 });
  const lines = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return {
    bin,
    /** The encoder of each run, in turn. */
    encoders: () => lines().map((line) => line.split(" ")[0]),
    pids: () => lines().map((line) => Number(line.split(" ")[1])),
    /** The arguments of the last run with an encoder. */
    args: (encoder) => readFileSync(join(dir, encoder), "utf8").split("\n").slice(0, -1),
  };
}

/** exportClip with that ffmpeg, in a process of its own (the ffmpeg is picked as media.mjs loads). */
function exportWith(bin, asked, { stopAfter } = {}) {
  const script = `
    import { exportClip } from ${JSON.stringify(join(import.meta.dir, "media.mjs"))};
    const stop = new AbortController();
    const heard = [];
    process.on("SIGUSR2", () => stop.abort());
    const asked = ${JSON.stringify(asked)};
    const made = await exportClip({ ...asked, signal: stop.signal, onFallback: (why) => heard.push(why) })
      .then((made) => ({ made }), (e) => ({ error: e.message, name: e.name }));
    console.log(JSON.stringify({ ...made, heard }));
  `;
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, FFMPEG_PATH: bin },
    stdio: ["ignore", "pipe", "inherit"],
  });
  stopAfter?.().then(() => child.kill("SIGUSR2"));
  let out = "";
  child.stdout.on("data", (c) => {
    out += c;
  });
  return new Promise((resolve) => child.on("close", () => resolve(JSON.parse(out.trim().split("\n").at(-1)))));
}
async function until(check, ms = 20_000) {
  for (const end = Date.now() + ms; !check(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const job = (dst, extra) => ({ src: source, dst, cube, duration: seconds, fps, encoder: "gpu", ...extra });
/** A folder of its own for an export, and what's in it, hidden files too. */
function folder(name) {
  const dir = join(root, `out-${name}`);
  mkdirSync(dir);
  return { dst: join(dir, "clip.mp4"), left: () => readdirSync(dir) };
}
const codecsOf = (file) => execFileSync(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file]).toString().trim().split(/[\s,]+/);

test.if(usable)("without VideoToolbox the clip is encoded on the CPU, saying why, with the same graph and everything else", async () => {
  const fake = standIn("none", `echo "Unknown encoder 'h264_videotoolbox'" >&2; exit 1`);
  const { dst, left } = folder("none");
  const said = await exportWith(fake.bin, job(dst));
  expect(said).toEqual({
    made: { encoder: "cpu", fallback: "Unknown encoder 'h264_videotoolbox'" },
    heard: ["Unknown encoder 'h264_videotoolbox'"],
  });
  expect(fake.encoders()).toEqual(["h264_videotoolbox", "libx264"]);
  expect(left()).toEqual(["clip.mp4"]);
  expect(codecsOf(dst)).toEqual(["h264", "aac"]);

  // The two runs differ in their encoder's arguments alone: in, graph, key frames, sound and container are the same.
  const [onGpu, onCpu] = [fake.args("h264_videotoolbox"), fake.args("libx264")];
  const rest = (args, encoder) => args.join("\n").replace(exportVideo(encoder, { fps }).join("\n"), "…");
  expect(rest(onGpu, "gpu")).toBe(rest(onCpu, "cpu"));
  expect(onGpu[onGpu.indexOf("-vf") + 1]).toBe(exportFilter({ cube }));
  expect(onGpu.join(" ")).toContain("-force_key_frames expr:gte(t,n_forced*0.25) -c:a copy -movflags +faststart");
}, 60_000);

test.if(usable)("a GPU that fails midway gives way to the CPU from the start, and nothing of its file is left", async () => {
  const fake = standIn(
    "midway",
    `head -c 5000 /dev/zero > "$out"; echo "[h264_videotoolbox @ 0x14f80] Error encoding frame: -12912" >&2; echo "Conversion failed!" >&2; exit 69`,
  );
  const { dst, left } = folder("midway");
  const { made } = await exportWith(fake.bin, job(dst, { quality: 60, videoBitrate: 4e6 }));
  expect(made).toEqual({ encoder: "cpu", fallback: "[h264_videotoolbox] Error encoding frame: -12912" });
  expect(left()).toEqual(["clip.mp4"]);
  expect(framesOf(dst)).toHaveLength(FRAMES);
  // The same share of the original's bitrate.
  expect(fake.args("libx264").join(" ")).toContain("-b:v 2400000 ");
}, 60_000);

test.if(usable)("chosen, or below the quality the GPU encodes from, the CPU encodes it and the GPU isn't asked", async () => {
  const fake = standIn("chosen", "exit 1");
  const { dst } = folder("chosen");
  const byCpu = { made: { encoder: "cpu" }, heard: [] };
  expect(await exportWith(fake.bin, job(dst, { encoder: "cpu" }))).toEqual(byCpu);
  const low = { quality: GPU_FROM - 5, videoBitrate: 4e6 };
  expect(await exportWith(fake.bin, job(dst, low))).toEqual(byCpu);
  expect(fake.encoders()).toEqual(["libx264", "libx264"]);
  expect(await exportWith(fake.bin, job(dst, { ...low, quality: GPU_FROM }))).toMatchObject({ made: { fallback: "ffmpeg exited 1" } });
  expect(fake.encoders()).toEqual(["libx264", "libx264", "h264_videotoolbox", "libx264"]);
}, 60_000);

test.if(usable)("with no room left, or on both failing, the export fails and the one before stays", async () => {
  const full = standIn("full", `echo x > "$out"; echo "av_interleaved_write_frame(): No space left on device" >&2; exit 1`);
  const { dst, left } = folder("full");
  writeFileSync(dst, "the export before");
  const said = await exportWith(full.bin, job(dst));
  expect(said).toMatchObject({ error: "av_interleaved_write_frame(): No space left on device", heard: [] });
  expect(full.encoders()).toEqual(["h264_videotoolbox"]);

  const broken = standIn("broken", "exit 1");
  const missing = await exportWith(broken.bin, job(dst, { src: join(root, "missing.mp4") }));
  expect(missing.error).toContain("No such file");
  expect(broken.encoders()).toEqual(["h264_videotoolbox", "libx264"]);
  expect(left()).toEqual(["clip.mp4"]);
  expect(readFileSync(dst, "utf8")).toBe("the export before");
}, 60_000);

test.if(usable)("stopped, the GPU's encoder is killed, the CPU doesn't take over and nothing is left", async () => {
  const fake = standIn("hang", `echo x > "$out"; exec sleep 60`);
  const { dst, left } = folder("hang");
  const partial = () => left().includes(".clip.mp4.part.mp4");
  const said = await exportWith(fake.bin, job(dst), { stopAfter: () => until(partial) });
  expect(said).toMatchObject({ name: "AbortError", heard: [] });
  expect(fake.encoders()).toEqual(["h264_videotoolbox"]);
  await until(() => !alive(fake.pids()[0]));
  expect(left()).toEqual([]);
}, 60_000);

// ---- the GPU itself, where there is one -----------------------------------------------------------------------------

const probed = (file, entries, select) =>
  JSON.parse(
    execFileSync(FFPROBE, ["-v", "error", "-select_streams", select, "-show_entries", entries, "-of", "json", file], { maxBuffer: 1 << 26 }),
  );
/** Every frame's time, and whether it's a key frame. */
const framesOf = (file) =>
  probed(file, "packet=pts_time,flags", "v:0").packets
    .map((p) => ({ at: Number(p.pts_time), key: p.flags.startsWith("K") }))
    .sort((a, b) => a.at - b.at);
const soundOf = (file) => run(["-i", file, "-map", "0:a:0", "-c", "copy", "-f", "md5", "-"]).toString();
/** How close a video is to the graded frames: mean SSIM and luma PSNR over them all. */
function closeness(file, graded) {
  const byFrame = `settb=1/${fps},setpts=N,split`;
  const graph = `[0:v]${byFrame}[a][b];[1:v]${byFrame}[c][d];[a][c]ssim=f=-[s];[b][d]psnr=f=-[p]`;
  const out = run(["-i", file, "-i", graded, "-filter_complex", graph, "-map", "[s]", "-f", "null", "-", "-map", "[p]", "-f", "null", "-"]).toString();
  const mean = (pattern) => {
    const all = [...out.matchAll(pattern)].map((m) => Number(m[1]));
    expect(all).toHaveLength(FRAMES);
    return all.reduce((sum, v) => sum + v, 0) / all.length;
  };
  return { ssim: mean(/All:([\d.]+)/g), psnr: mean(/psnr_y:([\d.]+)/g) };
}
const exported = {};
async function both(name, extra) {
  for (const encoder of ["gpu", "cpu"]) {
    const dst = join(root, `${name}-${encoder}.mp4`);
    if (!existsSync(dst)) await exportClip(job(dst, { encoder, onFallback: (why) => expect(why).toBeUndefined(), ...extra }));
    exported[`${name}-${encoder}`] = dst;
  }
  return [exported[`${name}-gpu`], exported[`${name}-cpu`]];
}

test.if(gpu)("the GPU's export has the CPU's tags, size, frames, times, quarter-second key frames and sound", async () => {
  const [onGpu, onCpu] = await both("full");
  const entries =
    "stream=codec_name,codec_tag_string,profile,width,height,coded_width,pix_fmt,sample_aspect_ratio,field_order," +
    "color_range,color_space,color_transfer,color_primaries,chroma_location,r_frame_rate,avg_frame_rate,nb_frames,start_time,duration";
  expect(probed(onGpu, entries, "v:0")).toEqual(probed(onCpu, entries, "v:0"));
  expect(probed(onGpu, entries, "v:0").streams[0]).toMatchObject({
    color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", pix_fmt: "yuv420p", profile: "High",
  });
  // Every frame, at the original's own time, and the sound starting with it.
  const [frames, original] = [framesOf(onGpu), framesOf(source)];
  expect(frames).toHaveLength(FRAMES);
  expect(frames.map((f) => f.at)).toEqual(original.map((f) => f.at));
  expect(framesOf(onCpu).map((f) => f.at)).toEqual(original.map((f) => f.at));
  expect(frames.filter((f) => f.key).map((f) => f.at)).toEqual(original.map((f) => f.at).filter((_, i) => i % (fps / 4) === 0));
  expect(soundOf(onGpu)).toBe(soundOf(source));
  const times = (file) => probed(file, "stream=start_time,duration", "a:0");
  expect(times(onGpu)).toEqual(times(onCpu));
}, 60_000);

test.if(gpu)("a 4K60 export says the level it takes, as the CPU's does", async () => {
  const src = join(root, "4k60.mp4");
  const ultra = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src];
  run(["-y", "-f", "lavfi", "-i", "testsrc2=s=3840x2160:r=60:d=0.2", ...ultra]);
  const size = { width: 3840, height: 2160, fps: 60, duration: 0.2 };
  for (const file of await both("4k60", { src, ...size }))
    expect(probed(file, "stream=profile,level", "v:0").streams).toEqual([{ profile: "High", level: 52 }]);
}, 60_000);

test.if(gpu)("at full quality the GPU's export is at least as close to the graded frames as the CPU's, for no more than twice its size", async () => {
  const [onGpu, onCpu] = await both("full");
  const graded = join(root, "graded.mkv");
  run(["-y", "-i", source, "-map", "0:v:0", "-vf", exportFilter({ cube }), "-c:v", "ffv1", graded]);
  const [a, b] = [closeness(onGpu, graded), closeness(onCpu, graded)];
  expect(a.ssim).toBeGreaterThan(0.985);
  expect(a.psnr).toBeGreaterThan(44);
  expect(a.ssim).toBeGreaterThanOrEqual(b.ssim);
  expect(a.psnr).toBeGreaterThanOrEqual(b.psnr);
  expect(statSync(onGpu).size).toBeLessThan(2 * statSync(onCpu).size);
}, 60_000);

test.if(gpu)("below it the GPU's export comes to the size the menu says, as the CPU's does", async () => {
  const videoBitrate = 4e6;
  for (const quality of [90, GPU_FROM]) {
    const files = await both(`q${quality}`, { quality, videoBitrate });
    for (const file of files) {
      const { bit_rate: rate } = probed(file, "stream=bit_rate", "v:0").streams[0];
      expect(Math.abs(Number(rate) / ((videoBitrate * quality) / 100) - 1)).toBeLessThan(0.15);
      expect(framesOf(file)).toHaveLength(FRAMES);
    }
  }
}, 60_000);

test.if(gpu)("stopped midway, the GPU's export leaves nothing", async () => {
  const { dst, left } = folder("stopped");
  const long = join(root, "long.mp4");
  run(["-y", "-stream_loop", "40", "-i", source, "-c", "copy", long]);
  const stop = new AbortController();
  const heard = [];
  const making = exportClip(job(dst, {
    src: long, duration: 41 * seconds, signal: stop.signal, onFallback: (why) => heard.push(why),
    onProgress: (p) => p > 0 && stop.abort(),
  }));
  await expect(making).rejects.toThrow("abort");
  expect(heard).toEqual([]);
  expect(left()).toEqual([]);
}, 60_000);
