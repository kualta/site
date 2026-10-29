import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, writeFile } from "node:fs/promises";
const exec = promisify(execFile);
const cameraTags = [
  "Make",
  "Model",
  "LensMake",
  "LensModel",
  "FNumber",
  "ExposureTime",
  "ISO",
  "FocalLength",
  "FocalLengthIn35mmFormat",
];

export async function processMedia(input, output, { kind, policy, maxBytes = 900_000 }) {
  if (!["photo", "video"].includes(kind) || !["remove-location", "remove-all"].includes(policy))
    throw new Error("Invalid media policy");
  if (kind === "photo") {
    let image = sharp(input, { limitInputPixels: 80_000_000, animated: false })
      .rotate()
      .resize({ width: 4000, height: 4000, fit: "inside", withoutEnlargement: true });
    // Start with clean pixels. Never copy GPS, XMP, IPTC, serial numbers, previews,
    // maker notes, comments, or arbitrary original EXIF into destination files.
    const { stdout } = await exec("exiftool", ["-json", ...cameraTags.map((tag) => `-${tag}`), input]);
    const metadata = JSON.parse(stdout)[0];
    const safe = Object.fromEntries(
      cameraTags.filter((tag) => metadata[tag] !== undefined).map((tag) => [tag, String(metadata[tag])]),
    );
    let quality = 92;
    let dimension = 4000;
    let result;
    while (true) {
      result = await image
        .clone()
        .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (result.length <= maxBytes - 4096) break;
      if (quality > 50) quality -= 8;
      else {
        dimension = Math.floor(dimension * 0.8);
        quality = 84;
      }
      if (dimension < 320) throw new Error("Image cannot fit the destination size limit");
    }
    await writeFile(output, result);
    if (policy === "remove-location" && Object.keys(safe).length) {
      await exec("exiftool", [
        "-overwrite_original",
        ...Object.entries(safe).map(([key, value]) => `-${key}=${value}`),
        output,
      ]);
    }
    if ((await stat(output)).size > maxBytes)
      throw new Error("Image exceeds destination size limit after metadata processing");
    const info = await sharp(output).metadata();
    return {
      kind,
      width: info.width,
      height: info.height,
      bytes: (await stat(output)).size,
      contentType: "image/jpeg",
    };
  }
  // Decode/re-encode rather than copying potentially metadata-bearing streams.
  // Keep only video/audio; drop subtitles, data tracks, chapters and source tags.
  await exec(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-bsf:v",
      "filter_units=remove_types=6",
      "-movflags",
      "+faststart",
      output,
    ],
    { timeout: 15 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 },
  );
  await exec("exiftool", ["-overwrite_original", "-all=", output]);
  const { stdout } = await exec(process.env.FFPROBE_PATH || "ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    output,
  ]);
  const probe = JSON.parse(stdout);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("No video stream");
  return {
    kind,
    width: video.width,
    height: video.height,
    duration: Number(probe.format.duration),
    bytes: (await stat(output)).size,
    contentType: "video/mp4",
  };
}
