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
