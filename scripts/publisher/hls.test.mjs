import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import { linkPlaylist, makeHls, posterFrame } from "./hls.mjs";

const exec = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const usable = spawnSync(ffmpeg, ["-version"]).status === 0;
let dir;
let video;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "publisher-hls-"));
  video = join(dir, "video.mp4");
  if (!usable) return;
  process.env.FFMPEG_PATH = ffmpeg;
  await exec(ffmpeg, [
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x48:rate=10:duration=13",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=13",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "10",
    "-c:a",
    "aac",
    "-shortest",
    video,
  ]);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("playlists get full addresses, and tags pass through", () => {
  const linked = linkPlaylist("#EXTM3U\n#EXTINF:6,\n0000.ts\n#EXT-X-ENDLIST\n", { "0000.ts": "https://grove/a" });
  expect(linked).toBe("#EXTM3U\n#EXTINF:6,\nhttps://grove/a\n#EXT-X-ENDLIST\n");
});
test("a playlist naming a file that wasn't uploaded stops the post", () => {
  expect(() => linkPlaylist("#EXTM3U\n0000.ts\n", {})).toThrow("unknown file");
});
test.skipIf(!usable)("a video becomes segments with a master playlist naming its shape and codecs", async () => {
  const stream = await makeHls(video, join(dir, "hls"));
  expect(stream.segments.length).toBeGreaterThan(1);
  expect(stream.media).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
  expect(stream.media).toContain("#EXT-X-ENDLIST");
  for (const path of stream.segments) expect(stream.media).toContain(path.split("/").at(-1));
  expect(stream.master).toContain("RESOLUTION=64x48");
  expect(stream.master).toContain("BANDWIDTH=");
  expect(stream.master).toMatch(/CODECS="avc1\.[^"]+,mp4a\.[^"]+"/);
  expect(stream.master).toContain("media.m3u8");
  const urls = Object.fromEntries(stream.segments.map((path, i) => [path.split("/").at(-1), `https://grove/${i}`]));
  expect(linkPlaylist(stream.media, urls)).not.toContain(".ts");
});
test.skipIf(!usable)("a poster is one JPEG frame, even from a clip shorter than a second", async () => {
  const output = await posterFrame(video, join(dir, "poster.jpg"), 13);
  expect((await readFile(output)).subarray(0, 2).toString("hex")).toBe("ffd8");
  expect((await stat(output)).size).toBeGreaterThan(0);
  const short = await posterFrame(video, join(dir, "short.jpg"), 0.4);
  expect((await stat(short)).size).toBeGreaterThan(0);
});
