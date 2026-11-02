import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
// The Worker's limit for a video upload.
const MAX_VIDEO_BYTES = 90_000_000;
// Aim under the limit, and refuse below the bitrate where a 1080p film falls apart.
const SIZE_MARGIN = 0.9;
const MIN_VIDEO_KBPS = 800;
const AUDIO_KBPS = 192;
const contentTypes = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

async function seconds(file) {
  const { stdout } = await exec(process.env.FFPROBE_PATH || "ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not read the video's length: ${file}`);
  return duration;
}

const imageTypes = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
async function locateImage(specFile, image) {
  if (typeof image !== "string") throw new Error(`${specFile}'s "cover" is a path to an image`);
  const input = resolve(dirname(specFile), image);
  const contentType = imageTypes[extname(input).toLowerCase()];
  if (!contentType) throw new Error(`Use a JPEG or PNG cover: ${input}`);
  if ((await stat(input)).size > 30e6) throw new Error(`The cover is over 30 MB: ${input}`);
  return { input, contentType };
}

/** The frame at `at` seconds, as a JPEG at `output`. */
async function frameAt(input, at, output) {
  await exec(process.env.FFMPEG_PATH || "ffmpeg", [
    "-nostdin",
    "-y",
    "-ss",
    String(at),
    "-i",
    input,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    output,
  ]);
  return { input: output, contentType: "image/jpeg" };
}

async function locate(specFile, video) {
  if (typeof video !== "string") throw new Error(`${specFile} needs a "video" path`);
  const input = resolve(dirname(specFile), video);
  const contentType = contentTypes[extname(input).toLowerCase()];
  if (!contentType) throw new Error(`Use an MP4, MOV or WebM video: ${input}`);
  return { input, contentType, duration: await seconds(input) };
}

/** Re-encodes a video to fit the upload limit. The destinations each get their own encode of this copy later. */
async function fit(input, output, duration, maxBytes) {
  let kbps = Math.floor((maxBytes * SIZE_MARGIN * 8) / duration / 1000) - AUDIO_KBPS;
  // x264 lands within a few percent of the bitrate on a film, but it's only a target: measure, and scale by any miss.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (kbps < MIN_VIDEO_KBPS)
      throw new Error(
        `A ${Math.round(duration / 60)} minute video can't fit the ${maxBytes / 1e6} MB upload limit at a watchable quality`,
      );
    await exec(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-nostdin",
        "-y",
        "-i",
        input,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-b:v",
        `${kbps}k`,
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        `${AUDIO_KBPS}k`,
        "-movflags",
        "+faststart",
        output,
      ],
      { timeout: 30 * 60_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const { size } = await stat(output);
    if (size <= maxBytes) return;
    kbps = Math.floor((kbps * maxBytes * SIZE_MARGIN) / size);
  }
  throw new Error(`Could not re-encode the video to fit the ${maxBytes / 1e6} MB upload limit`);
}

/**
 * Sends a video and its text to the composer as a draft, and returns the page to publish it from.
 * `specFile` is JSON: { video, title, caption, alt, tags, short, zh, preset, cover, coverAt, location }. `zh.video` is
 * an optional version made for Chinese audiences, which Xiaohongshu gets in place of `video`. The cover is either an
 * image (`cover`) or the frame at `coverAt` seconds, taken from each video so Xiaohongshu's shows its own frame. Paths
 * are relative to the spec. A draft publishes nothing by itself: only the owner's click in the composer queues it.
 */
export async function createDraft(specFile, { origin, token, fetcher = fetch, maxBytes = MAX_VIDEO_BYTES }) {
  const { video, zh, cover, coverAt, ...text } = JSON.parse(await readFile(specFile, "utf8"));
  const { video: zhVideo, ...zhText } = zh ?? {};
  // Everything is read before anything goes up, so a bad path for a later file can't strand the first.
  const source = await locate(specFile, video);
  const zhSource = zhVideo === undefined ? null : await locate(specFile, zhVideo);
  if (cover !== undefined && coverAt !== undefined) throw new Error('Give a "cover" image or a "coverAt" second, not both');
  const coverImage = cover === undefined ? null : await locateImage(specFile, cover);
  if (coverAt !== undefined && !(typeof coverAt === "number" && coverAt >= 0 && coverAt < source.duration))
    throw new Error(`"coverAt" is a second within the video, from 0 to ${source.duration.toFixed(1)}`);
  const call = async (path, init) => {
    const response = await fetcher(`${origin}/api/publisher/helper/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Publisher request failed (${response.status})`);
    return data;
  };
  const postJson = (path, data) =>
    call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

  // Bluesky stops at three minutes and the Short-form preset is built around that; longer films go to Long video.
  const draft = { preset: source.duration <= 180 ? "short" : "video", ...text, ...(zh ? { zh: zhText } : {}) };
  // Before the upload: a video this large shouldn't go up twice for a typo in the text.
  await postJson("drafts/check", draft);

  let reencoded = false;
  const upload = async ({ input, contentType, duration }) => {
    const { size } = await stat(input);
    const temp = size > maxBytes ? await mkdtemp(join(tmpdir(), "publisher-draft-")) : null;
    try {
      let file = input;
      if (temp) {
        file = join(temp, "video.mp4");
        await fit(input, file, duration, maxBytes);
        reencoded = true;
      }
      const { id } = await call("media", {
        method: "POST",
        headers: { "Content-Type": temp ? "video/mp4" : contentType },
        body: await readFile(file),
      });
      return id;
    } finally {
      if (temp) await rm(temp, { recursive: true, force: true });
    }
  };
  const uploadImage = async ({ input, contentType }) =>
    (await call("media", { method: "POST", headers: { "Content-Type": contentType }, body: await readFile(input) })).id;
  const media = await upload(source);
  const zhMedia = zhSource && (await upload(zhSource));
  let coverMedia = coverImage && (await uploadImage(coverImage));
  let zhCoverMedia = null;
  if (coverAt !== undefined) {
    const temp = await mkdtemp(join(tmpdir(), "publisher-cover-"));
    try {
      coverMedia = await uploadImage(await frameAt(source.input, coverAt, join(temp, "cover.jpg")));
      // The Chinese version may run a little longer or shorter: its frame is taken at the same second, within it.
      if (zhSource)
        zhCoverMedia = await uploadImage(
          await frameAt(zhSource.input, Math.min(coverAt, zhSource.duration - 0.1), join(temp, "zh-cover.jpg")),
        );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  const { id } = await postJson("drafts", {
    ...draft,
    video: media,
    ...(zhMedia ? { zh: { ...zhText, video: zhMedia, ...(zhCoverMedia ? { cover: zhCoverMedia } : {}) } } : {}),
    ...(coverMedia ? { cover: coverMedia } : {}),
  });
  const page = origin === "https://post.kualta.dev" ? "/" : "/publish";
  return { id, url: `${origin}${page}?draft=${id}`, reencoded };
}
