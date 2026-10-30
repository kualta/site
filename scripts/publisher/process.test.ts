import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { processMedia } from "./process.mjs";
// Native tooling is a laptop setup requirement, not a Worker dependency.
const native = Bun.which("exiftool");
test.skipIf(!native)("fresh images remove GPS and comments while retaining only allowed camera tags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "publisher-test-"));
  try {
    const input = join(dir, "input.jpg");
    await sharp({ create: { width: 40, height: 20, channels: 3, background: "red" } })
      .jpeg()
      .toFile(input);
    execFileSync("exiftool", [
      "-overwrite_original",
      "-GPSLatitude=12.3",
      "-GPSLongitude=45.6",
      "-Make=Test Camera",
      "-Comment=private",
      input,
    ]);
    for (const policy of ["remove-location", "remove-all"]) {
      const output = join(dir, `${policy}.jpg`);
      const info = await processMedia(input, output, { kind: "photo", policy });
      const tags = JSON.parse(execFileSync("exiftool", ["-json", output], { encoding: "utf8" }))[0];
      expect(tags.GPSLatitude).toBeUndefined();
      expect(tags.GPSLongitude).toBeUndefined();
      expect(tags.Comment).toBeUndefined();
      expect(tags.Make).toBe(policy === "remove-location" ? "Test Camera" : undefined);
      expect(info.bytes).toBeLessThan(900_000);
      expect(info.width).toBe(40);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.skipIf(!native)(
  "video re-encoding strips source tags, GPS and comments",
  async () => {
    const { default: ffmpeg } = await import("ffmpeg-static");
    const { default: ffprobe } = await import("ffprobe-static");
    process.env.FFMPEG_PATH = Bun.which("ffmpeg") || ffmpeg!;
    process.env.FFPROBE_PATH = Bun.which("ffprobe") || ffprobe.path;
    const dir = await mkdtemp(join(tmpdir(), "publisher-video-test-"));
    try {
      const input = join(dir, "input.mp4"),
        output = join(dir, "output.mp4");
      execFileSync(
        process.env.FFMPEG_PATH!,
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:s=64x48:d=0.2",
          "-c:v",
          "libx264",
          "-metadata",
          "comment=private",
          "-metadata",
          "location=+12.3000+045.6000/",
          input,
        ],
        { stdio: "ignore" },
      );
      const info = await processMedia(input, output, { kind: "video", policy: "remove-all" });
      const tags = JSON.parse(execFileSync("exiftool", ["-json", output], { encoding: "utf8" }))[0];
      expect(tags.GPSCoordinates).toBeUndefined();
      expect(tags.Comment).toBeUndefined();
      expect(info.width).toBe(64);
      expect(info.duration).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!native)(
  "vertical output is 1080x1920 with the whole picture over a blurred copy, and keeps the metadata stripping",
  async () => {
    const { default: ffmpeg } = await import("ffmpeg-static");
    const { default: ffprobe } = await import("ffprobe-static");
    process.env.FFMPEG_PATH = Bun.which("ffmpeg") || ffmpeg!;
    process.env.FFPROBE_PATH = Bun.which("ffprobe") || ffprobe.path;
    const dir = await mkdtemp(join(tmpdir(), "publisher-vertical-test-"));
    try {
      const input = join(dir, "input.mp4"),
        output = join(dir, "output.mp4"),
        frame = join(dir, "frame.png");
      // Red beside blue, stored anamorphically: 240x180 pixels that display at 16:9, so the picture is 1080x608.
      execFileSync(
        process.env.FFMPEG_PATH!,
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=red:s=120x180:d=0.2[left];color=c=blue:s=120x180:d=0.2[right];[left][right]hstack,setsar=4/3",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=48000:cl=mono",
          "-shortest",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-metadata",
          "comment=private",
          "-metadata",
          "location=+12.3000+045.6000/",
          input,
        ],
        { stdio: "ignore" },
      );
      const info = await processMedia(input, output, { kind: "video", policy: "remove-all", vertical: true });
      expect(info.width).toBe(1080);
      expect(info.height).toBe(1920);
      expect(info.duration).toBeGreaterThan(0);
      const tags = JSON.parse(execFileSync("exiftool", ["-json", output], { encoding: "utf8" }))[0];
      expect(tags.GPSCoordinates).toBeUndefined();
      expect(tags.Comment).toBeUndefined();
      const { streams } = JSON.parse(
        execFileSync(process.env.FFPROBE_PATH!, ["-v", "error", "-show_streams", "-of", "json", output], {
          encoding: "utf8",
        }),
      );
      const encoded = streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
      expect(encoded.codec_name).toBe("h264");
      expect(encoded.pix_fmt).toBe("yuv420p");
      expect(encoded.display_aspect_ratio).toBe("9:16");
      expect(streams.some((stream: { codec_type: string }) => stream.codec_type === "audio")).toBe(true);
      execFileSync(process.env.FFMPEG_PATH!, ["-y", "-i", output, "-frames:v", "1", frame], { stdio: "ignore" });
      const { data, info: image } = await sharp(frame).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const blue = (x: number, y: number) => data[(y * image.width + x) * image.channels + 2];
      // Both edges of the picture survive: nothing is cropped.
      expect(blue(4, 960)).toBeLessThan(40);
      expect(blue(1075, 960)).toBeGreaterThan(200);
      // Just inside the picture it stays sharp; just above it, the same column blurs red into blue.
      expect(blue(520, 670)).toBeLessThan(40);
      expect(blue(520, 640)).toBeGreaterThan(40);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
