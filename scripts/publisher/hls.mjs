import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const ffmpeg = () => process.env.FFMPEG_PATH || "ffmpeg";

/** Cuts a prepared video into an HLS stream without re-encoding it: the Farcaster app plays only HLS in a cast. */
export async function makeHls(input, directory, { signal } = {}) {
  await mkdir(directory, { recursive: true });
  await exec(
    ffmpeg(),
    [
      "-nostdin",
      "-y",
      "-i",
      input,
      "-map",
      "0",
      "-map_metadata",
      "-1",
      "-c",
      "copy",
      // Without this ffmpeg can't read the codec from an MP4's H.264 header, and the master playlist omits CODECS.
      "-bsf:v",
      "h264_mp4toannexb",
      "-f",
      "hls",
      "-hls_time",
      "6",
      "-hls_playlist_type",
      "vod",
      "-hls_segment_filename",
      join(directory, "%04d.ts"),
      "-master_pl_name",
      "master.m3u8",
      join(directory, "media.m3u8"),
    ],
    { timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024, signal },
  );
  const segments = (await readdir(directory)).filter((name) => name.endsWith(".ts")).sort();
  return {
    segments: segments.map((name) => join(directory, name)),
    media: await readFile(join(directory, "media.m3u8"), "utf8"),
    master: await readFile(join(directory, "master.m3u8"), "utf8"),
  };
}
/** Playlists name their files relative to themselves; Grove serves each file at its own key, so they need full URLs. */
export function linkPlaylist(playlist, urls) {
  return playlist
    .split("\n")
    .map((line) => {
      if (!line || line.startsWith("#")) return line;
      if (!urls[line]) throw new Error(`Playlist names an unknown file: ${line}`);
      return urls[line];
    })
    .join("\n");
}
/** A frame to show before a video plays, from just inside it: films often open on black. */
export async function posterFrame(input, output, duration, { signal } = {}) {
  await exec(
    ffmpeg(),
    [
      "-nostdin",
      "-y",
      "-ss",
      String(Math.min(1, (duration || 0) / 2)),
      "-i",
      input,
      "-frames:v",
      "1",
      "-map_metadata",
      "-1",
      "-q:v",
      "3",
      output,
    ],
    { timeout: 60_000, maxBuffer: 2 * 1024 * 1024, signal },
  );
  return output;
}
